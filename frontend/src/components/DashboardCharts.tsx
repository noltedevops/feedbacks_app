import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { Info } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LocalPoint } from '../db/indexedDb';
import type { Translator } from '../i18n';
import { useCategoryAxis } from '../chartAxis';
import { CategoryTick, ChartLegend } from './chartParts';

/**
 * The Dashboard's charts and target log, each a component so the same chart can render
 * in its panel and, larger, in the expand overlay (PanelExpand). Both copies read the
 * datasets Dashboard derives from the current filters, so expanding cannot change what
 * is shown.
 *
 * `size` is what differs. The expanded copy is a second chart mounted in a container
 * of real size - Recharts measures that container and draws at it - with 14px axis
 * type, a label column measured at that type, and room for thicker bars. Nothing is a
 * CSS scale-up of the small one.
 */

export type ChartSize = 'panel' | 'expanded';

type ColorToken =
  | '--chart-1' | '--chart-2' | '--chart-3'
  | '--status-found-rgb' | '--status-pending-rgb'
  | '--surface' | '--surface-raised' | '--surface-sunken' | '--surface-border'
  | '--surface-text' | '--surface-text-muted';
export type ChartColors = Record<ColorToken, string>;

interface ChartProps {
  t: Translator;
  c: ChartColors;
  size: ChartSize;
  animate: boolean;
}

export interface ProfilingRow {
  name: string;
  'Depth (m)': number | null;
  'Length (m)': number | null;
  'Width (m)': number | null;
  'Volume (m³)': number | null;
}

// Chart type is the caption step - 12px, the floor - in a panel, and the body step in
// the overlay, which is read from further back and has the room.
const tickPx = (size: ChartSize) => (size === 'expanded' ? 14 : 12);
const axisProps = (size: ChartSize) => ({ fontSize: tickPx(size), tickLine: false, axisLine: false } as const);

function tooltipProps(c: ChartColors, size: ChartSize) {
  return {
    contentStyle: {
      backgroundColor: c['--surface-raised'],
      border: `1px solid ${c['--surface-border']}`,
      borderRadius: 2,
      color: c['--surface-text'],
      fontSize: tickPx(size),
      boxShadow: 'var(--shadow-float)'
    },
    itemStyle: { color: c['--surface-text'] },
    labelStyle: { color: c['--surface-text-muted'], fontWeight: 600 },
    cursor: { fill: c['--surface-sunken'] }
  };
}

function chartClass(size: ChartSize, tall = false) {
  if (size === 'expanded') return 'dash-chart dash-chart--expanded';
  return tall ? 'dash-chart dash-chart--tall' : 'dash-chart';
}

/**
 * Panels whose numbers only exist after a target has been dug. When the current
 * selection holds no excavated targets there is genuinely nothing to plot, so the panel
 * says so rather than borrowing rows from a status the user filtered out.
 */
export function ExcavationOnly({ note }: { note: string }) {
  return (
    <div className="dash-empty">
      <Info size={16} aria-hidden="true" />
      <span>{note}</span>
    </div>
  );
}

export function FindingsChart({ data, t, c, size, animate }: ChartProps & { data: { name: string; count: number }[] }) {
  const names = useMemo(() => data.map(d => d.name), [data]);
  const [ref, axis] = useCategoryAxis(names, tickPx(size));
  return (
    <div className={chartClass(size)} ref={ref}>
      <ResponsiveContainer width="100%" height="100%">
        {/* Horizontal: the finding names are long ("Eisenstange / Eisenstab") and need
            a row each, not a slanted tick under a column. One series, so no legend -
            the title names it. */}
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={size === 'expanded' ? 8 : 4}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" allowDecimals={false} {...axisProps(size)} />
          <YAxis type="category" dataKey="name" width={axis.width} interval={0} tick={<CategoryTick maxWidth={axis.width} font={axis.font} fontSize={tickPx(size)} />} {...axisProps(size)} />
          <Tooltip {...tooltipProps(c, size)} />
          <Bar dataKey="count" name={t('Frequency')} fill={c['--chart-1']} radius={[0, 4, 4, 0]} maxBarSize={size === 'expanded' ? 40 : 24} isAnimationActive={animate} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SohleChart({ data, t, c, size, animate }: ChartProps & { data: { name: string; 'Frei': number; 'Nicht Frei': number }[] }) {
  const names = useMemo(() => data.map(d => d.name), [data]);
  const [ref, axis] = useCategoryAxis(names, tickPx(size));
  const bar = size === 'expanded' ? 40 : 24;
  return (
    <>
      <ChartLegend items={[
        { label: t('Frei (Clear)'), color: c['--status-found-rgb'] },
        { label: t('Nicht Frei'), color: c['--status-pending-rgb'] }
      ]} />
      <div className={chartClass(size)} ref={ref}>
        <ResponsiveContainer width="100%" height="100%">
          {/* A state, so the status pair rather than series colours; the 2px surface
              stroke is the gap between the stacked segments. */}
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={size === 'expanded' ? 8 : 4}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" allowDecimals={false} {...axisProps(size)} />
            <YAxis type="category" dataKey="name" width={axis.width} interval={0} tick={<CategoryTick maxWidth={axis.width} font={axis.font} fontSize={tickPx(size)} />} {...axisProps(size)} />
            <Tooltip {...tooltipProps(c, size)} />
            <Bar dataKey="Frei" name={t('Frei (Clear)')} stackId="sohle" fill={c['--status-found-rgb']} stroke={c['--surface']} strokeWidth={2} maxBarSize={bar} isAnimationActive={animate} />
            <Bar dataKey="Nicht Frei" name={t('Nicht Frei')} stackId="sohle" fill={c['--status-pending-rgb']} stroke={c['--surface']} strokeWidth={2} radius={[0, 4, 4, 0]} maxBarSize={bar} isAnimationActive={animate} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export interface AccuracyRow {
  limit: string;
  band: string;
  evaluated: number;
  excavated: number;
  evaluatedCount: number;
  excavatedCount: number;
}

export function AccuracyBody({ data, hasExcavationData, kpis, emptyNote, t, c, size, animate }: ChartProps & {
  data: AccuracyRow[];
  hasExcavationData: boolean;
  kpis: { meanDepthError: string; biasText: string; falsePositiveRate: number };
  emptyNote: string;
}) {
  return (
    <>
      {/* What the percent axis is: each series' own share, so the ~70 dug targets read
          against the ~1700 surveyed ones on one scale. Counts stay in the tooltip. */}
      <p className="dash-panel-note">{t('Share of targets per 0.2 m depth band')}</p>

      {/* The curve always renders: Evaluated (Sensor) comes from errechnete Tiefe and is
          valid for pending targets too. Only the Excavated series and the KPIs below
          need an excavation to exist. */}
      <ChartLegend items={[
        { label: t('Evaluated (Sensor)'), color: c['--chart-1'] },
        ...(hasExcavationData ? [{ label: t('Excavated (Actual)'), color: c['--chart-2'] }] : [])
      ]} />
      <div className={chartClass(size)}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            {/* Ticks are each band's upper edge; the axis title carries the unit. */}
            {/* At 14px the first tick ran into the "0%" beside the corner; the expanded
                axis sets its ticks a little lower, with the height to match. */}
            <XAxis dataKey="limit" {...axisProps(size)} interval="preserveStartEnd" height={size === 'expanded' ? 46 : 32} tickMargin={size === 'expanded' ? 8 : undefined} label={{ value: t('Depth (m)'), position: 'insideBottom', offset: 0, fontSize: tickPx(size) }} />
            <YAxis {...axisProps(size)} width={size === 'expanded' ? 52 : 44} unit="%" />
            <Tooltip
              {...tooltipProps(c, size)}
              labelFormatter={(label, payload) => (payload?.[0]?.payload as { band?: string } | undefined)?.band ?? label}
              formatter={(value, name, item) => {
                const row = item?.payload as { evaluatedCount?: number; excavatedCount?: number } | undefined;
                const count = name === t('Excavated (Actual)') ? row?.excavatedCount : row?.evaluatedCount;
                return [`${value ?? 0}% (${count ?? 0})`, name];
              }}
            />
            <Area type="monotone" dataKey="evaluated" name={t('Evaluated (Sensor)')} stroke={c['--chart-1']} fill={c['--chart-1']} fillOpacity={0.1} strokeWidth={2} isAnimationActive={animate} />
            {hasExcavationData && (
              <Area type="monotone" dataKey="excavated" name={t('Excavated (Actual)')} stroke={c['--chart-2']} fill={c['--chart-2']} fillOpacity={0.1} strokeWidth={2} isAnimationActive={animate} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Evaluated-vs-excavated measures, so undefined without an excavation. */}
      {hasExcavationData ? (
        <dl className="dash-kpis">
          <div>
            <dt>{t('MEAN ERROR')}</dt>
            <dd className="num">&plusmn; {kpis.meanDepthError} m</dd>
          </div>
          <div>
            <dt>{t('ESTIMATION BIAS')}</dt>
            <dd title={kpis.biasText}>{kpis.biasText}</dd>
          </div>
          <div>
            <dt>{t('FPR (EMPTY)')}</dt>
            <dd className="num">{kpis.falsePositiveRate}%</dd>
          </div>
        </dl>
      ) : (
        <div className="dash-kpis dash-kpis--empty">
          <Info size={14} aria-hidden="true" />
          <span>{emptyNote}</span>
        </div>
      )}
    </>
  );
}

/**
 * Mean length, width and depth per finding, grouped; the volume rides in the tooltip.
 * A mean with no measurement behind it is null, not 0, and shows as N/A.
 */
export function ProfilingChart({ data, t, c, size, animate }: ChartProps & { data: ProfilingRow[] }) {
  const names = useMemo(() => data.map(d => d.name), [data]);
  const [ref, axis] = useCategoryAxis(names, tickPx(size));
  const bar = size === 'expanded' ? 16 : 10;
  return (
    <>
      <ChartLegend items={[
        { label: t('Length (m)'), color: c['--chart-1'] },
        { label: t('Width (m)'), color: c['--chart-2'] },
        { label: t('Depth (m)'), color: c['--chart-3'] }
      ]} />
      <div className={chartClass(size, true)} ref={ref}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Horizontal, like the two findings charts: as columns, the axis could show
              three of the eight finding names and silently dropped the rest. */}
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barGap={1} barCategoryGap={size === 'expanded' ? 12 : 6}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" {...axisProps(size)} unit=" m" />
            <YAxis type="category" dataKey="name" width={axis.width} interval={0} tick={<CategoryTick maxWidth={axis.width} font={axis.font} fontSize={tickPx(size)} />} {...axisProps(size)} />
            <Tooltip
              {...tooltipProps(c, size)}
              formatter={(value, name) => [value == null ? t('N/A') : `${value} m`, name]}
              labelFormatter={(label) => {
                const row = data.find(r => r.name === label);
                if (!row) return label;
                const volume = row['Volume (m³)'];
                return `${String(label)} · ${t('Volume (m³)')}: ${volume == null ? t('N/A') : volume}`;
              }}
            />
            <Bar dataKey="Length (m)" name={t('Length (m)')} fill={c['--chart-1']} radius={[0, 4, 4, 0]} maxBarSize={bar} isAnimationActive={animate} />
            <Bar dataKey="Width (m)" name={t('Width (m)')} fill={c['--chart-2']} radius={[0, 4, 4, 0]} maxBarSize={bar} isAnimationActive={animate} />
            <Bar dataKey="Depth (m)" name={t('Depth (m)')} fill={c['--chart-3']} radius={[0, 4, 4, 0]} maxBarSize={bar} isAnimationActive={animate} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

// How many log rows are in the DOM before the user scrolls for more. The unwindowed
// list put one shadowed, transition-animated card per target on the page - at ~1500
// targets that is the second-biggest source of scroll cost after the map markers.
const LOG_PAGE_SIZE = 40;

/**
 * The target log's list, windowed: in its panel, and as a grid of cards when expanded.
 * Each copy keeps its own window, reset whenever the selection changes.
 */
export function TargetLogList({ points, selectedId, onSelect, t, className }: {
  points: LocalPoint[];
  selectedId: string | null;
  onSelect: (point: LocalPoint) => void;
  t: Translator;
  className: string;
}) {
  const [visibleCount, setVisibleCount] = useState(LOG_PAGE_SIZE);
  const [lastPoints, setLastPoints] = useState(points);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Adjusted during render rather than in an effect - React's documented way to reset
  // state when a prop changes, and it avoids the extra render pass an effect would cost.
  if (lastPoints !== points) {
    setLastPoints(points);
    setVisibleCount(LOG_PAGE_SIZE);
  }

  // Returning to the top of the list is a DOM side effect, so it does belong here.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [points]);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // Purely local to the list - it never sets state any chart or the map reads.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      setVisibleCount(n => (n >= points.length ? n : n + LOG_PAGE_SIZE));
    }
  }, [points.length]);

  const shown = useMemo(() => points.slice(0, visibleCount), [points, visibleCount]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className={className}>
      {shown.map(point => {
        const isInvestigated = point.local_status === 'investigated';
        let statusText = t('PENDING');
        // Same vocabulary as the field app's target list - see .status-chip.
        let status: 'pending' | 'empty' | 'found' = 'pending';

        if (isInvestigated && point.feedback) {
          const fund = point.feedback.fundstueck || 'ohne Fund';
          statusText = fund === 'Sonstige' ? (point.feedback.other || 'Sonstige') : fund;
          status = fund === 'ohne Fund' ? 'empty' : 'found';
        }

        const isSelected = selectedId === point.id;
        const actual = point.feedback?.actual_depth;
        return (
          <button
            type="button"
            key={point.id}
            className={`target-card${isSelected ? ' active' : ''}`}
            aria-pressed={isSelected}
            onClick={() => onSelect(point)}
          >
            <span className="target-card-head">
              <span className="target-card-vm num">VM {point.vm_nr}</span>
              <span className="status-chip" data-status={status} title={statusText}>{statusText}</span>
            </span>
            <span className="target-card-meta">
              {point.instrument?.toUpperCase()} · {point.layer?.replace('Stoerkoerper ', '') || t('Target')}
            </span>
            {/* A depth is shown when it was recorded - a genuine 0 m included - and N/A
                only when it was not. */}
            <span className="target-card-depth">
              <span className="target-card-depth-label">{t('EVAL')}: <span className="target-card-depth-value num">{point.evaluated_depth != null ? `${point.evaluated_depth} m` : t('N/A')}</span></span>
              {isInvestigated && actual != null && (
                <span className="target-card-depth-label">{t('EXCAV')}: <span className="target-card-depth-value num">{actual} m</span></span>
              )}
            </span>
          </button>
        );
      })}

      {shown.length < points.length && (
        <button type="button" className="btn-secondary list-more" onClick={() => setVisibleCount(n => n + LOG_PAGE_SIZE)}>
          {t('Show more')} <span className="num">({points.length - shown.length})</span>
        </button>
      )}
    </div>
  );
}
