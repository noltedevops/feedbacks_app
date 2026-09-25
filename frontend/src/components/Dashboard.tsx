import React, { useMemo, useState, useCallback } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { makeT, type AppLang } from '../i18n';
import { FilterBar } from './FilterBar';
import { Select } from './Select';
import { useTokenColors } from '../useTokenColors';
import { categoriesForProject, matchesCategory } from '../useFilters';
import {
  CheckCircle2,
  Database,
  Clock,
  Briefcase,
  FileText
} from 'lucide-react';
import {
  AccuracyBody,
  ExcavationOnly,
  FindingsChart,
  ProfilingChart,
  SohleChart,
  TargetLogList,
  type ChartSize,
  type ProfilingRow
} from './DashboardCharts';
import { ExpandButton, ExpandedPanel } from './PanelExpand';
import { useHeaderRow } from '../useHeaderRow';

// Depth buckets for the dashboard depth filter. Edges are inclusive-low /
// exclusive-high - [0,0.5), [0.5,1.0), [1.0,1.5), [1.5,inf) - so a target at exactly
// 0.5 m lands in the second bucket and never in two at once. The range labels stay
// German in both language modes because the crew reads them as fixed depth classes;
// only the "all" entry is ordinary UI text, translated through depthBucketLabel().
export const DEPTH_BUCKETS: { id: string; label: string; min: number; max: number | null }[] = [
  { id: 'all', label: 'All depths', min: 0, max: null },
  { id: '0-0.5', label: '0 – 0,5 m', min: 0, max: 0.5 },
  { id: '0.5-1', label: '0,5 – 1,0 m', min: 0.5, max: 1.0 },
  { id: '1-1.5', label: '1,0 – 1,5 m', min: 1.0, max: 1.5 },
  { id: '1.5+', label: '> 1,5 m', min: 1.5, max: null }
];

function depthBucketLabel(bucket: { id: string; label: string }, t: (s: string) => string): string {
  return bucket.id === 'all' ? t(bucket.label) : bucket.label;
}

// toFixed keeps the sign of a value that rounds to zero ("-0.00"), which reads as a
// measurement rather than as none.
function fixed2(value: number): string {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

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

// The panels that expand into the large overlay (PanelExpand).
type PanelId = 'findings' | 'sohle' | 'accuracy' | 'profiling' | 'log';

interface DashboardProps {
  lang: AppLang;
  points: LocalPoint[];
  filteredPoints: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
  isOnline: boolean;
  addDataOpen: boolean;
  setAddDataOpen: (open: boolean) => void;
  // The dashboard's own filter group, independent of the field app's. App holds one
  // group per view; these are wired to the dashboard's. Narrowing here narrows this
  // screen and nothing else - the project included.
  filterStatus: string;
  setFilterStatus: (status: string) => void;
  filterInstrument: string;
  setFilterInstrument: (instrument: string) => void;
  filterDepth: string;
  setFilterDepth: (depth: string) => void;
  // The project was once the exception, shared so both views agreed on the site in
  // view. It no longer is: the office and the crew look at different sites at the same
  // time, so this is the dashboard's own project and the field app's heading and list
  // do not follow it.
  filterProjectId: string;
  setFilterProjectId: (projectId: string) => void;
  // anomalies.category, the dashboard's own like everything above. The list offered
  // is narrowed to the categories present under filterProjectId.
  filterCategory: string;
  setFilterCategory: (category: string) => void;
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
  filterCategory,
  setFilterCategory,
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
      matchesCategory(p, filterCategory) &&
      matchesDepthBucket(p, filterDepth, filterStatus);
  }), [points, filterProjectId, filterInstrument, filterStatus, filterDepth, filterCategory]);

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
  // 0.2 m bands, then one band for everything deeper than 2 m. Depths past the last
  // edge used to fall off the chart - and depth is where a sensor's estimate is most in
  // question, so the deepest targets are the last that should go missing.
  const depthCompData = useMemo(() => {
    const edges = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
    const data = [
      ...edges.map((edge, i) => ({
        limit: edge.toFixed(1),
        band: `${i === 0 ? '0' : edges[i - 1].toFixed(1)}–${edge.toFixed(1)} m`,
        'Evaluated (Sensor)': 0,
        'Excavated (Actual)': 0
      })),
      { limit: '> 2', band: '> 2.0 m', 'Evaluated (Sensor)': 0, 'Excavated (Actual)': 0 }
    ];
    // Upper edges are inclusive: 0.4 m is in 0.2–0.4, not 0.4–0.6.
    const bandOf = (depth: number) => {
      const i = edges.findIndex(edge => depth <= edge);
      return i === -1 ? edges.length : i;
    };

    // Evaluated (Sensor) is errechnete Tiefe, which the survey records for every target dug
    // or not, so it reads the full evaluation set and keeps rendering under Status = Pending.
    // A missing depth has no band: it is missing, not 0, and is never read as one. The
    // survey's literal 0 m depths are kept out of the bands too, by decision - five
    // targets on 11-24-2736, none dug.
    const banded = (depth: number | null | undefined): depth is number => depth != null && depth > 0;
    dashboardPoints.forEach(p => {
      if (banded(p.evaluated_depth)) data[bandOf(p.evaluated_depth)]['Evaluated (Sensor)']++;
    });

    // Excavated (Actual) only exists once a crew has opened the target.
    excavatedPoints.forEach(p => {
      const actual = p.feedback!.actual_depth;
      if (banded(actual)) data[bandOf(actual)]['Excavated (Actual)']++;
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
        ? (rawBias > 0.02 ? `${t('Too Deep')} (+${fixed2(rawBias)}m)` : (rawBias < -0.02 ? `${t('Too Shallow')} (${fixed2(rawBias)}m)` : `${t('Balanced')} (${fixed2(rawBias)}m)`))
        : t('N/A'),
      falsePositiveRate: investigatedCount > 0 ? Math.round((ohneFundCount / investigatedCount) * 100) : 0
    };
  }, [excavatedPoints, t]);

  // 5. Mean dimensions per finding. Every series is a measurement taken in the opening,
  // so this is the dug subset only. A measurement that was not taken is left out of its
  // mean - it used to count as 0 and pull the mean down - and a mean with nothing behind
  // it is null (shown as N/A), not 0.
  const metricsChartData = useMemo<ProfilingRow[]>(() => {
    type Tally = { sum: number; n: number };
    const tally = (): Tally => ({ sum: 0, n: 0 });
    const add = (slot: Tally, value: number | null | undefined) => {
      if (value != null) { slot.sum += value; slot.n++; }
    };
    const mean = (slot: Tally) => (slot.n ? Number((slot.sum / slot.n).toFixed(2)) : null);

    const byFinding: { [key: string]: { depth: Tally; length: Tally; width: Tally; volume: Tally } } = {};
    excavatedPoints.forEach(p => {
      const fund = p.feedback!.fundstueck || 'ohne Fund';
      const m = (byFinding[fund] ??= { depth: tally(), length: tally(), width: tally(), volume: tally() });
      add(m.depth, p.feedback!.actual_depth);
      add(m.length, p.feedback!.laenge);
      add(m.width, p.feedback!.breite);
      add(m.volume, p.feedback!.m_cube);
    });

    return Object.keys(byFinding).map(name => {
      const m = byFinding[name];
      return {
        name,
        'Depth (m)': mean(m.depth),
        'Length (m)': mean(m.length),
        'Width (m)': mean(m.width),
        'Volume (m³)': mean(m.volume)
      };
    });
  }, [excavatedPoints]);

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

  // Findings and the Sohle split share one category order - most frequent first - so
  // the two panels read against each other row by row.
  const findingsDesc = useMemo(() => [...fundstueckChartData].reverse(), [fundstueckChartData]);
  const sohleDesc = useMemo(() => {
    const order = findingsDesc.map(d => d.name);
    return [...sohleSplitChartData].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }, [findingsDesc, sohleSplitChartData]);

  // One header row across the full width wherever it fits - see useHeaderRow.
  const [headerRow, floatRef, titleRef, controlsRef, reportRef] = useHeaderRow(!isMobile);

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
      band: d.band,
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

  // Survey category, narrowed to the categories present under the dashboard's project.
  // A project change resets it in useFilters, so it never holds a value this list
  // does not offer.
  const dashCategories = useMemo(
    () => categoriesForProject(points, filterProjectId),
    [points, filterProjectId]
  );

  const categorySelect = (
    <Select
      className="dash-control dash-control--category"
      value={filterCategory}
      onChange={setFilterCategory}
      ariaLabel={t('Category')}
      options={[
        { value: 'all', label: t('All Categories') },
        ...dashCategories.map(c => ({ value: c, label: c }))
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
      options={DEPTH_BUCKETS.map(bucket => ({ value: bucket.id, label: depthBucketLabel(bucket, t) }))}
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
    // Range labels are deliberately German in both language modes - see DEPTH_BUCKETS.
    const depth = depthBucketLabel(DEPTH_BUCKETS.find(b => b.id === filterDepth) ?? DEPTH_BUCKETS[0], t);
    const status = filterStatus === 'investigated' ? t('Investigated')
      : filterStatus === 'pending' ? t('Pending')
      : t('All Targets');
    const category = filterCategory === 'all' ? t('All Categories') : filterCategory;
    return [project, instrument, category, depth, status].join(' · ');
  }, [filterProjectId, filterInstrument, filterCategory, filterDepth, filterStatus, t]);

  const reportButton = (
    <button
      ref={reportRef}
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
      <h2 className="dash-title" ref={titleRef}>{t('Clearance Analytics Dashboard')}</h2>
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
  // Which panel is open in the large overlay, and the button that opened it, for focus
  // to go back to.
  const [expanded, setExpanded] = useState<{ id: PanelId; opener: HTMLElement } | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);

  const panelTitles: Record<PanelId, [kicker: string, title: string]> = {
    findings: [t('Findings Status'), t('Findings by type')],
    sohle: [t('Excavation Integrity'), t('Sohle Status Split by Finding')],
    accuracy: [t('Sensor Accuracy'), t('Evaluated vs Excavated Depth')],
    profiling: [t('Target Profiling'), t('Mean target dimensions by finding')],
    log: [t('Target Log'), `${t('Excavated Targets Database')} (${filteredPoints.length})`]
  };

  const panelHead = (id: PanelId) => {
    const [kicker, title] = panelTitles[id];
    return (
      <div className="dash-panel-top">
        <div className="dash-panel-head">
          <span className="dash-kicker">{kicker}</span>
          <h3 className="dash-panel-title">{title}</h3>
        </div>
        <ExpandButton label={`${t('Expand')}: ${title}`} onClick={e => setExpanded({ id, opener: e.currentTarget })} />
      </div>
    );
  };

  // A panel's chart, at either size. Both sizes read the same datasets - the current
  // filters - so the overlay shows exactly what the panel does, drawn larger.
  const chartCommon = { t, c, animate: !isMobile };
  const panelChart = (id: Exclude<PanelId, 'log'>, size: ChartSize) => {
    if (id === 'accuracy') {
      return (
        <AccuracyBody
          data={depthShareData}
          hasExcavationData={hasExcavationData}
          kpis={{ meanDepthError, biasText, falsePositiveRate }}
          emptyNote={excavationOnlyNote}
          size={size}
          {...chartCommon}
        />
      );
    }
    if (!hasExcavationData) return <ExcavationOnly note={excavationOnlyNote} />;
    if (id === 'findings') return <FindingsChart data={findingsDesc} size={size} {...chartCommon} />;
    if (id === 'sohle') return <SohleChart data={sohleDesc} size={size} {...chartCommon} />;
    return <ProfilingChart data={metricsChartData} size={size} {...chartCommon} />;
  };

  const fundstueckPanel = (
    <section className="glass-panel dash-panel" data-tour="dash.findings">
      {panelHead('findings')}
      {panelChart('findings', 'panel')}
    </section>
  );

  const sohlePanel = (
    <section className="glass-panel dash-panel">
      {panelHead('sohle')}
      {panelChart('sohle', 'panel')}
    </section>
  );

  // ---- Target log ----------------------------------------------------------
  const logPanel = (
    <section className="glass-panel dash-panel dash-log" data-tour="dash.log">
      <div className="dash-log-head">
        {panelHead('log')}

        {/* On a phone these two live in the folded filter bar with the rest. */}
        {!isMobile && (
          <div className="dash-log-filters">
            {depthSelect}
            {statusSelect}
          </div>
        )}
      </div>

      <TargetLogList
        points={filteredPoints}
        selectedId={selectedPoint?.id ?? null}
        onSelect={onSelectPoint}
        t={t}
        className="dash-log-scroll"
      />
    </section>
  );

  // ---- Sensor accuracy -----------------------------------------------------
  const accuracyPanel = (
    <section className="glass-panel dash-panel" data-tour="dash.accuracy">
      {panelHead('accuracy')}
      {panelChart('accuracy', 'panel')}
    </section>
  );

  // ---- Target profiling ----------------------------------------------------
  const profilingPanel = (
    <section className="glass-panel dash-panel">
      {panelHead('profiling')}
      {panelChart('profiling', 'panel')}
    </section>
  );

  // ---- The expanded panel --------------------------------------------------
  // The log's cards select their target and close the overlay, so the map behind shows
  // what was picked; its two filters come along, being the log's own.
  const expandedView = expanded && (
    <ExpandedPanel
      t={t}
      kicker={panelTitles[expanded.id][0]}
      title={panelTitles[expanded.id][1]}
      opener={expanded.opener}
      onClose={closeExpanded}
    >
      {expanded.id === 'log' ? (
        <>
          <div className="dash-log-filters">
            {depthSelect}
            {statusSelect}
          </div>
          <TargetLogList
            points={filteredPoints}
            selectedId={selectedPoint?.id ?? null}
            onSelect={point => { onSelectPoint(point); closeExpanded(); }}
            t={t}
            className="dash-log-scroll dash-log-scroll--grid"
          />
        </>
      ) : panelChart(expanded.id, 'expanded')}
    </ExpandedPanel>
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
              <span className="dash-field-label">{t('CATEGORY:')}</span>
              {categorySelect}
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

        {expandedView}
      </div>
    );
  }

  // ==========================================================================
  // DESKTOP: floating panels over the full-bleed map.
  // ==========================================================================
  return (
    <div ref={floatRef} className={headerRow ? 'dash-float dash-float--header-row' : 'dash-float'}>

      <div className="glass-panel dash-header dashboard-header-bar">
        {headerTitle}
        {reportButton}

        <div className="dash-header-controls" data-tour="dash.filters" ref={controlsRef}>
          {/* Project scope. Narrows every card, chart, the log and the map markers, and
              composes with instrument + status + depth. */}
          {/* The controls carry their own names (aria-label, and a value that reads as
              what it is), so no visible label beside each: that is what wrapped the
              header onto a second row and squeezed the charts below it. */}
          {projectSelect}
          {instrumentSelect}
          {categorySelect}
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

      {expandedView}
    </div>
  );
};

// Memoized so an unrelated App re-render (sync ticks, toasts, online/offline flips)
// cannot walk ~1500 targets through eight derived datasets and five charts.
export const Dashboard = React.memo(DashboardImpl);
