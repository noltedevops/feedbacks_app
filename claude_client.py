"""Claude (Anthropic) client for this app, pinned to Claude Fable 5.1.

Everything that is specific to Fable 5.1 rather than to the Anthropic API in
general is concentrated here, so callers only ever deal with strings in and
strings out. The things that make this model different from the Opus-tier
models most examples are written against:

  * Thinking is always on and is not configurable. Sending a `thinking`
    parameter of any kind other than {"type": "adaptive"} is a 400, and the
    older `budget_tokens` form is rejected outright. We therefore omit it.
  * `temperature`, `top_p` and `top_k` were removed. Depth is controlled with
    output_config.effort instead - see EFFORT below.
  * Assistant prefill (ending `messages` on an assistant turn) is a 400.
  * Safety classifiers can decline a request. That arrives as a *successful*
    HTTP 200 with stop_reason == "refusal" and a possibly-empty content list,
    not as an exception, so any code that reads content[0] without checking
    breaks on it. _text_of raises ClaudeRefusal instead.
  * The model requires 30-day data retention. An organisation configured for
    zero retention gets a 400 on every request with nothing wrong in the body.
"""

from typing import Iterator, Optional

import anthropic

from config import settings

# Authoritative model ID. Not date-suffixed - "claude-fable-5-1" is complete.
MODEL = "claude-fable-5-1"

# Server-side fallback. When a safety classifier declines a request, the API
# re-runs it on Anthropic's recommended substitute (routed by refusal category)
# inside the same call rather than handing us the refusal. "default" is
# preferred over naming a model ourselves: the right substitute depends on why
# the request was declined, and a pinned model is a migration we would owe
# later. This is opt-in - without it a declined request simply stops.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# low | medium | high | xhigh | max. This is the intelligence/latency/cost dial
# now that temperature is gone. "high" is the sensible default; lower levels
# still perform well on this model and are the right answer for routine work,
# and "xhigh"/"max" are for genuinely capability-sensitive tasks. Note it goes
# inside output_config, not at the top level.
EFFORT = "high"

# Non-streaming responses have to come back inside the HTTP timeout, so they get
# a smaller ceiling than streamed ones. Hitting the cap truncates mid-sentence
# and costs a whole retry, so neither is set tight.
MAX_TOKENS_BLOCKING = 16000
MAX_TOKENS_STREAMING = 64000


class ClaudeRefusal(Exception):
    """Raised when the model or its safety classifiers declined the request.

    `category` is informational and may be None even on a genuine refusal, so
    branch on the exception itself rather than on the category.
    """

    def __init__(self, category: Optional[str], explanation: Optional[str]):
        self.category = category
        self.explanation = explanation
        super().__init__(explanation or f"Claude declined the request ({category or 'no category'})")


_client: Optional[anthropic.Anthropic] = None


def get_client() -> anthropic.Anthropic:
    """The shared client, built on first use.

    Built lazily so importing this module never fails on a machine without
    credentials - only the calls that actually need Claude do. An explicit
    anthropic_api_key in settings wins; with it unset the SDK resolves the
    environment itself (ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an
    `ant auth login` profile on disk), so leaving it blank is the normal case.
    """
    global _client
    if _client is None:
        key = settings.anthropic_api_key
        _client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
    return _client


def _text_of(response) -> str:
    """Join the text blocks of a response, refusing to treat a refusal as output.

    A response carries a list of typed blocks, not a string: thinking blocks sit
    alongside text ones and have no .text, hence the type check rather than a
    blind content[0].text.
    """
    if response.stop_reason == "refusal":
        details = response.stop_details
        raise ClaudeRefusal(
            getattr(details, "category", None),
            getattr(details, "explanation", None),
        )
    return "".join(block.text for block in response.content if block.type == "text")


def ask(
    prompt: str,
    *,
    system: Optional[str] = None,
    effort: str = EFFORT,
    max_tokens: int = MAX_TOKENS_BLOCKING,
) -> str:
    """One question, one answer, blocking until the whole reply is ready.

    Fable 5.1 thinks before it answers and hard tasks at higher effort can run
    for minutes, so this is for short work on a request the caller is willing to
    wait on. Anything user-facing or long should use stream_text.
    """
    response = get_client().beta.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        output_config={"effort": effort},
        system=system or anthropic.NOT_GIVEN,
        messages=[{"role": "user", "content": prompt}],
    )
    return _text_of(response)


def stream_text(
    prompt: str,
    *,
    system: Optional[str] = None,
    effort: str = EFFORT,
    max_tokens: int = MAX_TOKENS_STREAMING,
) -> Iterator[str]:
    """Yield the answer in fragments as it is generated.

    Use this for anything long or user-facing. Streaming is not just a UX
    choice here: it is what keeps a long turn from tripping the HTTP timeout,
    which is why max_tokens is allowed to be four times the blocking ceiling.

    The refusal check has to happen after the stream drains, because a
    classifier can fire mid-output - already-streamed fragments are billed but
    are not a complete answer, so a caller that has been appending them should
    discard what it collected when this raises.
    """
    with get_client().beta.messages.stream(
        model=MODEL,
        max_tokens=max_tokens,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        output_config={"effort": effort},
        system=system or anthropic.NOT_GIVEN,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        for fragment in stream.text_stream:
            yield fragment
        _text_of(stream.get_final_message())
