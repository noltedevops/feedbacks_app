"""The landing page's "Ask AI Assistant": one question in, one short answer out.

The endpoint is public - the landing page is what a visitor sees before signing
in - so it is fenced in on every side: a per-IP limit and a daily ceiling across
all visitors, a length cap on the question and on the reply, no conversation
history, and a system prompt that knows only what this platform does.

It never fails in front of a visitor. Every problem - no key configured, a limit
reached, Mistral down, slow or replying in a shape we do not expect - comes back
as an ordinary 200 with status "limited" or "unavailable", and the page falls
back to its predefined answers.

Provider: Mistral's EU-hosted API on pay-as-you-go, with training switched off in
the organisation's admin panel. The key is read from MISTRAL_API_KEY in the
process environment and nowhere else - deliberately not through config.py, which
also reads .env - and passed explicitly on every request. Called over plain HTTPS
with the standard library: it is one POST, and not worth a dependency.

Question text is never logged: a visitor may type anything, personal data
included, and it has no business in our logs.
"""

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Literal, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

log = logging.getLogger("assistant")

MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions"

# Ministral 3 8B. A fixed-scope FAQ over a short prompt needs no reasoning model.
# Pinned to the dated ID rather than a -latest alias, so the model cannot change
# under us; when Mistral retires it, calls fail, the page falls back to its
# predefined answers, and this line is the fix.
MODEL = "ministral-8b-2512"

MAX_QUESTION_CHARS = 500
MAX_REPLY_TOKENS = 400
TIMEOUT_S = 20

PER_IP_LIMIT = 10          # questions per visitor...
PER_IP_WINDOW_S = 600      # ...per 10 minutes
DAILY_LIMIT = 300          # across all visitors: the ceiling on spend

SYSTEM_PROMPT = """You are the assistant on the public website of the NOLTE Geoservices platform, a web application by Nolte Geoservices GmbH for UXO (unexploded ordnance, German: Kampfmittel) clearance work. You answer visitors' questions about what the platform does and how it is used - nothing else.

What the platform does:
- Office staff load the anomaly targets from a geophysical survey (magnetometer and ground-penetrating radar, "georadar") into it, per project.
- The Field App is used by the crews on a tablet or phone. They browse and filter the list of targets (by project, survey category, instrument, VM number and status) and see every target on a map. Opening a target shows its evaluated depth and instrument, and the distance and bearing from where the user stands. For each target they log the excavation: what was found (the "Fundstueck"), the depth actually dug, the size of the opening (length, width, volume), the Sohle status (whether the bottom of the excavation is clear), photos and notes.
- The Field App works offline: targets are kept on the device and logs are queued, then synchronised with the office when the connection returns. It can be installed on the device like an app.
- The Dashboard is for project leads and decision makers: totals and progress (targets investigated against pending, excavated volume), findings by type, Sohle status by finding, sensor accuracy (evaluated against excavated depth, mean error, estimation bias, share of empty holes) and target dimensions. It filters by project, instrument and category.
- Reports: the log of excavation results can be exported as PDF or CSV for any date range.
- Access: visitors request an account on this website. New accounts start with the Field App; access to the Dashboard is granted by an administrator.

Rules:
- Answer only questions about this platform and how it is used. For anything else, say in one sentence that you can only help with questions about the platform.
- Use only the facts above. If they do not answer the question, say you do not know and suggest contacting Nolte Geoservices at https://www.nolteservices.com. Never invent features, prices, customers, projects or data.
- You have no access to any project, target, account or result, and cannot sign anyone in or grant access.
- Never give advice on handling, identifying or approaching ordnance; refer to qualified clearance professionals.
- Keep answers short: at most about 120 words, in plain text, without Markdown or headings."""

# The page's language, which is the visitor's choice; the question's own language
# is too short to be a reliable signal.
LANGUAGE_RULE = {
    "EN": "\n- Always answer in English.",
    "DE": "\n- Always answer in German (Deutsch).",
}


class AssistantQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    lang: Literal["EN", "DE"] = "EN"


class AssistantReply(BaseModel):
    # ok: `answer` holds the reply. limited: this visitor or the day is over its
    # limit. unavailable: anything else. The page shows its predefined answers for
    # both of the latter.
    status: Literal["ok", "limited", "unavailable"]
    answer: Optional[str] = None


class _Limiter:
    """A sliding window per IP, and a counter for the whole day (UTC).

    In memory: it resets on restart and is per process, which is fine for one
    uvicorn worker and a ceiling that exists to cap spend, not to meter it.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_ip: dict[str, deque] = {}
        self._day = ""
        self._day_count = 0

    def allow(self, ip: str, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            day = time.strftime("%Y-%m-%d", time.gmtime(now))
            if day != self._day:
                self._day, self._day_count = day, 0
            if self._day_count >= DAILY_LIMIT:
                return False
            recent = self._by_ip.setdefault(ip, deque())
            while recent and now - recent[0] >= PER_IP_WINDOW_S:
                recent.popleft()
            if len(recent) >= PER_IP_LIMIT:
                return False
            recent.append(now)
            self._day_count += 1
            # Forget visitors whose window has passed, so the table cannot grow
            # without bound.
            if len(self._by_ip) > 5000:
                self._by_ip = {k: q for k, q in self._by_ip.items() if q and now - q[-1] < PER_IP_WINDOW_S}
            return True


_limiter = _Limiter()


def _ask_mistral(key: str, question: str, lang: str) -> Optional[str]:
    """The reply text, or None for any failure. Never raises."""
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT + LANGUAGE_RULE[lang]},
            {"role": "user", "content": question},
        ],
        "max_tokens": MAX_REPLY_TOKENS,
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(
        MISTRAL_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        # 401 a bad key, 422 a request Mistral rejects, 429 its own rate limit, 5xx
        # its side. The visitor gets the predefined answers either way; the code is
        # for whoever reads the log.
        log.warning("Mistral returned HTTP %s", e.code)
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        log.warning("Mistral unreachable or replied with something other than JSON: %s", type(e).__name__)
        return None

    try:
        choice = data["choices"][0]
        content = choice["message"]["content"]
    except (KeyError, IndexError, TypeError):
        log.warning("Mistral reply had no message content")
        return None
    # Content can also arrive as a list of typed chunks; keep the text ones.
    if isinstance(content, list):
        content = "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    if not isinstance(content, str) or not content.strip():
        return None
    answer = content.strip()
    # Cut off at the reply cap: say so rather than end mid-sentence without a mark.
    if choice.get("finish_reason") == "length":
        answer += " …"
    return answer


router = APIRouter()


@router.post("/api/assistant", response_model=AssistantReply)
def ask_assistant(payload: AssistantQuestion, request: Request) -> AssistantReply:
    # A plain def, so FastAPI runs it in its threadpool and the blocking call to
    # Mistral does not hold up the event loop.
    key = os.environ.get("MISTRAL_API_KEY", "").strip()
    question = payload.question.strip()
    if not key or not question:
        return AssistantReply(status="unavailable")
    # The direct peer. Behind a reverse proxy that is the proxy for everyone, and
    # the per-IP limit becomes a shared one - still capped by DAILY_LIMIT.
    ip = request.client.host if request.client else "unknown"
    if not _limiter.allow(ip):
        return AssistantReply(status="limited")
    answer = _ask_mistral(key, question, payload.lang)
    if answer is None:
        return AssistantReply(status="unavailable")
    return AssistantReply(status="ok", answer=answer)
