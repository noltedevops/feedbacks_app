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
  FileText,
  AlertTriangle,
  ShieldCheck,
  Activity,
  MapPin,
  Gauge
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
import { DEPTH_BUCKETS, matchesDepthBucket } from '../depthBuckets';
import {
  accuracyStats,
  hasExcavation,
  isOpenShallowHazard,
  isSohleClear,
  sohleCompliance,
  SHALLOW_HAZARD_DEPTH_M,
  SOHLE_COMPLIANCE_TARGET_PCT,
  volumeStats
} from '../dashboardStats';

function depthBucketLabel(bucket: { id: string; label: string }, t: (s: string) => string): string {
  return bucket.id === 'all' ? t(bucket.label) : bucket.label;
}

// toFixed keeps the sign of a value that rounds to zero ("-0.00"), which reads as a
// measurement rather than as none.
function fixed2(value: number): string {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

// The panels that expand into the large overlay (PanelExpand).
type PanelId = 'findings' | 'sohle' | 'accuracy' | 'profiling' | 'log';

interface DashboardProps {
  lang: AppLang;
  points: LocalPoint[];
  filteredPoints: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
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
  const { total, investigated, pending, projectsCount, sohleComplianceRate, shallowHazardCount } = useMemo(() => {
    const totalCount = dashboardPoints.length;
    const investigatedCount = dashboardPoints.filter(p => !!p.local_status && p.local_status !== 'unvisited').length;
    // Unique Project IDs Count
    const projectIds = new Set(dashboardPoints.map(p => p.project_id || '11-24-2736'));

    return {
      total: totalCount,
      investigated: investigatedCount,
      pending: totalCount - investigatedCount,
      projectsCount: projectIds.size,
      // Same rule as the Sohle split chart: no recorded status is not a clearance.
      sohleComplianceRate: sohleCompliance(excavatedPoints),
      // Still in the ground: a shallow target stops being a hazard once it is dug.
      shallowHazardCount: dashboardPoints.filter(isOpenShallowHazard).length
    };
  }, [dashboardPoints, excavatedPoints]);

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
      if (!sohleSplitMap[fund]) {
        sohleSplitMap[fund] = { name: fund, 'Frei': 0, 'Nicht Frei': 0 };
      }
      // Same rule as the compliance tile: no recorded status is not a clearance.
      if (isSohleClear(p.feedback!.sohle_status)) {
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
  const { meanDepthError, biasText, falsePositiveRate, velocityDriftText, velocityDriftLabel, velocityDriftTooltip } = useMemo(() => {
    const stats = accuracyStats(excavatedPoints);
    const na = t('N/A');

    const velocityDriftLabel = filterInstrument === 'magnetic'
      ? t('MAG ERROR')
      : (filterInstrument === 'all' ? t('GPR VELOCITY (Δv)') : t('VELOCITY DRIFT'));
    let velocityDriftText = na;
    let velocityDriftTooltip = '';

    if (filterInstrument === 'magnetic') {
      if (stats.magError !== null) velocityDriftText = `± ${fixed2(stats.magError)} m`;
      velocityDriftTooltip = t('Dipole gradient inversion error');
    } else if (stats.gprVelocityDrift !== null) {
      const drift = stats.gprVelocityDrift;
      velocityDriftText = `${drift > 0 ? '+' : ''}${drift.toFixed(1)}%`;
      if (Math.abs(drift) < 2) {
        velocityDriftTooltip = t('Radar velocity accurately calibrated');
      } else if (drift > 0) {
        velocityDriftTooltip = t('Radar velocity underestimated (soil permittivity lower than assumed)');
      } else {
        velocityDriftTooltip = t('Radar velocity overestimated (soil permittivity higher than assumed)');
      }
    }

    const bias = stats.bias;
    return {
      meanDepthError: stats.meanDepthError !== null ? `± ${fixed2(stats.meanDepthError)} m` : na,
      biasText: bias === null ? na
        : bias > 0.02 ? `${t('Too Deep')} (+${fixed2(bias)}m)`
        : bias < -0.02 ? `${t('Too Shallow')} (${fixed2(bias)}m)`
        : `${t('Balanced')} (${fixed2(bias)}m)`,
      falsePositiveRate: stats.falsePositiveRate !== null ? `${stats.falsePositiveRate}%` : na,
      velocityDriftText,
      velocityDriftLabel,
      velocityDriftTooltip
    };
  }, [excavatedPoints, filterInstrument, t]);

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

  // Only pits whose volume was recorded count; with none, each figure is N/A.
  const volumeKpis = useMemo(() => {
    const v = volumeStats(excavatedPoints);
    const na = t('N/A');
    return {
      totalVolume: v.total !== null ? `${v.total.toFixed(1)} m³` : na,
      meanPitVolume: v.meanPit !== null ? `${fixed2(v.meanPit)} m³` : na,
      findsPerM3: v.findsPerM3 !== null ? fixed2(v.findsPerM3) : na
    };
  }, [excavatedPoints, t]);

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
      searchable
      searchPlaceholder={t('Search projects...')}
      emptyText={t('No matching projects found')}
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
  const statCard = (label: string, value: React.ReactNode, icon: React.ReactNode, tone?: 'found' | 'pending' | 'hazard' | 'clear', hint?: string) => (
    <div className="dash-stat" data-tone={tone} title={hint}>
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
      {statCard(
        t('SOHLE COMPLIANCE'),
        sohleComplianceRate !== null ? `${sohleComplianceRate}%` : t('N/A'),
        <ShieldCheck size={16} />,
        sohleComplianceRate !== null && sohleComplianceRate >= SOHLE_COMPLIANCE_TARGET_PCT ? 'clear' : undefined,
        t('Excavated targets recorded with a clear Sohle. A record without a Sohle status counts as not clear.')
      )}
      {statCard(
        t('SHALLOW HAZARDS'),
        shallowHazardCount,
        <AlertTriangle size={16} />,
        shallowHazardCount > 0 ? 'hazard' : undefined,
        `${t('Targets not yet excavated with a calculated depth under')} ${String(SHALLOW_HAZARD_DEPTH_M).replace('.', lang === 'DE' ? ',' : '.')} m`
      )}
    </div>
  );

  // ---- Panels ---------------------------------------------------------------
  // Which panel is open in the large overlay, and the button that opened it, for focus
  // to go back to.
  const [expanded, setExpanded] = useState<{ id: PanelId; opener: HTMLElement } | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const [mobileTab, setMobileTab] = useState<'kpis' | 'map' | 'accuracy'>('kpis');

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
          kpis={{ meanDepthError, biasText, falsePositiveRate, velocityDriftText, velocityDriftLabel, velocityDriftTooltip }}
          emptyNote={excavationOnlyNote}
          instrument={filterInstrument}
          onSelectInstrument={setFilterInstrument}
          size={size}
          {...chartCommon}
        />
      );
    }
    if (!hasExcavationData) return <ExcavationOnly note={excavationOnlyNote} />;
    if (id === 'findings') return <FindingsChart data={findingsDesc} size={size} {...chartCommon} />;
    if (id === 'sohle') return <SohleChart data={sohleDesc} size={size} {...chartCommon} />;
    return <ProfilingChart data={metricsChartData} volumeKpis={volumeKpis} size={size} {...chartCommon} />;
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
        lang={lang}
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
            lang={lang}
            t={t}
            className="dash-log-scroll dash-log-scroll--grid"
          />
        </>
      ) : panelChart(expanded.id, 'expanded')}
    </ExpandedPanel>
  );

  // ==========================================================================
  // PHONE: 3-Cockpit Segmented Mobile Dashboard
  // Eliminates the 4,000px death scroll with instantaneous tab switching.
  // ==========================================================================
  if (isMobile) {
    return (
      <div className="dashboard-mobile">
        <div className="glass-panel dash-header dash-header--mobile" data-tour="dash.filters">
          {headerTitle}

          {/* 3-Cockpit Segmented Switcher */}
          <div className="dash-mobile-tabs" role="tablist" aria-label={t('Dashboard Sections')}>
            <button
              type="button"
              role="tab"
              aria-selected={mobileTab === 'kpis'}
              className={`dash-mobile-tab${mobileTab === 'kpis' ? ' active' : ''}`}
              onClick={() => setMobileTab('kpis')}
            >
              <Activity size={15} aria-hidden="true" />
              <span>{t('Executive KPIs')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileTab === 'map'}
              className={`dash-mobile-tab${mobileTab === 'map' ? ' active' : ''}`}
              onClick={() => setMobileTab('map')}
            >
              <MapPin size={15} aria-hidden="true" />
              <span>{t('Map & Target Log')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileTab === 'accuracy'}
              className={`dash-mobile-tab${mobileTab === 'accuracy' ? ' active' : ''}`}
              onClick={() => setMobileTab('accuracy')}
            >
              <Gauge size={15} aria-hidden="true" />
              <span>{t('Sensor Quality')}</span>
            </button>
          </div>

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

        {mobileTab === 'kpis' && (
          <div className="dash-mobile-tab-content">
            {statCards}
            {fundstueckPanel}
            {sohlePanel}
            <button 
              type="button" 
              className="btn-secondary dash-mobile-switch-btn" 
              onClick={() => setMobileTab('map')}
            >
              <MapPin size={15} aria-hidden="true" />
              {t('Explore Targets on Map')} →
            </button>
          </div>
        )}

        {mobileTab === 'map' && (
          <div className="dash-mobile-tab-content">
            {mapSlot && (
              <div className="glass-panel dashboard-mobile-map">
                {mapSlot}
              </div>
            )}
            {logPanel}
          </div>
        )}

        {mobileTab === 'accuracy' && (
          <div className="dash-mobile-tab-content">
            {accuracyPanel}
            {profilingPanel}
          </div>
        )}

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
