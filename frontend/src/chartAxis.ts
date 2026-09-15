import { useLayoutEffect, useState } from 'react';

/**
 * A category axis sized to its own labels, for the Dashboard's horizontal charts.
 *
 * Recharts wraps a tick that does not fit the axis width it is given, and a fixed
 * width (it was 124px) did not fit "Eisenstange / Eisenstab": the name broke onto two
 * lines inside a row too short for them and ran into the next. Here the width is
 * measured from the longest label and capped so the bars keep most of the plot; a
 * label past the cap is cut with an ellipsis by CategoryTick (chartParts.tsx), with
 * the full name as its tooltip, rather than wrapped.
 */

export const TICK_PX = 12;   // the charts' axis type, the 12px floor (AXIS in Dashboard)
export const TICK_GAP = 12;  // between a label and its bar, the tick's own offset included
// The most of the plot's width a label column may take: enough for the longest finding
// name in a 360px panel, and bars still keep the other 45%.
const MAX_SHARE = 0.55;

let measureCtx: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * TICK_PX * 0.62;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** `text` cut to `max` px with an ellipsis; unchanged when it already fits. */
export function fitText(text: string, max: number, font: string): string {
  if (textWidth(text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(`${text.slice(0, mid)}…`, font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/**
 * [ref for the chart's container, { width, font }]. Pass `width` to the YAxis and both
 * to its CategoryTick. Re-measured when the container resizes and when the webfont
 * lands, since both change what fits.
 */
export function useCategoryAxis(labels: readonly string[]) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [axis, setAxis] = useState({ width: 0, font: '' });

  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const font = `${cs.fontStyle} 400 ${TICK_PX}px ${cs.fontFamily}`;
      const longest = labels.reduce((max, label) => Math.max(max, textWidth(label, font)), 0);
      const cap = Math.floor(el.clientWidth * MAX_SHARE) || Infinity;
      const width = Math.min(Math.ceil(longest) + TICK_GAP, cap);
      setAxis(prev => (prev.width === width && prev.font === font ? prev : { width, font }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    document.fonts.addEventListener('loadingdone', measure);
    document.fonts.ready.then(measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [el, labels]);

  return [setEl, { width: axis.width || undefined, font: axis.font }] as const;
}
