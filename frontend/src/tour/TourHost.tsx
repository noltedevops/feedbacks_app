import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import { useIsMobile } from '../useIsMobile';
import { TOURS, TOUR_NAME, type TourId } from './steps';
import './tour.css';

/**
 * Draws a guided tour over the live app: a spotlight on the element a step names, and
 * a callout beside it (a bottom sheet on a phone).
 *
 * It only ever *reads* the page. It never selects a target, sets a filter or opens a
 * dialog - a "try it" step waits for the user to do that, and notices when the result
 * appears. So the surfaces carry nothing for it but inert `data-tour` labels, and the
 * tour cannot leave the app in a state the user did not put it in.
 *
 * The spotlight follows its element every frame rather than on a list of events: the
 * map pans, lists scroll inside their own scrollers, panels resize and the mobile
 * filter bar unfolds, and chasing each of those separately is how a highlight ends up
 * pointing at where something used to be. It runs only while a tour is open.
 */

interface Box { top: number; left: number; width: number; height: number }

const PAD = 6;            // spotlight breathing room around the element
const GAP = 14;           // between the spotlight and the callout
const EDGE = 12;          // the callout's minimum distance from the viewport edge
// How long a step waits for its element before it is passed over. The first step gets
// longer because the surface it tours is mounting in the same moment the tour starts.
const FIRST_GRACE = 900;
const GRACE = 250;
const SHEET_TOP = 8;      // the phone sheet's top edge when docked at the top (tour.css)

function findOnScreen(labels: string[]): HTMLElement | null {
  for (const label of labels) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${label}"]`)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5
    && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/**
 * Where the callout goes on a wide screen. Beside a narrow element, below or above a
 * wide one - and inside the corner of one too big to sit beside at all, which is the
 * map and a full-height list.
 */
function placeCallout(r: Box, w: number, h: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - w - EDGE);
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), vh - h - EDGE);

  const right = { fits: r.left + r.width + GAP + w <= vw - EDGE, top: clampY(r.top), left: r.left + r.width + GAP };
  const left = { fits: r.left - GAP - w >= EDGE, top: clampY(r.top), left: r.left - GAP - w };
  const below = { fits: r.top + r.height + GAP + h <= vh - EDGE, top: r.top + r.height + GAP, left: clampX(r.left) };
  const above = { fits: r.top - GAP - h >= EDGE, top: r.top - GAP - h, left: clampX(r.left) };

  const order = r.width > vw * 0.5 ? [below, above, right, left] : [right, left, below, above];
  const hit = order.find(o => o.fits);
  if (hit) return { top: hit.top, left: hit.left };
  return { top: clampY(r.top + r.height - h - 16), left: clampX(r.left + r.width - w - 16) };
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

interface TourHostProps {
  tour: TourId;
  lang: AppLang;
  /** False once the toured surface is off screen - the tour ends with it. */
  onScreen: boolean;
  onClose: () => void;
}

export function TourHost({ tour, lang, onScreen, onClose }: TourHostProps) {
  const t = makeT(lang);
  const isMobile = useIsMobile();
  const steps = TOURS[tour];

  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [sheetAtTop, setSheetAtTop] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // The tracking loop reads these every frame, so they live outside render state: the
  // sheet's docking mirrored from state, and its distance off the bottom edge.
  const sheetAtTopRef = useRef(false);
  const dockGapRef = useRef<number | null>(null);
  const dirRef = useRef<1 | -1>(1);
  const everFoundRef = useRef(false);
  const focusedStepRef = useRef(-1);

  // The parent passes a fresh arrow every render, and App re-renders on every sync
  // tick. Held in a ref so that cannot restart the tracking loop below.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const move = useCallback((dir: 1 | -1) => {
    dirRef.current = dir;
    const next = index + dir;
    if (next >= steps.length) {
      onCloseRef.current();
    } else if (next < 0) {
      // Backed past the first step because it had nothing to show: go forward again
      // from here instead, which lands on the first step that does.
      dirRef.current = 1;
      setIndex(0);
    } else {
      setIndex(next);
    }
  }, [index, steps.length]);

  // The tour ends when its surface goes - the user switched surface from the rail on a
  // "try it" step, lost the permission, or signed out.
  useEffect(() => {
    if (!onScreen) onCloseRef.current();
  }, [onScreen]);

  // Hand focus back to wherever it was when the tour closes, if that is still there.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => { if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);

  // Track the step's element, every frame.
  useEffect(() => {
    const step = steps[index];
    let raf = 0;
    let first = true;
    let found = false;
    let current: HTMLElement | null = null;
    let missingSince = performance.now();

    const tick = () => {
      // A "try it" step is done the moment its outcome is on screen. Entered with the
      // outcome already there - Back from the form it opens - it has nothing to try,
      // so it is passed over in whichever direction the tour is going.
      if (step.advanceOn && findOnScreen([step.advanceOn])) {
        move(first ? dirRef.current : 1);
        return;
      }
      first = false;

      const el = findOnScreen(step.anchors);
      const now = performance.now();

      if (!el) {
        setSpot(null);
        if (now - missingSince > (everFoundRef.current ? GRACE : FIRST_GRACE)) {
          if (import.meta.env.DEV && !found) {
            console.warn(`[tour] ${tour} step ${index + 1}: nothing labelled ${step.anchors.map(a => `"${a}"`).join(' or ')} is on screen - skipped.`);
          }
          // Gone mid-step (the user closed the report dialog on the last step, say)
          // reads as done with it; never there at all is skipped the way we came.
          move(found ? 1 : dirRef.current);
          return;
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      missingSince = now;
      // A new element - the step's first, or a preferred one that just appeared, like
      // Generate Report once the phone's filter bar is unfolded - is brought into view
      // and glided to. The same element on later frames is only followed.
      if (el !== current) {
        current = el;
        found = true;
        everFoundRef.current = true;
        bringIntoView(el);
        glide();
      }

      const r = el.getBoundingClientRect();
      const box = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
      setSpot(prev => (sameBox(prev, box) ? prev : box));

      const pop = popRef.current;
      if (isMobile) {
        dockSheet(box);
      } else if (pop) {
        const next = placeCallout(box, pop.offsetWidth, pop.offsetHeight);
        setPos(prev => (prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5 ? prev : next));
      }

      raf = requestAnimationFrame(tick);
    };

    // Where the phone's sheet starts when it is docked at the bottom, wherever it is
    // docked right now.
    const bottomSheetTop = () => {
      const pop = popRef.current;
      if (!pop) return window.innerHeight;
      const pr = pop.getBoundingClientRect();
      if (!sheetAtTopRef.current) return pr.top;
      return window.innerHeight - (dockGapRef.current ?? 0) - pr.height;
    };

    // Scrolls the element into view only if it is not already - so a step never moves
    // a layout that was fine - and on a phone, clear of the sheet over the bottom. A
    // phone scrolls the document (index.css hands the scroll back to it), and scrolling
    // it directly keeps a margin above the element that scrollIntoView would not.
    const bringIntoView = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const room = isMobile ? bottomSheetTop() : window.innerHeight;
      if (r.top >= 8 && r.bottom <= room - 8) return;
      if (r.top >= 8 && r.top < room * 0.4) return; // taller than the room, and its top already shows
      const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth';
      if (isMobile) window.scrollBy({ top: r.top - 16, behavior });
      else el.scrollIntoView({ block: 'center', behavior });
    };

    // A phone's sheet docks at the bottom, unless docking it at the top hides less of
    // the element - which is the case for something that cannot be scrolled out from
    // under it, like the report dialog fixed in the middle of the screen. The margin
    // stops it flipping back and forth on a near tie.
    const dockSheet = (box: Box) => {
      const pop = popRef.current;
      if (!pop) return;
      const pr = pop.getBoundingClientRect();
      if (!sheetAtTopRef.current) dockGapRef.current = window.innerHeight - pr.bottom;
      const overlap = (top: number) =>
        Math.max(0, Math.min(box.top + box.height, top + pr.height) - Math.max(box.top, top));
      const hiddenAtBottom = overlap(bottomSheetTop());
      const hiddenAtTop = overlap(SHEET_TOP);
      const atTop = sheetAtTopRef.current ? hiddenAtBottom >= hiddenAtTop - 24 : hiddenAtTop + 24 < hiddenAtBottom;
      if (atTop !== sheetAtTopRef.current) {
        sheetAtTopRef.current = atTop;
        setSheetAtTop(atTop);
      }
    };

    // The spotlight and callout animate between steps and nowhere else: animating
    // while they follow a scrolling list would make them trail behind it.
    const glide = () => {
      const root = rootRef.current;
      if (!root || reducedMotion()) return;
      root.dataset.glide = '';
      window.setTimeout(() => { delete root.dataset.glide; }, 360);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [index, tour, steps, move, isMobile]);

  // Focus moves into the callout when a step shows, so the step is announced and the
  // buttons are one Tab away.
  const shown = spot !== null && (isMobile || pos !== null);
  useEffect(() => {
    if (shown && focusedStepRef.current !== index) {
      focusedStepRef.current = index;
      popRef.current?.focus({ preventScroll: true });
    }
  }, [shown, index]);

  // Esc closes. Arrows step, except where they already mean something: typing in a
  // field, a native select, or panning the map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .leaflet-container')) return;
      if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft' && index > 0) move(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [move, index]);

  const step = steps[index];
  const isLast = index === steps.length - 1;
  const tryIt = !!step.advanceOn;
  // Only a "try it" step, or one marked interactive, lets the page be used.
  const blocking = !tryIt && !step.interactive;

  return createPortal(
    <div ref={rootRef} className="tour-root">
      {blocking && <div className="tour-blocker" aria-hidden="true" />}

      {spot && (
        <div
          className="tour-spot"
          aria-hidden="true"
          style={{ transform: `translate(${spot.left}px, ${spot.top}px)`, width: spot.width, height: spot.height }}
        />
      )}

      <div
        ref={popRef}
        className={`tour-pop${isMobile ? ` tour-pop--sheet${sheetAtTop ? ' tour-pop--top' : ''}` : ''}`}
        data-shown={shown ? 'true' : 'false'}
        style={!isMobile && pos ? { top: pos.top, left: pos.left } : undefined}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
      >
        <div className="tour-pop-head">
          <span className="tour-pop-kicker">
            {t(TOUR_NAME[tour])} · {t('Step {n} of {total}').replace('{n}', String(index + 1)).replace('{total}', String(steps.length))}
          </span>
          <button type="button" className="tour-close" onClick={() => onCloseRef.current()} aria-label={t('Close tour')} title={t('Close tour')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div key={index} className="tour-pop-content">
          <h3 id="tour-title" className="tour-pop-title">{t(step.title)}</h3>
          <p id="tour-body" className="tour-pop-body">{t(step.body)}</p>
        </div>

        <div className="tour-pop-foot">
          <div className="tour-dots" aria-hidden="true">
            {steps.map((_, i) => (
              <span key={i} className={i === index ? 'is-current' : i < index ? 'is-done' : undefined} />
            ))}
          </div>
          <div className="tour-pop-actions">
            {index > 0 && (
              <button type="button" className="btn-secondary tour-btn" onClick={() => move(-1)}>
                {t('Back')}
              </button>
            )}
            <button type="button" className="btn-primary tour-btn" onClick={() => move(1)}>
              {isLast ? t('Done') : tryIt ? t('Skip this step') : t('Next')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
