import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { makeT, type AppLang } from '../i18n';
import { FilterBar } from './FilterBar';
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
const ExcavationOnly: React.FC<{ note: string; minHeight?: number }> = ({ note, minHeight }) => (
  <div style={{
    flex: 1,
    minHeight: minHeight ?? 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '10px',
    textAlign: 'center',
    color: '#64748b'
  }}>
    <Info size={15} />
    <span style={{ fontSize: '0.62rem', fontWeight: 700, lineHeight: 1.3 }}>{note}</span>
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

  // ---- Shared style tokens -------------------------------------------------
  // Desktop panels are flex children of a fixed-height column, so they size themselves
  // with flex + minHeight:0. In the mobile column there is no height to divide, so each
  // panel needs an explicit chart height instead.
  const panelStyle: React.CSSProperties = isMobile
    ? { padding: '12px', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }
    : { padding: '10px 12px', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, overflow: 'hidden' };

  const chartBodyStyle: React.CSSProperties = isMobile
    ? { width: '100%', height: '220px' }
    : { width: '100%', flex: 1, minHeight: 0 };

  const panelKickerStyle: React.CSSProperties = {
    fontSize: isMobile ? '0.6rem' : '0.5rem',
    fontWeight: 800,
    letterSpacing: '0.05em',
    textTransform: 'uppercase'
  };
  const panelTitleStyle: React.CSSProperties = {
    fontSize: isMobile ? '0.85rem' : '0.72rem',
    fontWeight: 800,
    color: '#fff',
    margin: 0
  };
  // Axis/legend text has to grow on a phone - 7px is unreadable at arm's length.
  const axisFontSize = isMobile ? 10 : 7;
  const legendFontSize = isMobile ? 10 : 7;

  // Native selects on iOS zoom the page in when focused below 16px. Full-width and
  // 40px tall also makes them a real tap target.
  const selectStyle: React.CSSProperties = isMobile
    ? {
        fontSize: '16px',
        padding: '8px 10px',
        fontWeight: 700,
        backgroundColor: 'rgba(10, 22, 18, 0.6)',
        borderColor: 'rgba(255, 255, 255, 0.06)',
        color: '#fff',
        cursor: 'pointer',
        borderRadius: '8px',
        height: '44px',
        width: '100%',
        maxWidth: '100%'
      }
    : {
        fontSize: '0.72rem',
        padding: '4px 20px 4px 8px',
        fontWeight: 700,
        backgroundColor: 'rgba(10, 22, 18, 0.6)',
        borderColor: 'rgba(255, 255, 255, 0.06)',
        color: '#fff',
        cursor: 'pointer',
        borderRadius: '6px',
        height: '26px'
      };

  const labelStyle: React.CSSProperties = {
    fontSize: isMobile ? '0.62rem' : '0.68rem',
    color: '#8c9f96',
    fontWeight: 700,
    textTransform: isMobile ? 'uppercase' : 'none',
    letterSpacing: isMobile ? '0.04em' : undefined
  };

  // ---- Controls ------------------------------------------------------------
  const projectSelect = (
    <select
      value={filterProjectId}
      onChange={(e) => setFilterProjectId(e.target.value)}
      className="form-input"
      title={t('Project ID')}
      style={{ ...selectStyle, maxWidth: isMobile ? '100%' : '260px' }}
    >
      <option value="all">{t('All Projects')}</option>
      {projectOptions.map((p) => (
        <option key={p.project_id} value={p.project_id}>
          {p.project_name ? `${p.project_id} — ${p.project_name}` : p.project_id}
        </option>
      ))}
    </select>
  );

  const instrumentSelect = (
    <select
      value={filterInstrument}
      onChange={(e) => setFilterInstrument(e.target.value)}
      className="form-input"
      title={t('Instrument')}
      style={selectStyle}
    >
      <option value="all">{t('All Instruments')}</option>
      <option value="georadar">{t('Georadar Array')}</option>
      <option value="magnetic">{t('Magnetics')}</option>
    </select>
  );

  // Depth bucket. Reads tief or errechnete Tiefe depending on the status next to it,
  // and narrows every card, chart and map marker.
  const depthSelect = (
    <select
      value={filterDepth}
      onChange={(e) => setFilterDepth(e.target.value)}
      className="form-input"
      title={t('Depth filter')}
      style={isMobile ? selectStyle : { fontSize: '0.65rem', padding: '2px 14px 2px 4px', height: '20px', backgroundColor: 'rgba(10, 22, 18, 0.6)', borderColor: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer', borderRadius: '4px' }}
    >
      {DEPTH_BUCKETS.map(bucket => (
        <option key={bucket.id} value={bucket.id}>{bucket.label}</option>
      ))}
    </select>
  );

  const statusSelect = (
    <select
      value={filterStatus}
      onChange={(e) => setFilterStatus(e.target.value)}
      className="form-input"
      title={t('Status filter')}
      style={isMobile ? selectStyle : { fontSize: '0.65rem', padding: '2px 14px 2px 4px', height: '20px', backgroundColor: 'rgba(10, 22, 18, 0.6)', borderColor: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer', borderRadius: '4px' }}
    >
      <option value="all">{t('All Targets')}</option>
      <option value="investigated">{t('Investigated')}</option>
      <option value="pending">{t('Pending')}</option>
    </select>
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
      className="btn-primary"
      onClick={onGenerateReport}
      title={t('Generate Report')}
      style={isMobile
        ? { height: '44px', width: '100%', padding: '0 12px', fontSize: '0.85rem', fontWeight: 700, gap: '8px', borderRadius: '8px', justifyContent: 'center' }
        : { height: '26px', padding: '0 12px', fontSize: '0.72rem', fontWeight: 700, gap: '6px', borderRadius: '6px', whiteSpace: 'nowrap' }}
    >
      <FileText size={isMobile ? 15 : 13} />
      {t('Generate Report')}
    </button>
  );

  // The desktop branch must reproduce the original styles exactly - no lineHeight, no
  // minWidth - or the header's measured height shifts by a pixel and drags the whole
  // left column down with it.
  const headerTitle = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', ...(isMobile ? { minWidth: 0 } : {}) }}>
      <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {t('Operations Overview')}
      </span>
      <h2 style={{ fontSize: isMobile ? '1rem' : '1.1rem', color: '#fff', fontWeight: 800, margin: 0, fontFamily: 'var(--font-heading)', ...(isMobile ? { lineHeight: 1.2 } : {}) }}>
        {t('Clearance Analytics Dashboard')}
      </h2>
    </div>
  );

  // ---- Stat cards ----------------------------------------------------------
  // The desktop branch reproduces the original inline styles exactly; the mobile-only
  // additions (larger type, minWidth:0 for ellipsis) are gated behind isMobile so wide
  // screens render byte-identically to before.
  const statCard = (
    label: string,
    value: React.ReactNode,
    accent: string,
    iconBg: string,
    valueColor: string,
    icon: React.ReactNode
  ) => (
    <div className="glass-panel" style={{
      // Compacted on mobile: tighter padding and a smaller icon chip shave roughly a
      // fifth off the 2x2 grid's height. The value itself stays at 16px - this is
      // compacting, not shrinking the numbers people actually read.
      padding: isMobile ? '6px 8px' : '8px 10px',
      display: 'flex',
      alignItems: 'center',
      gap: isMobile ? '7px' : '8px',
      borderLeft: `3px solid ${accent}`,
      borderRadius: '8px',
      ...(isMobile ? { minWidth: 0 } : {})
    }}>
      <div style={{ backgroundColor: iconBg, padding: isMobile ? '4px' : '5px', borderRadius: '5px', color: accent, display: 'flex', alignItems: 'center', ...(isMobile ? { flexShrink: 0 } : {}) }}>
        {icon}
      </div>
      <div style={isMobile ? { minWidth: 0 } : undefined}>
        <div style={{ fontSize: isMobile ? '0.55rem' : '0.5rem', color: '#8c9f96', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', ...(isMobile ? { lineHeight: 1.15 } : {}) }}>{label}</div>
        <div style={{ fontSize: isMobile ? '1rem' : '0.9rem', fontWeight: 800, fontFamily: 'var(--font-heading)', color: valueColor, ...(isMobile ? { lineHeight: 1.2 } : {}) }}>{value}</div>
      </div>
    </div>
  );

  const statCards = (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: isMobile ? '6px' : '8px', flexShrink: 0 }}>
      {statCard(t('TOTAL TARGETS'), total, '#f97316', 'rgba(249, 115, 22, 0.12)', '#fff', <Database size={14} />)}
      {statCard(t('INVESTIGATED'), investigated, '#10b981', 'rgba(16, 185, 129, 0.12)', '#10b981', <CheckCircle2 size={14} />)}
      {statCard(t('PENDING'), pending, '#ef4444', 'rgba(239, 68, 68, 0.12)', '#ef4444', <Clock size={14} />)}
      {statCard(t('SURVEY PROJECTS'), projectsCount, '#8b5cf6', 'rgba(139, 92, 246, 0.12)', '#a78bfa', <Briefcase size={14} />)}
    </div>
  );

  // ---- Chart panels --------------------------------------------------------
  const fundstueckPanel = (
    <div className="glass-panel" style={panelStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
        <span style={{ ...panelKickerStyle, color: '#f97316' }}>{t('Findings Status')}</span>
        <h3 style={panelTitleStyle}>{t('Grouped Findings (Sorted Low to High)')}</h3>
      </div>
      {hasExcavationData ? (
        <div style={chartBodyStyle}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={fundstueckChartData}
              margin={{ top: 5, right: 5, left: isMobile ? -22 : -32, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="name" stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} interval={isMobile ? 'preserveStartEnd' : undefined} />
              <YAxis stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} width={isMobile ? 30 : undefined} />
              <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: isMobile ? 11 : 8 }} />
              <Bar dataKey="count" name={t('Frequency')} fill="#fa5f1c" radius={[3, 3, 0, 0]} isAnimationActive={!isMobile} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ExcavationOnly note={excavationOnlyNote} minHeight={isMobile ? 120 : 0} />
      )}
    </div>
  );

  const sohlePanel = (
    <div className="glass-panel" style={panelStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
        <span style={{ ...panelKickerStyle, color: '#10b981' }}>{t('Excavation Integrity')}</span>
        <h3 style={panelTitleStyle}>{t('Sohle Status Split by Finding')}</h3>
      </div>
      {hasExcavationData ? (
        <div style={chartBodyStyle}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={sohleSplitChartData}
              margin={{ top: 5, right: 5, left: isMobile ? -22 : -32, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="name" stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} interval={isMobile ? 'preserveStartEnd' : undefined} />
              <YAxis stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} width={isMobile ? 30 : undefined} />
              <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: isMobile ? 11 : 8 }} />
              <Legend verticalAlign="top" height={isMobile ? 22 : 16} iconSize={isMobile ? 9 : 6} wrapperStyle={{ fontSize: legendFontSize }} />
              <Bar dataKey="Frei" name={t('Frei (Clear)')} fill="#10b981" stackId="sohle" isAnimationActive={!isMobile} />
              <Bar dataKey="Nicht Frei" name={t('Nicht Frei')} fill="#ef4444" stackId="sohle" isAnimationActive={!isMobile} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ExcavationOnly note={excavationOnlyNote} minHeight={isMobile ? 120 : 0} />
      )}
    </div>
  );

  // ---- Target log ----------------------------------------------------------
  const logPanel = (
    <div className="glass-panel" style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '12px',
      borderRadius: '12px',
      ...(isMobile ? { maxHeight: '70vh' } : { flex: 1.2, minHeight: 0 }),
      overflow: 'hidden'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flexShrink: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
          <span style={{ ...panelKickerStyle, color: '#10b981' }}>{t('Target Log')}</span>
          <h3 style={{ ...panelTitleStyle, fontSize: isMobile ? '0.85rem' : '0.75rem' }}>{t('Excavated Targets Database')} ({filteredPoints.length})</h3>
        </div>

        {/* On mobile these two live in the controls bar at the top of the column instead,
            where they sit with the other filters. */}
        {!isMobile && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
            {depthSelect}
            {statusSelect}
          </div>
        )}
      </div>

      <div
        ref={logScrollRef}
        onScroll={handleLogScroll}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: isMobile ? '5px' : '6px',
          overflowY: 'auto',
          flex: 1,
          paddingRight: '2px',
          // Mobile only: give the list a floor inside the flow, and keep its momentum
          // scroll from chaining into the page behind it. Desktop keeps the original
          // (unset) values so its geometry is untouched.
          ...(isMobile ? {
            minHeight: '180px',
            overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch'
          } : {})
        }}
      >
        {visibleLogPoints.map((point: LocalPoint) => {
          const isInvestigated = point.local_status === 'investigated';
          let statusText = t('PENDING');
          let badgeColor = '#ef4444';

          if (isInvestigated && point.feedback) {
            const fund = point.feedback.fundstueck || 'ohne Fund';
            statusText = fund === 'Sonstige' ? (point.feedback.other || 'Sonstige') : fund;
            badgeColor = fund === 'ohne Fund' ? '#64748b' : '#10b981';
          }

          return (
            <div
              key={point.id}
              className={`target-card-white ${selectedPoint?.id === point.id ? 'active' : ''}`}
              onClick={() => { onSelectPoint(point); }}
              style={{
                // Mobile cards are compacted so noticeably more fit per screen: tighter
                // padding, no row gap, and a slimmer depth strip. The card stays well
                // over the 44px tap minimum and the VM number stays at 14px.
                padding: isMobile ? '6px 8px' : '6px 8px',
                borderRadius: '6px',
                backgroundColor: '#fff',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
                display: 'flex',
                flexDirection: 'column',
                gap: isMobile ? '0px' : '1px',
                border: selectedPoint?.id === point.id ? '1.5px solid #10b981' : '1px solid #e2e8f0',
                cursor: 'pointer',
                flexShrink: 0
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...(isMobile ? { gap: '6px' } : {}) }}>
                <span style={{ fontWeight: 800, fontSize: isMobile ? '0.875rem' : '0.68rem', color: '#0f172a', ...(isMobile ? { lineHeight: 1.2 } : {}) }}>VM {point.vm_nr}</span>
                <span style={{
                   fontSize: isMobile ? '0.58rem' : '0.5rem',
                   fontWeight: 800,
                   padding: '1px 4px',
                   borderRadius: '3px',
                   backgroundColor: 'rgba(0,0,0,0.04)',
                   color: badgeColor,
                   border: `1px solid ${badgeColor}22`,
                   whiteSpace: 'nowrap',
                   overflow: 'hidden',
                   textOverflow: 'ellipsis',
                   maxWidth: isMobile ? '55%' : '90px'
                }} title={statusText}>
                  {statusText.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: isMobile ? '0.64rem' : '0.55rem', color: '#64748b', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(isMobile ? { lineHeight: 1.2 } : {}) }}>
                {point.instrument?.toUpperCase()} • {point.layer?.replace('Stoerkoerper ', '') || t('Target')}
              </div>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                ...(isMobile ? { gap: '6px' } : {}),
                marginTop: isMobile ? '2px' : '1px',
                padding: isMobile ? '1px 5px' : '1px 4px',
                backgroundColor: 'rgba(0, 0, 0, 0.02)',
                borderRadius: '3px',
                fontSize: isMobile ? '0.62rem' : '0.55rem',
                ...(isMobile ? { lineHeight: 1.25 } : {})
              }}>
                {/* The measurement itself is held at ~13px on mobile while its label stays
                    small - compacting the row without shrinking the number being read. */}
                <span style={{ color: '#94a3b8', fontWeight: 700 }}>
                  {t('EVAL')}: <span style={isMobile ? { fontSize: '0.82rem' } : undefined}>{point.evaluated_depth ? `${point.evaluated_depth}m` : t('N/A')}</span>
                </span>
                {isInvestigated && point.feedback?.actual_depth && (
                  <span style={{ color: '#10b981', fontWeight: 800 }}>
                    {t('EXCAV')}: <span style={isMobile ? { fontSize: '0.82rem' } : undefined}>{point.feedback.actual_depth}m</span>
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {visibleLogPoints.length < filteredPoints.length && (
          <button
            type="button"
            onClick={() => setVisibleLogCount(c => c + LOG_PAGE_SIZE)}
            style={{
              flexShrink: 0,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '6px',
              color: '#8c9f96',
              fontWeight: 700,
              fontSize: isMobile ? '0.72rem' : '0.6rem',
              padding: isMobile ? '11px' : '6px',
              cursor: 'pointer'
            }}
          >
            {t('Show more')} ({filteredPoints.length - visibleLogPoints.length})
          </button>
        )}
      </div>
    </div>
  );

  // ---- Sensor accuracy -----------------------------------------------------
  const accuracyPanel = (
    <div className="glass-panel" style={panelStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
        <span style={{ ...panelKickerStyle, color: '#38bdf8' }}>{t('Sensor Accuracy')}</span>
        <h3 style={panelTitleStyle}>{t('Evaluated vs Excavated Depth')}</h3>
      </div>

      {/* The curve always renders: Evaluated (Sensor) comes from errechnete Tiefe and
          is valid for pending targets too. Only the Excavated series and the accuracy
          KPIs below need an excavation to exist, so only those two empty out. */}
      <div style={chartBodyStyle}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={depthCompData}
            margin={{ top: 5, right: 5, left: isMobile ? -22 : -32, bottom: 0 }}
          >
            <defs>
              <linearGradient id="colorEval" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#fa5f1c" stopOpacity={0.2}/>
                <stop offset="95%" stopColor="#fa5f1c" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorExec" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="limit" stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} interval={isMobile ? 'preserveStartEnd' : undefined} />
            <YAxis stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} width={isMobile ? 30 : undefined} />
            <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: isMobile ? 11 : 8 }} />
            <Legend verticalAlign="top" height={isMobile ? 22 : 16} iconSize={isMobile ? 9 : 6} wrapperStyle={{ fontSize: legendFontSize }} />
            <Area type="monotone" dataKey="Evaluated (Sensor)" name={t('Evaluated (Sensor)')} stroke="#fa5f1c" fillOpacity={1} fill="url(#colorEval)" strokeWidth={1.2} isAnimationActive={!isMobile} />
            {hasExcavationData && (
              <Area type="monotone" dataKey="Excavated (Actual)" name={t('Excavated (Actual)')} stroke="#10b981" fillOpacity={1} fill="url(#colorExec)" strokeWidth={1.2} isAnimationActive={!isMobile} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Geophysics KPI mini list - evaluated-vs-excavated measures, so undefined
          without an excavation to compare against. */}
      {hasExcavationData ? (
        <div className="glass-card" style={{ padding: '6px 8px', display: 'flex', justifyContent: 'space-between', gap: '6px', border: '1px solid rgba(255,255,255,0.04)', fontSize: isMobile ? '0.62rem' : '0.55rem', flexShrink: 0 }}>
          <div style={{ textAlign: 'center', flex: 1, ...(isMobile ? { minWidth: 0 } : {}) }}>
            <div style={{ color: '#8c9f96', fontWeight: 700 }}>{t('MEAN ERROR')}</div>
            <strong style={{ color: '#fff', fontSize: isMobile ? '0.78rem' : '0.68rem' }}>&plusmn; {meanDepthError}m</strong>
          </div>
          <div style={{ textAlign: 'center', flex: 1, ...(isMobile ? { minWidth: 0 } : {}), borderLeft: '1px solid rgba(255,255,255,0.06)', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ color: '#8c9f96', fontWeight: 700 }}>{t('ESTIMATION BIAS')}</div>
            <strong style={{ color: '#fa5f1c', fontSize: isMobile ? '0.7rem' : '0.62rem', display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={biasText}>{biasText}</strong>
          </div>
          <div style={{ textAlign: 'center', flex: 1, ...(isMobile ? { minWidth: 0 } : {}) }}>
            <div style={{ color: '#8c9f96', fontWeight: 700 }}>{t('FPR (EMPTY)')}</div>
            <strong style={{ color: '#ef4444', fontSize: isMobile ? '0.78rem' : '0.68rem' }}>{falsePositiveRate}%</strong>
          </div>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', border: '1px solid rgba(255,255,255,0.04)', color: '#64748b', flexShrink: 0 }}>
          <Info size={12} />
          <span style={{ fontSize: isMobile ? '0.68rem' : '0.58rem', fontWeight: 700, ...(isMobile ? { textAlign: 'center' } : {}) }}>{excavationOnlyNote}</span>
        </div>
      )}
    </div>
  );

  // ---- Target profiling ----------------------------------------------------
  const profilingPanel = (
    <div className="glass-panel" style={panelStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
        <span style={{ ...panelKickerStyle, color: '#fa5f1c' }}>{t('Target Profiling')}</span>
        <h3 style={panelTitleStyle}>{t('Target Dimensions (Stacked Serial Chart)')}</h3>
      </div>

      {hasExcavationData ? (
        <div style={chartBodyStyle}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={metricsChartData}
              margin={{ top: 5, right: 5, left: isMobile ? -22 : -32, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="name" stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} interval={isMobile ? 'preserveStartEnd' : undefined} />
              <YAxis stroke="#8c9f96" fontSize={axisFontSize} tickLine={false} axisLine={false} width={isMobile ? 30 : undefined} />
              <Tooltip contentStyle={{ backgroundColor: '#0a1612', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '6px', color: '#fff', fontSize: isMobile ? 11 : 8 }} />
              <Legend verticalAlign="top" height={isMobile ? 30 : 16} iconSize={isMobile ? 9 : 6} wrapperStyle={{ fontSize: legendFontSize }} />
              <Bar dataKey="Depth (m)" name={t('Depth (m)')} fill="#fa5f1c" stackId="metrics" isAnimationActive={!isMobile} />
              <Bar dataKey="Length (m)" name={t('Length (m)')} fill="#38bdf8" stackId="metrics" isAnimationActive={!isMobile} />
              <Bar dataKey="Width (m)" name={t('Width (m)')} fill="#e2e8f0" stackId="metrics" isAnimationActive={!isMobile} />
              <Bar dataKey="Volume (m³)" name={t('Volume (m³)')} fill="#10b981" stackId="metrics" isAnimationActive={!isMobile} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <ExcavationOnly note={excavationOnlyNote} minHeight={isMobile ? 120 : 0} />
      )}
    </div>
  );

  // ==========================================================================
  // MOBILE: one scrolling column. Reading order is controls -> headline numbers
  // -> the two findings charts -> the map -> the log and the accuracy panels.
  // ==========================================================================
  if (isMobile) {
    return (
      <div className="dashboard-mobile">
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', borderRadius: '12px' }}>
          {headerTitle}

          {/* Folded by default so the dashboard opens on the stat cards and charts
              rather than on a screenful of dropdowns. The bar itself carries the
              active selection, so nothing is hidden - only collapsed. */}
          <FilterBar label={t('Filter')} summary={filterSummary} toggleLabel={t('Show filters')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={labelStyle}>{t('PROJECT:')}</span>
              {projectSelect}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={labelStyle}>{t('INSTRUMENT:')}</span>
              {instrumentSelect}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={labelStyle}>{t('Depth filter')}</span>
              {depthSelect}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={labelStyle}>{t('Status filter')}</span>
              {statusSelect}
            </div>
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
  // DESKTOP: unchanged floating-panel layout over the full-bleed map.
  // ==========================================================================
  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      boxSizing: 'border-box',
      pointerEvents: 'none'
    }}>

      {/* 1. Horizontal top-floating Dashboard Section Header */}
      <div className="glass-panel" style={{
        position: 'absolute',
        top: '12px',
        left: '12px',
        right: '384px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 16px',
        borderRadius: '12px',
        pointerEvents: 'auto',
        zIndex: 10
      }}>
        {headerTitle}

        {/* Dropdown Selector */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* Project scope. Narrows every card, chart, the log and the map markers, and
              composes with instrument + status + depth. */}
          <span style={labelStyle}>{t('PROJECT:')}</span>
          {projectSelect}

          <span style={labelStyle}>{t('INSTRUMENT:')}</span>
          {instrumentSelect}

          {reportButton}
        </div>
      </div>

      {/* 2. LEFT COLUMN: Floating analytics widgets & stacked charts */}
      <div style={{
        position: 'absolute',
        top: '90px',
        left: '12px',
        bottom: '12px',
        width: '360px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 10
      }}>
        {statCards}
        {fundstueckPanel}
        {sohlePanel}
      </div>

      {/* 3. RIGHT COLUMN: Target Clearance Log points listing and charts stacked vertically */}
      <div style={{
        position: 'absolute',
        top: '12px',
        right: '12px',
        bottom: '12px',
        width: '360px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 10
      }}>
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
