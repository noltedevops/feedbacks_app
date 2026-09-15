import { useEffect, useId, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import type { Translator } from '../i18n';
import { useModal } from '../useModal';

/**
 * Expand a Dashboard panel into a large overlay, as Esri dashboards do.
 *
 * The overlay is the app's dialog - the sign-in dialog's scrim and raised surface
 * (.permission-overlay / .permission-dialog), its surface-in and fade-in motion, and
 * its behaviour through useModal - made large. It renders into <body>: the panels sit
 * in a layer that ignores the pointer and stacks just above the map, and a dialog left
 * inside it would be trapped in that layer.
 *
 * What it shows is the caller's: a second copy of the panel's chart, drawn at the
 * overlay's size (DashboardCharts, size="expanded"), not the small one scaled up.
 */

/** The small button in a panel's top corner that opens its expanded view. */
export function ExpandButton({ label, onClick }: {
  label: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="panel-expand-btn"
      onClick={onClick}
      aria-label={label}
      aria-haspopup="dialog"
      title={label}
    >
      <Maximize2 size={16} aria-hidden="true" />
    </button>
  );
}

export function ExpandedPanel({ t, kicker, title, opener, onClose, children }: {
  t: Translator;
  kicker: string;
  title: string;
  opener: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const [dialogRef, onBackdropMouseDown] = useModal<HTMLDivElement>(onClose, opener);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // A view to read, not a form to fill: focus starts on the way back out.
  useLayoutEffect(() => {
    closeRef.current?.focus();
  }, []);

  // On a phone the page itself scrolls; hold it still behind the overlay.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => { root.style.overflow = previous; };
  }, []);

  return createPortal(
    <div className="permission-overlay panel-expand-overlay" onMouseDown={onBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="permission-dialog panel-expand"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="panel-expand-head">
          <div className="dash-panel-head">
            <span className="dash-kicker">{kicker}</span>
            <h2 id={titleId} className="panel-expand-title">{title}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="panel-expand-close"
            onClick={onClose}
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="panel-expand-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
