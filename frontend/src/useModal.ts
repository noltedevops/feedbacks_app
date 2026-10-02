import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';

/**
 * The app's modal behaviour, one implementation for every modal dialog (the sign-in
 * dialog, the Dashboard's expanded panels):
 *
 * - focus goes back to whatever opened the dialog when it closes;
 * - with one dialog open over another (the 3D pit view over the expanded target log),
 *   only the top one answers the keyboard, so Escape closes one layer at a time;
 * - Escape closes it, unless something inside already handled that Escape (an open
 *   dropdown closes itself first);
 * - Tab and Shift+Tab stay inside it;
 * - a press that starts on the scrim closes it - one that starts inside and is
 *   released outside (selecting text) does not.
 *
 * Where focus goes on opening is the caller's: a form wants its first field, a
 * read-only view its close button.
 *
 * Returns [ref for the dialog element, onMouseDown for the scrim].
 */

// Open dialogs, innermost last. Only the last one handles keys.
const openStack: object[] = [];

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function useModal<T extends HTMLElement = HTMLDivElement>(onClose: () => void, returnFocusTo?: HTMLElement | null) {
  const dialogRef = useRef<T>(null);

  // Read at the first render: by the time an effect runs, focus has already moved in.
  // A caller that knows its opener passes it - Safari does not focus a clicked button.
  const openerRef = useRef<HTMLElement | null>(returnFocusTo ?? (document.activeElement as HTMLElement | null));
  useEffect(() => {
    const opener = openerRef.current;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  // Pushed once per dialog, at mount, so the stack follows the order they opened in.
  const tokenRef = useRef<object>({});
  useEffect(() => {
    const token = tokenRef.current;
    openStack.push(token);
    return () => { openStack.splice(openStack.indexOf(token), 1); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || openStack[openStack.length - 1] !== tokenRef.current) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dialogRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onBackdropMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    // The press's own default would move focus to the page a moment after the dialog
    // has put it back on its opener.
    e.preventDefault();
    onClose();
  }, [onClose]);

  return [dialogRef, onBackdropMouseDown] as const;
}
