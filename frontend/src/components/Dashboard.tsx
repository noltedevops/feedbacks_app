import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { makeT, type AppLang } from '../i18n';
import { FilterBar } from './FilterBar';
import { Select } from './Select';
import { useTokenColors } from '../useTokenColors';
import {
  CheckCircle2,
  Database,
  Clock,
  Briefcase,
  FileText,
  Info
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';

// Depth buckets for the dashboard depth filter. Edges are inclusive-low /
// exclusive-high - [0,0.5), [0.5,1.0), [1.0,1.5), [1.5,inf) - so a target at exactly
// 0.5 m lands in the second bucket and never in two at once. Labels stay German in
// both language modes because the crew reads them as fixed depth classes.
export const DEPTH_BUCKETS: { id: string; label: string; min: number; max: number | null }[] = [
  { id: 'all', label: 'Alle Tiefen', min: 0, max: null },
  { id: '0-0.5', label: '0 – 0,5 m', min: 0, max: 0.5 },
  { id: '0.5-1', label: '0,5 – 1,0 m', min: 0.5, max: 1.0 },
  { id: '1-1.5', label: '1,0 – 1,5 m', min: 1.0, max: 1.5 },
  { id: '1.5+', label: '> 1,5 m', min: 1.5, max: null }
];

// Which depth column a bucket reads has to follow the status selection: `tief` (the
// actual excavated depth) is null until a target is opened, so filtering pending
// targets on it would make every one of them disappear.
function resolveDepth(point: LocalPoint, filterStatus: string): number | null {
  const actual = point.feedback?.actual_depth ?? null;   // tief
  const evaluated = point.evaluated_depth ?? null;       // errechnete Tiefe
  if (filterStatus === 'pending') return evaluated;
  if (filterStatus === 'investigated') return actual;
  return actual ?? evaluated;                            // all: actual wins, else calculated
}

// Shared by every dashboard dataset so the cards, the log list and the map markers all
// narrow identically. `all` is the only value that imposes no constraint; under any
// specific bucket a target with no value on the relevant column is excluded.
export function matchesDepthBucket(point: LocalPoint, bucketId: string, filterStatus: string): boolean {
  if (bucketId === 'all') return true;
  const bucket = DEPTH_BUCKETS.find(b => b.id === bucketId);
  if (!bucket) return true;

  const depth = resolveDepth(point, filterStatus);
  if (depth === null || Number.isNaN(depth)) return false;

  return depth >= bucket.min && (bucket.max === null || depth < bucket.max);
}

// A target counts as excavated once a field crew has filed its opening record. Sohle,
// Fundstück and the actual measurements all live on that record, so nothing derived from
// them exists before it.
const hasExcavation = (p: LocalPoint) => !!p.local_status && p.local_status !== 'unvisited' && !!p.feedback;

// How many log rows are in the DOM before the user scrolls for more. The unwindowed
// list put one shadowed, transition-animated card per target on the page - at ~1500
// targets that is the second-biggest source of scroll cost after the map markers.
const LOG_PAGE_SIZE = 40;

// Panels whose numbers only exist after a target has been dug. When the current selection
// holds no excavated targets there is genuinely nothing to plot, so the panel says so
// rather than borrowing rows from a status the user filtered out.
const ExcavationOnly: React.FC<{ note: string }> = ({ note }) => (
  <div className="dash-empty">
    <Info size={16} aria-hidden="true" />
    <span>{note}</span>
  </div>
);

interface DashboardProps {
  lang: AppLang;
  points: LocalPoint[];
  filteredPoints: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
  isOnline: boolean;
  onSeedRequest: () => Promise<void>;
  addDataOpen: boolean;
  setAddDataOpen: (open: boolean) => void;
  filterStatus: string;
  setFilterStatus: (status: string) => void;
  filterInstrument: string;
  setFilterInstrument: (instrument: string) => void;
  filterDepth: string;
  setFilterDepth: (depth: string) => void;
  // Reuses the app-wide project scoping rather than adding a parallel mechanism, so the
  // dashboard and the field app agree on which project is in view.
  filterProjectId: string;
  setFilterProjectId: (projectId: string) => void;
  projectOptions: { project_id: string; project_name?: string }[];
  onGenerateReport: () => void;
  // Narrow screens reflow the floating panels into one scrolling column. The map stops
  // being a background layer and becomes a block in that column, which is why it arrives
  // as a slot instead of being rendered behind this component.
  isMobile?: boolean;
  mapSlot?: React.ReactNode;
}

const DashboardImpl: React.FC<DashboardProps> = ({
  lang,
  points,
  filteredPoints,
  selectedPoint,
  onSelectPoint,
  isOnline: _isOnline,
  onSeedRequest: _onSeedRequest,
  addDataOpen: _addDataOpen,
  setAddDataOpen: _setAddDataOpen,
  filterStatus,
  setFilterStatus,
  filterInstrument,
  setFilterInstrument,
  filterDepth,
  setFilterDepth,
  filterProjectId,
  setFilterProjectId,
  projectOptions,
  onGenerateReport,
  isMobile = false,
  mapSlot
}) => {
  const t = useMemo(() => makeT(lang), [lang]);

  // EVALUATION-BASED SET: every target the current filters select, pending included.
  // Sensor/evaluated depth and the headline counts are meaningful for all of them.
  // `filteredPoints` (log list + map markers) is the same selection, narrowed upstream
  // in App. Status is applied here too so the cards can never report on targets the
  // status dropdown excluded.
  const dashboardPoints = useMemo(() => points.filter(p => {
    const matchesProject = filterProjectId === 'all' || p.project_id === filterProjectId;

    const matchesInstrument = filterInstrument === 'all' ||
      (p.instrument && p.instrument.toLowerCase() === filterInstrument.toLowerCase());

    const isInvestigated = !!p.local_status && p.local_status !== 'unvisited';
    const matchesStatus = filterStatus === 'investigated' ? isInvestigated
      : filterStatus === 'pending' ? !isInvestigated
      : true;

    return matchesProject && matchesInstrument && matchesStatus &&
      matchesDepthBucket(p, filterDepth, filterStatus);
  }), [points, filterProjectId, filterInstrument, filterStatus, filterDepth]);

  // EXCAVATION-BASED SET: the dug subset of the above. Sohle, findings, actual
  // measurements and the evaluated-vs-excavated accuracy KPIs may only ever read from
  // this. Under Status = Pending it is empty by construction, which is exactly what
  // drives the empty states - a pending target has nothing to contribute to them.
  // Re-bucketing with 'investigated' forces the depth filter onto the actual `tief`
  // column, so an excavated target with no recorded depth cannot slip into a bucket via
  // its evaluated value when Status = All.
  const excavatedPoints = useMemo(() => dashboardPoints.filter(p =>
    hasExcavation(p) && matchesDepthBucket(p, filterDepth, 'investigated')
  ), [dashboardPoints, filterDepth]);
  const hasExcavationData = excavatedPoints.length > 0;
  const excavationOnlyNote = t('Investigated targets only');

  // Calculate statistics
  const { total, investigated, pending, projectsCount } = useMemo(() => {
    const totalCount = dashboardPoints.length;
    const investigatedCount = dashboardPoints.filter(p => !!p.local_status && p.local_status !== 'unvisited').length;
    // Unique Project IDs Count
    const projectIds = new Set(dashboardPoints.map(p => p.project_id || '11-24-2736'));
    return {
      total: totalCount,
      investigated: investigatedCount,
      pending: totalCount - investigatedCount,
      projectsCount: projectIds.size
    };
  }, [dashboardPoints]);

  // 1. Fundstück Status Chart (sorted low-to-high frequency of finding)
  const fundstueckChartData = useMemo(() => {
    const fundstueckMap: { [key: string]: number } = {};
    const standardOptions = ['ohne Fund', 'Eisenteil', 'Eisenstange / Eisenstab', 'Eisendraht', 'Eisenseil', 'Eisennägel', 'Steine', 'Sonstige'];
    standardOptions.forEach(opt => { fundstueckMap[opt] = 0; });

    // Fundstück is recorded during excavation, so this reads the dug subset only.
    excavatedPoints.forEach(p => {
      const key = p.feedback!.fundstueck || 'ohne Fund';
      fundstueckMap[key] = (fundstueckMap[key] || 0) + 1;
    });

    return Object.keys(fundstueckMap)
      .map(key => ({
        name: key,
        count: fundstueckMap[key]
      }))
      .filter(item => item.count > 0 || standardOptions.includes(item.name))
      .sort((a, b) => a.count - b.count);
  }, [excavatedPoints]);

  // 2. Sohle Status split by Fundstück
  const sohleSplitChartData = useMemo(() => {
    const sohleSplitMap: { [key: string]: { name: string; 'Frei': number; 'Nicht Frei': number } } = {};
    excavatedPoints.forEach(p => {
      const fund = p.feedback!.fundstueck || 'ohne Fund';
      const sohle = p.feedback!.sohle_status || 'Frei';
      if (!sohleSplitMap[fund]) {
        sohleSplitMap[fund] = { name: fund, 'Frei': 0, 'Nicht Frei': 0 };
      }
      if (sohle === 'Frei') {
        sohleSplitMap[fund]['Frei']++;
      } else {
        sohleSplitMap[fund]['Nicht Frei']++;
      }
    });
    return Object.values(sohleSplitMap);
  }, [excavatedPoints]);

  // 3. Evaluated vs Excavated Depth Distribution comparison data
  const depthCompData = useMemo(() => {
    const depthIntervals = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
    const data = depthIntervals.map(limit => ({
      limit: `${limit}m`,
      'Evaluated (Sensor)': 0,
      'Excavated (Actual)': 0
    }));

    // Evaluated (Sensor) is errechnete Tiefe, which the survey records for every target dug
    // or not, so it reads the full evaluation set and keeps rendering under Status = Pending.
    dashboardPoints.forEach(p => {
      const evalD = p.evaluated_depth || 0;
      if (evalD > 0) {
        for (let i = 0; i < depthIntervals.length; i++) {
          if (evalD <= depthIntervals[i]) {
            data[i]['Evaluated (Sensor)']++;
            break;
          }
        }
      }
    });

    // Excavated (Actual) only exists once a crew has opened the target.
    excavatedPoints.forEach(p => {
      const execD = p.feedback!.actual_depth || 0;
      if (execD > 0) {
        for (let i = 0; i < depthIntervals.length; i++) {
          if (execD <= depthIntervals[i]) {
            data[i]['Excavated (Actual)']++;
            break;
          }
        }
      }
    });

    return data;
  }, [dashboardPoints, excavatedPoints]);

  // 4. Geophysics KPI Card calculation
  // Mean error, bias and FPR are evaluated-vs-excavated measures - undefined without an
  // excavation to compare against, so they never see a pending target.
  const { meanDepthError, biasText, falsePositiveRate } = useMemo(() => {
    let totalDiff = 0;
    let totalBias = 0;
    let validDepthPairs = 0;
    let investigatedCount = 0;
    let ohneFundCount = 0;

    excavatedPoints.forEach(p => {
      investigatedCount++;
      if (p.feedback!.fundstueck === 'ohne Fund') {
        ohneFundCount++;
      }

      const evalD = p.evaluated_depth;
      const execD = p.feedback!.actual_depth;
      if (evalD !== null && execD !== null && evalD !== undefined && execD !== undefined) {
        totalDiff += Math.abs(evalD - execD);
        totalBias += (evalD - execD);
        validDepthPairs++;
      }
    });

    const rawBias = validDepthPairs > 0 ? totalBias / validDepthPairs : 0;

    return {
      meanDepthError: validDepthPairs > 0 ? (totalDiff / validDepthPairs).toFixed(2) : '0.00',
      biasText: validDepthPairs > 0
        ? (rawBias > 0.02 ? `${t('Too Deep')} (+${rawBias.toFixed(2)}m)` : (rawBias < -0.02 ? `${t('Too Shallow')} (${rawBias.toFixed(2)}m)` : `${t('Balanced')} (${rawBias.toFixed(2)}m)`))
        : t('N/A'),
      falsePositiveRate: investigatedCount > 0 ? Math.round((ohneFundCount / investigatedCount) * 100) : 0
    };
  }, [excavatedPoints, t]);

  // 5. Depth/Metrics per Fundstück Stacked Serial Chart data
  const metricsChartData = useMemo(() => {
    const metricsMap: { [key: string]: { count: number; depthSum: number; lengthSum: number; widthSum: number; volSum: number } } = {};
    // Every series here is an actual site measurement taken in the opening, so this is the
    // dug subset only. There is no evaluation-based series in this chart to keep.
    excavatedPoints.forEach(p => {
      const fund = p.feedback!.fundstueck || 'ohne Fund';
      if (!metricsMap[fund]) {
        metricsMap[fund] = { count: 0, depthSum: 0, lengthSum: 0, widthSum: 0, volSum: 0 };
      }
      metricsMap[fund].count++;
      metricsMap[fund].depthSum += p.feedback!.actual_depth || 0;
      metricsMap[fund].lengthSum += p.feedback!.laenge || 0;
      metricsMap[fund].widthSum += p.feedback!.breite || 0;
      metricsMap[fund].volSum += p.feedback!.m_cube || 0;
    });

    return Object.keys(metricsMap).map(key => {
      const val = metricsMap[key];
      return {
        name: key,
        'Depth (m)': Number((val.depthSum / val.count).toFixed(2)),
        'Length (m)': Number((val.lengthSum / val.count).toFixed(2)),
        'Width (m)': Number((val.widthSum / val.count).toFixed(2)),
        'Volume (m³)': Number((val.volSum / val.count).toFixed(2))
      };
    });
  }, [excavatedPoints]);

  // Windowed log list. Reset whenever the selection changes so a narrower filter never
  // shows a stale page count. Adjusted during render rather than in an effect - React's
  // documented way to reset state when a prop changes, and it avoids the extra render
  // pass an effect would cost.
  const [visibleLogCount, setVisibleLogCount] = useState(LOG_PAGE_SIZE);
  const [lastFilteredPoints, setLastFilteredPoints] = useState(filteredPoints);
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  if (lastFilteredPoints !== filteredPoints) {
    setLastFilteredPoints(filteredPoints);
    setVisibleLogCount(LOG_PAGE_SIZE);
  }

  // Returning to the top of the list is a DOM side effect, so it does belong here.
  useEffect(() => {
    if (logScrollRef.current) logScrollRef.current.scrollTop = 0;
  }, [filteredPoints]);

  const handleLogScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // Purely local to the log container - it never sets state that any chart or the map
    // reads, so growing the page cannot cascade into a re-render of the rest.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      setVisibleLogCount(c => (c >= filteredPoints.length ? c : c + LOG_PAGE_SIZE));
    }
  }, [filteredPoints.length]);

  const visibleLogPoints = useMemo(
    () => filteredPoints.slice(0, visibleLogCount),
    [filteredPoints, visibleLogCount]
  );

  // ---- Chart colours --------------------------------------------------------
  // Recharts writes series colours into SVG attributes, legends and tooltips, none of
  // which can read var(), so the tokens are resolved here - per theme, from the one
  // source in tokens.css.
  const c = useTokenColors([
    '--chart-1', '--chart-2', '--chart-3',
    '--status-found-rgb', '--status-pending-rgb',
    '--surface', '--surface-raised', '--surface-sunken', '--surface-border',
    '--surface-text', '--surface-text-muted'
  ] as const);

  // Chart type is the caption step - 12px, the floor - on every chart.
  const AXIS = 12;
  const axisProps = { fontSize: AXIS, tickLine: false, axisLine: false } as const;
  const tooltipProps = {
    contentStyle: {
      backgroundColor: c['--surface-raised'],
      border: `1px solid ${c['--surface-border']}`,
      borderRadius: 2,
      color: c['--surface-text'],
      fontSize: AXIS,
      boxShadow: 'var(--shadow-float)'
    },
    itemStyle: { color: c['--surface-text'] },
    labelStyle: { color: c['--surface-text-muted'], fontWeight: 600 },
    cursor: { fill: c['--surface-sunken'] }
  };
  const legendProps = {
    verticalAlign: 'top' as const,
    align: 'left' as const,
    height: 28,
    iconType: 'circle' as const,
    iconSize: 8,
    wrapperStyle: { fontSize: AXIS }
  };

  // Findings and the Sohle split share one category order - most frequent first - so
  // the two panels read against each other row by row.
  const findingsDesc = useMemo(() => [...fundstueckChartData].reverse(), [fundstueckChartData]);
  const sohleDesc = useMemo(() => {
    const order = findingsDesc.map(d => d.name);
    return [...sohleSplitChartData].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }, [findingsDesc, sohleSplitChartData]);

  // Sensor accuracy as a share of each set. Evaluated depth exists for every target
  // and excavated depth only for the dug ones - ~1700 against ~70 - so on a shared
  // count axis the excavated line lay flat along zero and compared nothing. Indexed to
  // a common base, the two distributions can be read against each other; the counts
  // stay in the tooltip.
  const depthShareData = useMemo(() => {
    const evalTotal = depthCompData.reduce((s, d) => s + d['Evaluated (Sensor)'], 0) || 1;
    const excTotal = depthCompData.reduce((s, d) => s + d['Excavated (Actual)'], 0) || 1;
    return depthCompData.map(d => ({
      limit: d.limit,
      evaluated: Math.round((d['Evaluated (Sensor)'] / evalTotal) * 1000) / 10,
      excavated: Math.round((d['Excavated (Actual)'] / excTotal) * 1000) / 10,
      evaluatedCount: d['Evaluated (Sensor)'],
      excavatedCount: d['Excavated (Actual)']
    }));
  }, [depthCompData]);

  // ---- Controls ------------------------------------------------------------
  // One control style for all four; the design system owns their colour.
  const projectSelect = (
    <Select
      className="dash-control dash-control--project"
      value={filterProjectId}
      onChange={setFilterProjectId}
      ariaLabel={t('Project ID')}
      options={[
        { value: 'all', label: t('All Projects') },
        ...projectOptions.map(p => ({ value: p.project_id, label: p.project_id, description: p.project_name || undefined, group: t('Projects') }))
      ]}
    />
  );

  const instrumentSelect = (
    <Select
      className="dash-control"
      value={filterInstrument}
      onChange={setFilterInstrument}
      ariaLabel={t('Instrument')}
      options={[
        { value: 'all', label: t('All Instruments') },
        { value: 'georadar', label: t('Georadar Array') },
        { value: 'magnetic', label: t('Magnetics') }
      ]}
    />
  );

  // Depth bucket. Reads tief or errechnete Tiefe depending on the status next to it,
  // and narrows every card, chart and map marker.
  const depthSelect = (
    <Select
      className="dash-control"
      size="sm"
      value={filterDepth}
      onChange={setFilterDepth}
      ariaLabel={t('Depth filter')}
      options={DEPTH_BUCKETS.map(bucket => ({ value: bucket.id, label: bucket.label }))}
    />
  );

  const statusSelect = (
    <Select
      className="dash-control"
      size="sm"
      value={filterStatus}
      onChange={setFilterStatus}
      ariaLabel={t('Status filter')}
      options={[
        { value: 'all', label: t('All Targets') },
        { value: 'investigated', label: t('Investigated') },
        { value: 'pending', label: t('Pending') }
      ]}
    />
  );

  // What the folded filter bar shows, so the active selection stays readable without
  // expanding. Reads the same values the controls are bound to, so it can never drift
  // out of sync with them.
  const filterSummary = useMemo(() => {
    const project = filterProjectId === 'all' ? t('All Projects') : filterProjectId;
    const instrument = filterInstrument === 'all'
      ? t('All Instruments')
      : filterInstrument === 'georadar' ? t('Georadar Array') : t('Magnetics');
    // Bucket labels are deliberately German in both language modes - see DEPTH_BUCKETS.
    const depth = (DEPTH_BUCKETS.find(b => b.id === filterDepth) ?? DEPTH_BUCKETS[0]).label;
    const status = filterStatus === 'investigated' ? t('Investigated')
      : filterStatus === 'pending' ? t('Pending')
      : t('All Targets');
    return [project, instrument, depth, status].join(' · ');
  }, [filterProjectId, filterInstrument, filterDepth, filterStatus, t]);

  const reportButton = (
    <button
      type="button"
      className="btn-primary dash-report"
      data-tour="dash.report"
      onClick={onGenerateReport}
    >
      <FileText size={16} aria-hidden="true" />
      {t('Generate Report')}
    </button>
  );

  const headerTitle = (
    <div className="dash-title-block">
      <span className="dash-kicker">{t('Operations Overview')}</span>
      <h2 className="dash-title">{t('Clearance Analytics Dashboard')}</h2>
    </div>
  );

  // ---- Stat tiles ------------------------------------------------------------
  // Label, value, and an icon for recognition. The value is ink, not a status colour:
  // text wears text tokens, and the icon beside it carries the identity.
  const statCard = (label: string, value: React.ReactNode, icon: React.ReactNode, tone?: 'found' | 'pending') => (
    <div className="dash-stat" data-tone={tone}>
      <span className="dash-stat-icon" aria-hidden="true">{icon}</span>
      <span className="dash-stat-text">
        <span className="dash-stat-label">{label}</span>
        <span className="dash-stat-value">{value}</span>
      </span>
    </div>
  );

  const statCards = (
    <div className="dash-stats" data-tour="dash.stats">
      {statCard(t('TOTAL TARGETS'), total, <Database size={16} />)}
      {statCard(t('INVESTIGATED'), investigated, <CheckCircle2 size={16} />, 'found')}
      {statCard(t('PENDING'), pending, <Clock size={16} />, 'pending')}
      {statCard(t('SURVEY PROJECTS'), projectsCount, <Briefcase size={16} />)}
    </div>
  );

  // ---- Panels ---------------------------------------------------------------
  const panelHead = (kicker: string, title: string) => (
    <div className="dash-panel-head">
      <span className="dash-kicker">{kicker}</span>
      <h3 className="dash-panel-title">{title}</h3>
    </div>
  );

  const fundstueckPanel = (
    <section className="glass-panel dash-panel" data-tour="dash.findings">
      {panelHead(t('Findings Status'), t('Findings by type'))}
      {hasExcavationData ? (
        <div className="dash-chart">
          <ResponsiveContainer width="100%" height="100%">
            {/* Horizontal: the finding names are long ("Eisenstange / Eisenstab") and
                need a row each, not a slanted tick under a column. One series, so no
                legend - the title names it. */}
            <BarChart data={findingsDesc} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={4}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} {...axisProps} />
              <YAxis type="category" dataKey="name" width={isMobile ? 112 : 124} interval={0} {...axisProps} />
              <Tooltip {...tooltipProps} />
              <Bar dataKey="count" name={t('Frequency')} fill={c['--chart-1']} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={!isMobile} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ExcavationOnly note={excavationOnlyNote} />
      )}
    </section>
  );

  const sohlePanel = (
    <section className="glass-panel dash-panel">
      {panelHead(t('Excavation Integrity'), t('Sohle Status Split by Finding'))}
      {hasExcavationData ? (
        <div className="dash-chart">
          <ResponsiveContainer width="100%" height="100%">
            {/* A state, so the status pair rather than series colours; the 2px surface
                stroke is the gap between the stacked segments. */}
            <BarChart data={sohleDesc} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={4}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} {...axisProps} />
              <YAxis type="category" dataKey="name" width={isMobile ? 112 : 124} interval={0} {...axisProps} />
              <Tooltip {...tooltipProps} />
              <Legend {...legendProps} />
              <Bar dataKey="Frei" name={t('Frei (Clear)')} stackId="sohle" fill={c['--status-found-rgb']} stroke={c['--surface']} strokeWidth={2} maxBarSize={16} isAnimationActive={!isMobile} />
              <Bar dataKey="Nicht Frei" name={t('Nicht Frei')} stackId="sohle" fill={c['--status-pending-rgb']} stroke={c['--surface']} strokeWidth={2} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={!isMobile} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ExcavationOnly note={excavationOnlyNote} />
      )}
    </section>
  );

  // ---- Target log ----------------------------------------------------------
  const logPanel = (
    <section className="glass-panel dash-panel dash-log" data-tour="dash.log">
      <div className="dash-log-head">
        {panelHead(t('Target Log'), `${t('Excavated Targets Database')} (${filteredPoints.length})`)}

        {/* On a phone these two live in the folded filter bar with the rest. */}
        {!isMobile && (
          <div className="dash-log-filters">
            {depthSelect}
            {statusSelect}
          </div>
        )}
      </div>

      <div ref={logScrollRef} onScroll={handleLogScroll} className="dash-log-scroll">
        {visibleLogPoints.map((point: LocalPoint) => {
          const isInvestigated = point.local_status === 'investigated';
          let statusText = t('PENDING');
          // Same vocabulary as the field app's target list - see .status-chip.
          let status: 'pending' | 'empty' | 'found' = 'pending';

          if (isInvestigated && point.feedback) {
            const fund = point.feedback.fundstueck || 'ohne Fund';
            statusText = fund === 'Sonstige' ? (point.feedback.other || 'Sonstige') : fund;
            status = fund === 'ohne Fund' ? 'empty' : 'found';
          }

          const isSelected = selectedPoint?.id === point.id;
          return (
            <button
              type="button"
              key={point.id}
              className={`target-card${isSelected ? ' active' : ''}`}
              aria-pressed={isSelected}
              onClick={() => onSelectPoint(point)}
            >
              <span className="target-card-head">
                <span className="target-card-vm num">VM {point.vm_nr}</span>
                <span className="status-chip" data-status={status} title={statusText}>{statusText}</span>
              </span>
              <span className="target-card-meta">
                {point.instrument?.toUpperCase()} · {point.layer?.replace('Stoerkoerper ', '') || t('Target')}
              </span>
              <span className="target-card-depth">
                <span className="target-card-depth-label">{t('EVAL')}: <span className="target-card-depth-value num">{point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')}</span></span>
                {isInvestigated && point.feedback?.actual_depth && (
                  <span className="target-card-depth-label">{t('EXCAV')}: <span className="target-card-depth-value num">{point.feedback.actual_depth} m</span></span>
                )}
              </span>
            </button>
          );
        })}

        {visibleLogPoints.length < filteredPoints.length && (
          <button type="button" className="btn-secondary list-more" onClick={() => setVisibleLogCount(c2 => c2 + LOG_PAGE_SIZE)}>
            {t('Show more')} <span className="num">({filteredPoints.length - visibleLogPoints.length})</span>
          </button>
        )}
      </div>
    </section>
  );

  // ---- Sensor accuracy -----------------------------------------------------
  const accuracyPanel = (
    <section className="glass-panel dash-panel" data-tour="dash.accuracy">
      {panelHead(t('Sensor Accuracy'), t('Evaluated vs Excavated Depth'))}

      {/* The curve always renders: Evaluated (Sensor) comes from errechnete Tiefe and is
          valid for pending targets too. Only the Excavated series and the KPIs below
          need an excavation to exist. Two series: legend, plus direct identity from
          the 2px lines' own colour beside their names. */}
      <div className="dash-chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={depthShareData} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="limit" {...axisProps} interval="preserveStartEnd" />
            <YAxis {...axisProps} width={44} unit="%" />
            <Tooltip
              {...tooltipProps}
              formatter={(value, name, item) => {
                const row = item?.payload as { evaluatedCount?: number; excavatedCount?: number } | undefined;
                const count = name === t('Excavated (Actual)') ? row?.excavatedCount : row?.evaluatedCount;
                return [`${value ?? 0}% (${count ?? 0})`, name];
              }}
            />
            <Legend {...legendProps} />
            <Area type="monotone" dataKey="evaluated" name={t('Evaluated (Sensor)')} stroke={c['--chart-1']} fill={c['--chart-1']} fillOpacity={0.1} strokeWidth={2} isAnimationActive={!isMobile} />
            {hasExcavationData && (
              <Area type="monotone" dataKey="excavated" name={t('Excavated (Actual)')} stroke={c['--chart-2']} fill={c['--chart-2']} fillOpacity={0.1} strokeWidth={2} isAnimationActive={!isMobile} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Evaluated-vs-excavated measures, so undefined without an excavation. */}
      {hasExcavationData ? (
        <dl className="dash-kpis">
          <div>
            <dt>{t('MEAN ERROR')}</dt>
            <dd className="num">&plusmn; {meanDepthError} m</dd>
          </div>
          <div>
            <dt>{t('ESTIMATION BIAS')}</dt>
            <dd title={biasText}>{biasText}</dd>
          </div>
          <div>
            <dt>{t('FPR (EMPTY)')}</dt>
            <dd className="num">{falsePositiveRate}%</dd>
          </div>
        </dl>
      ) : (
        <div className="dash-kpis dash-kpis--empty">
          <Info size={14} aria-hidden="true" />
          <span>{excavationOnlyNote}</span>
        </div>
      )}
    </section>
  );

  // ---- Target profiling ----------------------------------------------------
  // Mean length, width and depth per finding, grouped. These were stacked with the
  // volume, which summed metres with cubic metres into one meaningless bar; the three
  // linear measures share a unit and an axis, and the volume rides in the tooltip.
  const profilingTooltip = (
    <Tooltip
      {...tooltipProps}
      formatter={(value, name) => [`${value ?? 0} m`, name]}
      labelFormatter={(label) => {
        const row = metricsChartData.find(r => r.name === label);
        return row ? `${String(label)} · ${t('Volume (m³)')}: ${row['Volume (m³)']}` : label;
      }}
    />
  );

  const profilingPanel = (
    <section className="glass-panel dash-panel">
      {panelHead(t('Target Profiling'), t('Mean target dimensions by finding'))}

      {hasExcavationData ? (
        <div className="dash-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={metricsChartData} margin={{ top: 0, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="20%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="name" {...axisProps} interval="preserveStartEnd" />
              <YAxis {...axisProps} width={48} unit=" m" />
              {profilingTooltip}
              <Legend {...legendProps} />
              <Bar dataKey="Length (m)" name={t('Length (m)')} fill={c['--chart-1']} radius={[4, 4, 0, 0]} maxBarSize={12} isAnimationActive={!isMobile} />
              <Bar dataKey="Width (m)" name={t('Width (m)')} fill={c['--chart-2']} radius={[4, 4, 0, 0]} maxBarSize={12} isAnimationActive={!isMobile} />
              <Bar dataKey="Depth (m)" name={t('Depth (m)')} fill={c['--chart-3']} radius={[4, 4, 0, 0]} maxBarSize={12} isAnimationActive={!isMobile} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ExcavationOnly note={excavationOnlyNote} />
      )}
    </section>
  );

  // ==========================================================================
  // PHONE: one scrolling column. Reading order is controls -> headline numbers
  // -> the two findings charts -> the map -> the log and the accuracy panels.
  // ==========================================================================
  if (isMobile) {
    return (
      <div className="dashboard-mobile">
        <div className="glass-panel dash-header dash-header--mobile" data-tour="dash.filters">
          {headerTitle}

          {/* Folded by default so the dashboard opens on the numbers and charts rather
              than on a screenful of dropdowns. The bar carries the active selection,
              so nothing is hidden - only collapsed. */}
          <FilterBar label={t('Filter')} summary={filterSummary} toggleLabel={t('Show filters')}>
            <label className="dash-field">
              <span className="dash-field-label">{t('PROJECT:')}</span>
              {projectSelect}
            </label>
            <label className="dash-field">
              <span className="dash-field-label">{t('INSTRUMENT:')}</span>
              {instrumentSelect}
            </label>
            <label className="dash-field">
              <span className="dash-field-label">{t('Depth filter')}</span>
              {depthSelect}
            </label>
            <label className="dash-field">
              <span className="dash-field-label">{t('Status filter')}</span>
              {statusSelect}
            </label>
            {reportButton}
          </FilterBar>
        </div>

        {statCards}
        {fundstueckPanel}
        {sohlePanel}

        {mapSlot && (
          <div className="glass-panel dashboard-mobile-map">
            {mapSlot}
          </div>
        )}

        {logPanel}
        {accuracyPanel}
        {profilingPanel}
      </div>
    );
  }

  // ==========================================================================
  // DESKTOP: floating panels over the full-bleed map.
  // ==========================================================================
  return (
    <div className="dash-float">

      <div className="glass-panel dash-header dashboard-header-bar">
        {headerTitle}
        {reportButton}

        <div className="dash-header-controls" data-tour="dash.filters">
          {/* Project scope. Narrows every card, chart, the log and the map markers, and
              composes with instrument + status + depth. */}
          {/* The controls carry their own names (aria-label, and a value that reads as
              what it is), so no visible label beside each: that is what wrapped the
              header onto a second row and squeezed the charts below it. */}
          {projectSelect}
          {instrumentSelect}
        </div>
      </div>

      <div className="dash-col dashboard-col-left">
        {statCards}
        {fundstueckPanel}
        {sohlePanel}
      </div>

      <div className="dash-col dashboard-col-right">
        {logPanel}
        {accuracyPanel}
        {profilingPanel}
      </div>

    </div>
  );
};

// Memoized so an unrelated App re-render (sync ticks, toasts, online/offline flips)
// cannot walk ~1500 targets through eight derived datasets and five charts.
export const Dashboard = React.memo(DashboardImpl);
