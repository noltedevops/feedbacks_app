import { useEffect, useId, useLayoutEffect, useRef, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Sparkles, X } from 'lucide-react';
import type { Translator } from '../i18n';
import { useModal } from '../useModal';

/**
 * The assistant's conversation, in a dialog laid out after mongodb.com's: a centred
 * panel that grows with the conversation up to 72% of the viewport, a centred title
 * with the close button beside it, the exchanges stacked in order - each question as
 * a bubble on the right, its answer below it - and the input with its note at the
 * bottom.
 *
 * The history is visual only. Every question still goes to the server on its own,
 * with no earlier turns; what is kept and asked lives in AskAssistant, so it survives
 * closing and reopening the dialog.
 *
 * The dialog is the app's: .permission-overlay / .permission-dialog for the scrim,
 * the raised surface and their motion, useModal for Escape, the scrim, Tab and focus
 * going back to whatever opened it. It renders into <body>, as the Dashboard's
 * expanded panels do.
 */

export type AssistantReply =
  | { kind: 'loading' }
  | { kind: 'answer'; text: string }
  | { kind: 'starter'; index: number }
  | { kind: 'fallback'; limited: boolean };

export type Exchange = {
  id: number;
  /** The visitor's own words; a starter's is translated at render, from `reply.index`. */
  question: string;
  reply: AssistantReply;
};

export function AssistantDialog({
  t, starters, exchanges, draft, busy, maxChars, noteText, opener,
  onDraftChange, onAsk, onStarter, onClose,
}: {
  t: Translator;
  starters: [question: string, answer: string][];
  exchanges: Exchange[];
  draft: string;
  busy: boolean;
  maxChars: number;
  noteText: string;
  opener: HTMLElement | null;
  onDraftChange: (value: string) => void;
  onAsk: () => void;
  onStarter: (index: number) => void;
  onClose: () => void;
}) {
  const [dialogRef, onBackdropMouseDown] = useModal<HTMLDivElement>(onClose, opener);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const noteId = useId();

  // A form to fill: focus starts in the question field.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // On a phone the page itself scrolls; hold it still behind the dialog.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => { root.style.overflow = previous; };
  }, []);

  // Keep the newest exchange in view. A new question scrolls to the bottom; when its
  // answer arrives, the view moves only as far as needed to show the answer's start,
  // so a long answer is read from its first line rather than from its last.
  const last = exchanges[exchanges.length - 1];
  const lastKey = last ? `${last.id}:${last.reply.kind}` : '';
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const bottom = log.scrollHeight - log.clientHeight;
    const lastEl = log.querySelector<HTMLElement>('[data-exchange]:last-of-type');
    if (!last || last.reply.kind === 'loading' || !lastEl) {
      log.scrollTop = bottom;
      return;
    }
    const top = lastEl.offsetTop - log.offsetTop - parseFloat(getComputedStyle(log).paddingTop);
    log.scrollTop = Math.min(bottom, Math.max(0, top));
  }, [lastKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAsk();
    inputRef.current?.focus();
  };

  return createPortal(
    <div className="permission-overlay assist-overlay" onMouseDown={onBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="permission-dialog assist-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="assist-head">
          <h2 id={titleId} className="assist-title">
            <Sparkles size={16} className="ask-icon" aria-hidden="true" />
            {t('AI assistant')}
          </h2>
          <button type="button" className="assist-close" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div ref={logRef} className="assist-log" role="log" aria-label={t('Conversation')}>
          <div className="assist-msg">
            <p className="assist-who">
              <Sparkles size={16} className="ask-icon" aria-hidden="true" />
              {t('Assistant')}
            </p>
            <p className="ask-a">{t('Hello! I answer questions about the NOLTE Geoservices platform - the Field App, the Dashboard, reports and access. Pick a common question or ask your own.')}</p>
            <div className="ask-starters assist-starters" role="group" aria-label={t('Common questions')}>
              {starters.map(([q], i) => (
                <button key={q} type="button" className="ask-chip" onClick={() => onStarter(i)}>
                  {t(q)}
                </button>
              ))}
            </div>
          </div>

          {exchanges.map(ex => (
            <div key={ex.id} className="assist-exchange" data-exchange>
              <p className="assist-user">
                <span className="assist-sr">{t('You asked')}: </span>
                {ex.reply.kind === 'starter' ? t(starters[ex.reply.index][0]) : ex.question}
              </p>
              <Reply t={t} starters={starters} reply={ex.reply} />
            </div>
          ))}
        </div>

        <div className="assist-foot">
          <form className="ask-box assist-box" onSubmit={submit}>
            <input
              ref={inputRef}
              className="ask-input"
              type="text"
              value={draft}
              onChange={e => onDraftChange(e.target.value)}
              maxLength={maxChars}
              placeholder={t('Ask the AI assistant')}
              aria-label={t('Ask the AI assistant')}
              aria-describedby={noteId}
              autoComplete="off"
              enterKeyHint="send"
            />
            <button
              type="submit"
              className="ask-send"
              disabled={!draft.trim() || busy}
              aria-label={t('Send question')}
              title={t('Send question')}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          </form>
          <p className="ask-note" id={noteId}>{noteText}</p>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Reply({ t, starters, reply }: { t: Translator; starters: [string, string][]; reply: AssistantReply }) {
  if (reply.kind === 'loading') {
    return (
      <div className="assist-msg">
        <p className="assist-who"><Sparkles size={16} className="ask-icon" aria-hidden="true" />{t('Assistant')}</p>
        <p className="ask-status">{t('Thinking…')}</p>
      </div>
    );
  }
  if (reply.kind === 'fallback') {
    return (
      <div className="assist-msg assist-msg--fallback">
        <p className="assist-who"><Sparkles size={16} className="ask-icon" aria-hidden="true" />{t('Assistant')}</p>
        <p className="ask-a">
          {reply.limited ? t('The assistant has reached its limit for now.') : t("The assistant can't answer right now.")}{' '}
          {t('Choose one of the common questions above, or try again later.')}
        </p>
      </div>
    );
  }
  return (
    <div className="assist-msg">
      <p className="assist-who"><Sparkles size={16} className="ask-icon" aria-hidden="true" />{t('Assistant')}</p>
      <p className="ask-a">{reply.kind === 'starter' ? t(starters[reply.index][1]) : reply.text}</p>
      {reply.kind === 'answer' && <p className="ask-source">{t('AI-generated answer - please check it.')}</p>}
    </div>
  );
}
