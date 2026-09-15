import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Whether the Dashboard header fits one row across the full width: title, filters and
 * the report button side by side. Measured rather than set by breakpoint, because what
 * fits turns on the language ("Räumungs-Analyse-Dashboard", "Alle Instrumente") and on
 * the project in the filter; the header stacks only when the row genuinely cannot hold
 * its content.
 *
 * Every width read is one the choice of layout does not change - the float's width and
 * the natural widths of the title text, the filters and the button - so switching
 * layout cannot flip the answer back.
 */
export function useHeaderRow(enabled: boolean) {
  const floatRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const reportRef = useRef<HTMLButtonElement | null>(null);
  const [row, setRow] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) return;
    const float = floatRef.current;
    const title = titleRef.current;
    const controls = controlsRef.current;
    const report = reportRef.current;
    const header = report?.parentElement;
    if (!float || !title || !controls || !report || !header) return;

    const px = (value: string) => parseFloat(value) || 0;
    const measure = () => {
      // The title's text, not its box: the box is whatever its grid cell gives it.
      const range = document.createRange();
      range.selectNodeContents(title);
      const titleWidth = range.getBoundingClientRect().width;
      const filters = Array.from(controls.children);
      const filtersWidth = filters.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)
        + px(getComputedStyle(controls).columnGap) * Math.max(0, filters.length - 1);
      const hs = getComputedStyle(header);
      const headerChrome = px(hs.paddingLeft) + px(hs.paddingRight) + px(hs.borderLeftWidth) + px(hs.borderRightWidth);
      const fs = getComputedStyle(float);
      const rowGap = px(fs.getPropertyValue('--space-5')); // the row's column gap, dashboard.css
      const available = float.clientWidth - px(fs.paddingLeft) - px(fs.paddingRight);
      const needed = titleWidth + filtersWidth + report.getBoundingClientRect().width + 2 * rowGap + headerChrome;
      setRow(needed <= available);
    };

    measure();
    // A filter's width follows its value and the language; the float's follows the window.
    const observer = new ResizeObserver(measure);
    [float, title, controls, report, ...Array.from(controls.children)].forEach(el => observer.observe(el));
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [enabled]);

  return [row, floatRef, titleRef, controlsRef, reportRef] as const;
}
