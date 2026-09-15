import { fitText, TICK_GAP, TICK_PX } from '../chartAxis';

/**
 * Chart pieces the Dashboard shares. The measuring behind CategoryTick lives in
 * chartAxis.ts (useCategoryAxis), next to why it exists.
 */

/**
 * A category tick that never wraps. Recharts clones this with the tick's position and
 * value. It carries recharts-text itself: a custom tick is not inside the group the
 * axis-tick CSS targets, and without the class it painted default black - unreadable
 * on the dark theme's panels.
 */
export function CategoryTick({ x, y, payload, maxWidth, font, fontSize = TICK_PX }: {
  x?: number;
  y?: number;
  payload?: { value?: unknown };
  maxWidth?: number;
  font?: string;
  fontSize?: number;
}) {
  const full = String(payload?.value ?? '');
  const shown = font && maxWidth ? fitText(full, maxWidth - TICK_GAP, font) : full;
  return (
    <text className="recharts-text recharts-cartesian-axis-tick-value" x={x} y={y} dy="0.355em" textAnchor="end" fontSize={fontSize}>
      {shown !== full && <title>{full}</title>}
      {shown}
    </text>
  );
}

/**
 * Series names with their colour swatch, above the plot. In HTML rather than Recharts'
 * own legend, which reserves a fixed height inside the chart: a legend that wrapped
 * onto a second line in a narrow panel ran into the top of the axis.
 */
export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="dash-legend">
      {items.map(item => (
        <li key={item.label}>
          <span className="dash-legend-swatch" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
