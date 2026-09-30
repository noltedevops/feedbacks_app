import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Database, 
  X, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  ArrowRight, 
  Layers, 
  Activity,
  Check,
  Ban,
  Play,
  History,
  Search,
  ShieldCheck,
  TrendingUp,
  BarChart2
} from 'lucide-react';
import { authFetch } from '../auth';
import type { Translator } from '../i18n';

export interface EtlHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | string;
  timestamp: string;
  database_latency_ms?: number;
  staleness?: {
    is_stale: boolean;
    max_staleness_hours: number;
    seconds_since_last_success: number | null;
    last_success_at: string | null;
  };
}

export interface EtlRun {
  run_id: number;
  started_at: string | null;
  finished_at: string | null;
  status: 'ok' | 'failed' | 'skipped' | string;
  forced: boolean;
  summary: Record<string, unknown> | null;
}

export interface ParsedEtlRun extends EtlRun {
  durationSec: number;
  written: number;
  staged: number;
}

export interface EtlStagedChange {
  change_id: number;
  run_id: number;
  project_id: string;
  anomaly_id: number;
  vm_nr: string;
  column_name: string;
  old_value: string | null;
  new_value: string | null;
  staged_at: string | null;
}

export interface EtlCorrectionPair {
  pair_id: number;
  run_id: number;
  project_id: string;
  new_target_id: string;
  new_easting: number;
  new_northing: number;
  old_anomaly_id: number;
  old_vm_nr: string;
  old_easting: number;
  old_northing: number;
  distance_m: number;
  matched_by: string;
  status: 'pending' | 'conflict' | string;
}

export interface EtlAnomalyHistory {
  history_id: number;
  anomaly_id: string;
  project_id: string | null;
  target_id: string | null;
  vm_nr: string | null;
  instrument: string | null;
  category: string | null;
  layer: string | null;
  evaluated_depth: number | null;
  easting: number | null;
  northing: number | null;
  latitude: number | null;
  longitude: number | null;
  status: string | null;
  valid_from: string | null;
  valid_to: string | null;
  is_current: boolean;
  change_reason: string;
  decision_id: number | null;
  changed_by: string | null;
}

export interface EtlProjectOption {
  project_id: string;
  project_name: string;
}

interface EtlPanelProps {
  apiBase: string;
  t: Translator;
  onClose: () => void;
  onUpdateCounts?: (count: number) => void;
  showToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

export const EtlPanel: React.FC<EtlPanelProps> = ({
  apiBase,
  t,
  onClose,
  onUpdateCounts,
  showToast
}) => {
  const [activeTab, setActiveTab] = useState<'changes' | 'corrections' | 'runs' | 'history'>('runs');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [runs, setRuns] = useState<EtlRun[]>([]);
  const [stagedChanges, setStagedChanges] = useState<EtlStagedChange[]>([]);
  const [correctionPairs, setCorrectionPairs] = useState<EtlCorrectionPair[]>([]);
  const [projects, setProjects] = useState<EtlProjectOption[]>([]);
  const [selectedChanges, setSelectedChanges] = useState<Set<number>>(new Set());

  // Run execution state
  const [syncProject, setSyncProject] = useState<string>('');
  const [forceSync, setForceSync] = useState<boolean>(true);
  const [runningSync, setRunningSync] = useState<boolean>(false);

  // History state
  const [historyRecords, setHistoryRecords] = useState<EtlAnomalyHistory[]>([]);
  const [historySearch, setHistorySearch] = useState<string>('');
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);
  const [health, setHealth] = useState<EtlHealth | null>(null);

  // Runs analytics & filter state
  const [runFilter, setRunFilter] = useState<'all' | 'ok' | 'skipped' | 'failed'>('all');
  const [hoveredRun, setHoveredRun] = useState<ParsedEtlRun | null>(null);

  const runAnalytics = useMemo(() => {
    if (!runs || runs.length === 0) return null;

    let totalDuration = 0;
    let durationCount = 0;
    let okCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let totalWritten = 0;
    let totalStaged = 0;

    const parsedRuns: ParsedEtlRun[] = runs.map(run => {
      let durationSec = 0;
      if (run.started_at && run.finished_at) {
        durationSec = Math.max(0, (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000);
      }
      if (durationSec > 0 && run.status !== 'skipped') {
        totalDuration += durationSec;
        durationCount += 1;
      }

      if (run.status === 'ok') okCount++;
      else if (run.status === 'skipped') skippedCount++;
      else if (run.status === 'failed') failedCount++;

      const summary = (run.summary || {}) as Record<string, unknown>;
      const projects = (summary.projects || {}) as Record<string, Record<string, unknown>>;
      const written = Object.values(projects).reduce((acc: number, p) => {
        const a1 = p?.anomalie_1 as Record<string, unknown> | undefined;
        const w = typeof a1?.rows_written === 'number' ? a1.rows_written : 0;
        return acc + w;
      }, 0);
      const staged = Object.values(projects).reduce((acc: number, p) => {
        const s = typeof p?.changes_staged === 'number' ? p.changes_staged : 0;
        return acc + s;
      }, 0);

      totalWritten += written;
      totalStaged += staged;

      return {
        ...run,
        durationSec,
        written,
        staged
      };
    });

    const avgDuration = durationCount > 0 ? (totalDuration / durationCount).toFixed(1) : '0.0';
    const totalRuns = runs.length;
    const okRate = totalRuns > 0 ? Math.round((okCount / totalRuns) * 100) : 0;
    const skippedRate = totalRuns > 0 ? Math.round((skippedCount / totalRuns) * 100) : 0;
    const failedRate = totalRuns > 0 ? Math.max(0, 100 - okRate - skippedRate) : 0;
    const successRate = totalRuns > 0 ? Math.round(((okCount + skippedCount) / totalRuns) * 100) : 100;

    const chronologicalRuns = [...parsedRuns].reverse();
    const maxDuration = Math.max(...parsedRuns.map(r => r.durationSec), 1.0);
    const maxVolume = Math.max(...parsedRuns.map(r => Math.max(r.written, r.staged)), 10);

    return {
      parsedRuns,
      chronologicalRuns,
      totalRuns,
      okCount,
      skippedCount,
      failedCount,
      avgDuration,
      maxDuration,
      maxVolume,
      totalWritten,
      totalStaged,
      successRate,
      okRate,
      skippedRate,
      failedRate
    };
  }, [runs]);

  const filteredRuns = useMemo(() => {
    if (!runAnalytics) return [];
    if (runFilter === 'all') return runAnalytics.parsedRuns;
    return runAnalytics.parsedRuns.filter(r => r.status === runFilter);
  }, [runAnalytics, runFilter]);

  const fetchStatus = useCallback(async (isInitial = false) => {
    try {
      const [resStatus, resHealth] = await Promise.all([
        authFetch(`${apiBase}/api/etl/status`),
        authFetch(`${apiBase}/api/etl/health/details`).catch(() => null)
      ]);

      if (!resStatus.ok) throw new Error(`HTTP ${resStatus.status}`);
      const data = await resStatus.json();
      const loadedRuns: EtlRun[] = data.runs || [];
      const loadedChanges: EtlStagedChange[] = data.staged_changes || [];
      const loadedCorrections: EtlCorrectionPair[] = data.correction_pairs || [];
      const loadedProjects: EtlProjectOption[] = data.projects || [];

      setRuns(loadedRuns);
      setStagedChanges(loadedChanges);
      setCorrectionPairs(loadedCorrections);
      if (loadedProjects.length > 0) {
        setProjects(loadedProjects);
      }

      if (resHealth && resHealth.ok) {
        const healthData = await resHealth.json();
        setHealth(healthData);
      }

      const totalPending = loadedChanges.length + loadedCorrections.length;
      if (onUpdateCounts) {
        onUpdateCounts(totalPending);
      }

      if (isInitial) {
        if (loadedChanges.length > 0) {
          setActiveTab('changes');
        } else if (loadedCorrections.length > 0) {
          setActiveTab('corrections');
        } else {
          setActiveTab('runs');
        }
      }
    } catch (err) {
      console.error('Failed to load ETL status:', err);
      showToast('error', t('Failed to load ETL status.'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, onUpdateCounts, showToast, t]);

  const fetchHistory = useCallback(async (searchQuery = '') => {
    setLoadingHistory(true);
    try {
      let url = `${apiBase}/api/etl/history?limit=100`;
      if (searchQuery.trim()) {
        url += `&target_id=${encodeURIComponent(searchQuery.trim())}`;
      }
      const res = await authFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHistoryRecords(data || []);
    } catch (err) {
      console.error('Failed to load anomaly history:', err);
      showToast('error', t('Failed to load anomaly history.'));
    } finally {
      setLoadingHistory(false);
    }
  }, [apiBase, showToast, t]);

  useEffect(() => {
    let ignore = false;
    Promise.all([
      authFetch(`${apiBase}/api/etl/status`),
      authFetch(`${apiBase}/api/etl/health/details`).catch(() => null)
    ])
      .then(async ([resStatus, resHealth]) => {
        if (!resStatus.ok || ignore) return;
        const data = await resStatus.json();
        if (ignore) return;

        const loadedRuns: EtlRun[] = data.runs || [];
        const loadedChanges: EtlStagedChange[] = data.staged_changes || [];
        const loadedCorrections: EtlCorrectionPair[] = data.correction_pairs || [];
        const loadedProjects: EtlProjectOption[] = data.projects || [];

        setRuns(loadedRuns);
        setStagedChanges(loadedChanges);
        setCorrectionPairs(loadedCorrections);
        if (loadedProjects.length > 0) {
          setProjects(loadedProjects);
        }

        if (resHealth && resHealth.ok) {
          const healthData = await resHealth.json();
          if (!ignore) setHealth(healthData);
        }

        setLoading(false);

        const totalPending = loadedChanges.length + loadedCorrections.length;
        if (onUpdateCounts) {
          onUpdateCounts(totalPending);
        }

        if (loadedChanges.length > 0) {
          setActiveTab('changes');
        } else if (loadedCorrections.length > 0) {
          setActiveTab('corrections');
        } else {
          setActiveTab('runs');
        }
      })
      .catch(err => {
        if (!ignore) {
          console.error('Failed to load initial ETL status:', err);
          setLoading(false);
        }
      });

    // Background poll every 30s
    const interval = setInterval(() => {
      fetchStatus(false);
    }, 30000);

    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [apiBase, fetchStatus, onUpdateCounts]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleTriggerRun = async () => {
    setRunningSync(true);
    try {
      const res = await authFetch(`${apiBase}/api/etl/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: syncProject || null,
          force: forceSync
        })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        showToast('success', t('ETL sync completed successfully.'));
      } else {
        showToast('error', t('ETL sync failed.'));
      }
      await fetchStatus(false);
      if (activeTab === 'history') {
        await fetchHistory(historySearch);
      }
    } catch (err) {
      console.error('Failed to trigger ETL run:', err);
      showToast('error', `${t('ETL sync failed.')} ${err}`);
    } finally {
      setRunningSync(false);
    }
  };

  const handleDecideChange = async (changeIds: number[], decision: 'approve' | 'reject') => {
    const key = changeIds.join(',');
    setBusyAction(key);
    try {
      const res = await authFetch(`${apiBase}/api/etl/approvals/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ change_ids: changeIds, decision })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast('success', t('Decisions saved successfully.'));
      setSelectedChanges(prev => {
        const next = new Set(prev);
        changeIds.forEach(id => next.delete(id));
        return next;
      });
      await fetchStatus(false);
    } catch (err) {
      console.error('Failed to submit change decision:', err);
      showToast('error', t('Failed to save decision.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDecideCorrection = async (pairId: number, decision: 'approve' | 'reject') => {
    setBusyAction(`pair-${pairId}`);
    try {
      const res = await authFetch(`${apiBase}/api/etl/approvals/correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair_id: pairId, decision })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast('success', t('Decisions saved successfully.'));
      await fetchStatus(false);
    } catch (err) {
      console.error('Failed to submit correction decision:', err);
      showToast('error', t('Failed to save decision.'));
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSelectChange = (id: number) => {
    setSelectedChanges(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllChanges = () => {
    if (selectedChanges.size === stagedChanges.length) {
      setSelectedChanges(new Set());
    } else {
      setSelectedChanges(new Set(stagedChanges.map(c => c.change_id)));
    }
  };

  const latestRun = runs[0];
  const pendingCount = stagedChanges.length + correctionPairs.length;

  const availableProjects = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      if (p.project_id) {
        map.set(
          p.project_id,
          p.project_name && p.project_name !== p.project_id
            ? `${p.project_id} (${p.project_name})`
            : p.project_id
        );
      }
    }
    for (const c of stagedChanges) {
      if (c.project_id && !map.has(c.project_id)) {
        map.set(c.project_id, c.project_id);
      }
    }
    for (const cp of correctionPairs) {
      if (cp.project_id && !map.has(cp.project_id)) {
        map.set(cp.project_id, cp.project_id);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, label]) => ({ id, label }));
  }, [projects, stagedChanges, correctionPairs]);

  const formatDuration = (start: string | null, finish: string | null) => {
    if (!start || !finish) return '-';
    const s = new Date(start).getTime();
    const f = new Date(finish).getTime();
    const sec = Math.max(0, Math.round((f - s) / 1000));
    return `${sec}s`;
  };

  const formatTime = (ts: string | null) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  };

  return (
    <div className="permission-overlay" onClick={onClose}>
      <div 
        className="permission-dialog etl-dialog" 
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="etl-dialog-title"
      >
        {/* Header */}
        <div className="permission-dialog-head etl-head">
          <div className="etl-head-left">
            <Database size={20} className="etl-accent-icon" aria-hidden="true" />
            <h3 id="etl-dialog-title">{t('ETL Pipeline & Approvals')}</h3>
            {pendingCount > 0 && (
              <span className="sidebar-item-badge etl-pending-badge">
                {pendingCount} {t('Pending Changes')}
              </span>
            )}
          </div>
          <div className="etl-head-actions">
            <button
              type="button"
              className="report-close"
              onClick={() => fetchStatus(false)}
              disabled={loading}
              title={t('Refresh')}
              aria-label={t('Refresh')}
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              className="report-close"
              onClick={onClose}
              title={t('Close')}
              aria-label={t('Close')}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Quick KPI / Overview Ribbon */}
        <div className="etl-metrics-grid">
          <div className="etl-metric-card">
            <div className="etl-metric-title">
              <Activity size={14} />
              <span>{t('Last Run')}</span>
            </div>
            <div className="etl-metric-val">
              {latestRun ? (
                <>
                  <span className={`etl-status-pill etl-status-${latestRun.status}`}>
                    {latestRun.status === 'ok' ? 'OK' : latestRun.status.toUpperCase()}
                  </span>
                  <span className="etl-metric-sub">
                    #{latestRun.run_id} ({formatDuration(latestRun.started_at, latestRun.finished_at)})
                  </span>
                </>
              ) : '-'}
            </div>
          </div>

          <div className="etl-metric-card">
            <div className="etl-metric-title">
              <Layers size={14} />
              <span>{t('Staged Changes')}</span>
            </div>
            <div className="etl-metric-val">
              <span className="etl-num">{stagedChanges.length}</span>
              <span className="etl-metric-sub">{t('attributes')}</span>
            </div>
          </div>

          <div className="etl-metric-card">
            <div className="etl-metric-title">
              <Clock size={14} />
              <span>{t('Coordinate Corrections')}</span>
            </div>
            <div className="etl-metric-val">
              <span className="etl-num">{correctionPairs.length}</span>
              <span className="etl-metric-sub">{t('shifts')}</span>
            </div>
          </div>

          <div className="etl-metric-card">
            <div className="etl-metric-title">
              <ShieldCheck size={14} />
              <span>{t('Pipeline Health')}</span>
            </div>
            <div className="etl-metric-val">
              <span className={`etl-status-pill etl-status-${health?.status === 'healthy' ? 'ok' : health?.status === 'degraded' ? 'skipped' : health?.status === 'unhealthy' ? 'failed' : 'pending'}`}>
                {health?.status ? health.status.toUpperCase() : 'UNKNOWN'}
              </span>
              {health?.database_latency_ms != null && (
                <span className="etl-metric-sub">
                  {health.database_latency_ms} ms ping
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Sync Trigger Action Bar */}
        <div className="etl-run-bar">
          <div className="etl-run-controls">
            <div className="etl-control-group">
              <label htmlFor="etl-project-select" className="etl-control-label">{t('Project')}:</label>
              <select
                id="etl-project-select"
                className="etl-select"
                value={syncProject}
                onChange={e => setSyncProject(e.target.value)}
                disabled={runningSync}
              >
                <option value="">{t('All Projects')}</option>
                {availableProjects.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            <label className="etl-checkbox-label">
              <input
                type="checkbox"
                checked={forceSync}
                onChange={e => setForceSync(e.target.checked)}
                disabled={runningSync}
              />
              <span>{t('Force sync (bypass cache)')}</span>
            </label>
          </div>

          <button
            type="button"
            className="permission-btn permission-btn-primary etl-run-btn"
            onClick={handleTriggerRun}
            disabled={runningSync}
          >
            {runningSync ? (
              <RefreshCw size={15} className="animate-spin" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
            <span>{runningSync ? t('Running Sync...') : t('Run Sync Now')}</span>
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="etl-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'changes'}
            className={`etl-tab ${activeTab === 'changes' ? 'active' : ''}`}
            onClick={() => setActiveTab('changes')}
          >
            {t('Staged Changes')}
            {stagedChanges.length > 0 && (
              <span className="etl-tab-badge">{stagedChanges.length}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'corrections'}
            className={`etl-tab ${activeTab === 'corrections' ? 'active' : ''}`}
            onClick={() => setActiveTab('corrections')}
          >
            {t('Coordinate Corrections')}
            {correctionPairs.length > 0 && (
              <span className="etl-tab-badge">{correctionPairs.length}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'runs'}
            className={`etl-tab ${activeTab === 'runs' ? 'active' : ''}`}
            onClick={() => setActiveTab('runs')}
          >
            {t('Runs & Health')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'history'}
            className={`etl-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('history');
              fetchHistory(historySearch);
            }}
          >
            <History size={14} style={{ marginRight: '6px', verticalAlign: '-2px' }} />
            {t('Audit History')}
          </button>
        </div>

        {/* Tab 1: Staged Changes */}
        {activeTab === 'changes' && (
          <div className="etl-tab-content">
            {stagedChanges.length === 0 ? (
              <div className="etl-empty-state">
                <CheckCircle2 size={32} className="etl-empty-icon success" />
                <p>{t('No staged attribute changes pending review.')}</p>
              </div>
            ) : (
              <>
                <div className="etl-bulk-bar">
                  <label className="etl-select-all">
                    <input
                      type="checkbox"
                      checked={selectedChanges.size > 0 && selectedChanges.size === stagedChanges.length}
                      onChange={toggleSelectAllChanges}
                    />
                    <span>
                      {selectedChanges.size > 0 
                        ? `${selectedChanges.size} ${t('Selected')}`
                        : t('Select All')}
                    </span>
                  </label>
                  {selectedChanges.size > 0 && (
                    <div className="etl-bulk-actions">
                      <button
                        type="button"
                        className="permission-btn permission-btn-primary"
                        onClick={() => handleDecideChange(Array.from(selectedChanges), 'approve')}
                        disabled={busyAction !== null}
                      >
                        <Check size={14} />
                        {t('Approve Selected')} ({selectedChanges.size})
                      </button>
                      <button
                        type="button"
                        className="permission-btn"
                        onClick={() => handleDecideChange(Array.from(selectedChanges), 'reject')}
                        disabled={busyAction !== null}
                      >
                        <Ban size={14} />
                        {t('Reject Selected')}
                      </button>
                    </div>
                  )}
                </div>

                <div className="etl-table-wrap">
                  <table className="etl-table">
                    <thead>
                      <tr>
                        <th style={{ width: '36px' }}></th>
                        <th>{t('Project')}</th>
                        <th>{t('Target ID')} / {t('VM Nr')}</th>
                        <th>{t('Field')}</th>
                        <th>{t('Old Value')}</th>
                        <th style={{ width: '20px' }}></th>
                        <th>{t('New Value')}</th>
                        <th>{t('Actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stagedChanges.map(change => {
                        const isSelected = selectedChanges.has(change.change_id);
                        const isBusy = busyAction === String(change.change_id);
                        return (
                          <tr key={change.change_id} className={isSelected ? 'selected' : ''}>
                            <td>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelectChange(change.change_id)}
                              />
                            </td>
                            <td>
                              <span className="etl-code">{change.project_id}</span>
                            </td>
                            <td>
                              <strong>{change.vm_nr}</strong>
                              <div className="etl-sub-target">{change.anomaly_id}</div>
                            </td>
                            <td>
                              <span className="etl-field-pill">{change.column_name}</span>
                            </td>
                            <td className="etl-old-val">{change.old_value ?? 'NULL'}</td>
                            <td className="etl-arrow"><ArrowRight size={14} /></td>
                            <td className="etl-new-val">{change.new_value ?? 'NULL'}</td>
                            <td>
                              <div className="etl-row-actions">
                                <button
                                  type="button"
                                  className="etl-action-btn approve"
                                  onClick={() => handleDecideChange([change.change_id], 'approve')}
                                  disabled={isBusy || busyAction !== null}
                                  title={t('Approve')}
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="etl-action-btn reject"
                                  onClick={() => handleDecideChange([change.change_id], 'reject')}
                                  disabled={isBusy || busyAction !== null}
                                  title={t('Reject')}
                                >
                                  <Ban size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 2: Coordinate Corrections */}
        {activeTab === 'corrections' && (
          <div className="etl-tab-content">
            {correctionPairs.length === 0 ? (
              <div className="etl-empty-state">
                <CheckCircle2 size={32} className="etl-empty-icon success" />
                <p>{t('No coordinate shift candidates pending review.')}</p>
              </div>
            ) : (
              <div className="etl-table-wrap">
                <table className="etl-table">
                  <thead>
                    <tr>
                      <th>{t('Project')}</th>
                      <th>{t('Target ID')} / {t('VM Nr')}</th>
                      <th>{t('Distance')}</th>
                      <th>{t('Match Rule')}</th>
                      <th>{t('Existing Coordinates')}</th>
                      <th style={{ width: '20px' }}></th>
                      <th>{t('New Source Coordinates')}</th>
                      <th>{t('Actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {correctionPairs.map(pair => {
                      const isBusy = busyAction === `pair-${pair.pair_id}`;
                      return (
                        <tr key={pair.pair_id}>
                          <td>
                            <span className="etl-code">{pair.project_id}</span>
                          </td>
                          <td>
                            <strong>{pair.old_vm_nr}</strong>
                            <div className="etl-sub-target">{pair.old_anomaly_id}</div>
                          </td>
                          <td>
                            <span className="etl-dist-badge">
                              {pair.distance_m.toFixed(3)} m
                            </span>
                          </td>
                          <td>
                            <span className="etl-field-pill">{pair.matched_by}</span>
                          </td>
                          <td className="etl-coords">
                            {pair.old_easting.toFixed(3)}, {pair.old_northing.toFixed(3)}
                          </td>
                          <td className="etl-arrow"><ArrowRight size={14} /></td>
                          <td className="etl-coords etl-new-coords">
                            {pair.new_easting.toFixed(3)}, {pair.new_northing.toFixed(3)}
                          </td>
                          <td>
                            <div className="etl-row-actions">
                              <button
                                type="button"
                                className="etl-action-btn approve"
                                onClick={() => handleDecideCorrection(pair.pair_id, 'approve')}
                                disabled={isBusy || busyAction !== null}
                                title={t('Approve')}
                              >
                                <Check size={14} />
                              </button>
                              <button
                                type="button"
                                className="etl-action-btn reject"
                                onClick={() => handleDecideCorrection(pair.pair_id, 'reject')}
                                disabled={isBusy || busyAction !== null}
                                title={t('Reject')}
                              >
                                <Ban size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Runs & Execution Health */}
        {activeTab === 'runs' && (
          <div className="etl-tab-content">
            {!runAnalytics || runAnalytics.totalRuns === 0 ? (
              <div className="etl-empty-state">
                <AlertTriangle size={32} className="etl-empty-icon" />
                <p>{t('No pipeline runs recorded.')}</p>
              </div>
            ) : (
              <>
                {/* 1. Execution Summary Cards */}
                <div className="etl-metrics-grid" style={{ marginBottom: 'var(--space-3)' }}>
                  <div className="etl-metric-card">
                    <div className="etl-metric-title">
                      <Clock size={14} />
                      <span>{t('Avg Duration')}</span>
                    </div>
                    <div className="etl-metric-val">
                      <span className="etl-num">{runAnalytics.avgDuration}s</span>
                      <span className="etl-metric-sub">max {runAnalytics.maxDuration.toFixed(1)}s</span>
                    </div>
                  </div>

                  <div className="etl-metric-card">
                    <div className="etl-metric-title">
                      <TrendingUp size={14} />
                      <span>{t('Success Rate')}</span>
                    </div>
                    <div className="etl-metric-val">
                      <span className="etl-num" style={{ color: runAnalytics.successRate >= 90 ? 'var(--color-primary, #16a34a)' : '#eab308' }}>
                        {runAnalytics.successRate}%
                      </span>
                      <span className="etl-metric-sub">{runAnalytics.okCount} ok, {runAnalytics.failedCount} fail</span>
                    </div>
                  </div>

                  <div className="etl-metric-card">
                    <div className="etl-metric-title">
                      <Database size={14} />
                      <span>{t('Total Merged')}</span>
                    </div>
                    <div className="etl-metric-val">
                      <span className="etl-num">{runAnalytics.totalWritten}</span>
                      <span className="etl-metric-sub">{runAnalytics.totalStaged} staged</span>
                    </div>
                  </div>

                  <div className="etl-metric-card">
                    <div className="etl-metric-title">
                      <Activity size={14} />
                      <span>{t('Total Runs')}</span>
                    </div>
                    <div className="etl-metric-val">
                      <span className="etl-num">{runAnalytics.totalRuns}</span>
                      <span className="etl-metric-sub">{runAnalytics.skippedCount} skipped</span>
                    </div>
                  </div>
                </div>

                {/* 2. Visual Charts Container */}
                <div className="etl-charts-container">
                  {/* Chart 1: Execution Duration Trend */}
                  <div className="etl-chart-card">
                    <div className="etl-chart-header">
                      <div>
                        <div className="etl-chart-title">
                          <BarChart2 size={13} style={{ marginRight: '6px', verticalAlign: '-1px' }} />
                          {t('Duration Trend (Seconds)')}
                        </div>
                        <div className="etl-chart-subtitle">
                          {t('Last')} {runAnalytics.chronologicalRuns.length} {t('Runs')}
                        </div>
                      </div>
                      <div className="etl-chart-legend">
                        <span className="etl-legend-dot ok"></span> OK
                        <span className="etl-legend-dot skipped"></span> {t('Skipped')}
                        <span className="etl-legend-dot failed"></span> {t('Failed')}
                      </div>
                    </div>

                    <div className="etl-svg-chart-wrap">
                      <svg viewBox="0 0 540 120" className="etl-trend-svg" preserveAspectRatio="none">
                        {/* Grid lines */}
                        <line x1="40" y1="20" x2="530" y2="20" stroke="var(--surface-border)" strokeDasharray="3 3" />
                        <text x="35" y="23" textAnchor="end" className="etl-svg-label">{runAnalytics.maxDuration.toFixed(1)}s</text>

                        <line x1="40" y1="65" x2="530" y2="65" stroke="var(--surface-border)" strokeDasharray="3 3" />
                        <text x="35" y="68" textAnchor="end" className="etl-svg-label">{(runAnalytics.maxDuration / 2).toFixed(1)}s</text>

                        <line x1="40" y1="105" x2="530" y2="105" stroke="var(--surface-border)" />
                        <text x="35" y="108" textAnchor="end" className="etl-svg-label">0s</text>

                        {/* Bars & Points */}
                        {runAnalytics.chronologicalRuns.map((r, i) => {
                          const n = Math.max(1, runAnalytics.chronologicalRuns.length - 1);
                          const x = 50 + (i / n) * 460;
                          const barH = Math.max(4, (r.durationSec / runAnalytics.maxDuration) * 85);
                          const y = 105 - barH;
                          const isHovered = hoveredRun?.run_id === r.run_id;
                          const color = r.status === 'ok' ? '#10b981' : (r.status === 'skipped' ? '#f59e0b' : '#ef4444');

                          return (
                            <g
                              key={r.run_id}
                              className="etl-svg-bar-group"
                              onMouseEnter={() => setHoveredRun(r)}
                              onMouseLeave={() => setHoveredRun(null)}
                            >
                              <rect
                                x={x - 6}
                                y={y}
                                width={12}
                                height={barH}
                                rx={3}
                                fill={color}
                                opacity={isHovered ? 1 : 0.8}
                                className="etl-svg-bar"
                              />
                              {isHovered && (
                                <circle cx={x} cy={y} r={4} fill="#ffffff" stroke={color} strokeWidth={2} />
                              )}
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  </div>

                  {/* Chart 2: Ingestion Volume & Staged Changes */}
                  <div className="etl-chart-card">
                    <div className="etl-chart-header">
                      <div>
                        <div className="etl-chart-title">{t('Ingestion Volume & Staged Changes')}</div>
                        <div className="etl-chart-subtitle">
                          {t('Rows Written')} vs. {t('Pending Changes')}
                        </div>
                      </div>
                      <div className="etl-chart-legend">
                        <span className="etl-legend-dot written"></span> {t('Rows Written')}
                        <span className="etl-legend-dot staged"></span> {t('Pending Changes')}
                      </div>
                    </div>

                    <div className="etl-svg-chart-wrap">
                      <svg viewBox="0 0 540 120" className="etl-trend-svg" preserveAspectRatio="none">
                        {/* Grid lines */}
                        <line x1="40" y1="20" x2="530" y2="20" stroke="var(--surface-border)" strokeDasharray="3 3" />
                        <text x="35" y="23" textAnchor="end" className="etl-svg-label">{runAnalytics.maxVolume}</text>

                        <line x1="40" y1="65" x2="530" y2="65" stroke="var(--surface-border)" strokeDasharray="3 3" />
                        <text x="35" y="68" textAnchor="end" className="etl-svg-label">{Math.round(runAnalytics.maxVolume / 2)}</text>

                        <line x1="40" y1="105" x2="530" y2="105" stroke="var(--surface-border)" />
                        <text x="35" y="108" textAnchor="end" className="etl-svg-label">0</text>

                        {/* Dual Bars */}
                        {runAnalytics.chronologicalRuns.map((r, i) => {
                          const n = Math.max(1, runAnalytics.chronologicalRuns.length - 1);
                          const x = 50 + (i / n) * 460;
                          const writtenH = Math.max(r.written > 0 ? 4 : 0, (r.written / runAnalytics.maxVolume) * 85);
                          const stagedH = Math.max(r.staged > 0 ? 4 : 0, (r.staged / runAnalytics.maxVolume) * 85);
                          const isHovered = hoveredRun?.run_id === r.run_id;

                          return (
                            <g
                              key={r.run_id}
                              className="etl-svg-bar-group"
                              onMouseEnter={() => setHoveredRun(r)}
                              onMouseLeave={() => setHoveredRun(null)}
                            >
                              {/* Written bar */}
                              <rect
                                x={x - 6}
                                y={105 - writtenH}
                                width={5}
                                height={writtenH}
                                rx={2}
                                fill="#3b82f6"
                                opacity={isHovered ? 1 : 0.85}
                              />
                              {/* Staged bar */}
                              <rect
                                x={x}
                                y={105 - stagedH}
                                width={5}
                                height={stagedH}
                                rx={2}
                                fill="#f97316"
                                opacity={isHovered ? 1 : 0.85}
                              />
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  </div>
                </div>

                {/* 3. Outcome Distribution Bar & Active Hover Tooltip */}
                <div className="etl-distribution-container">
                  <div className="etl-distribution-bar-wrap">
                    <div className="etl-distribution-label">{t('Outcome Distribution')}</div>
                    <div className="etl-distribution-bar">
                      <div className="etl-dist-segment ok" style={{ width: `${runAnalytics.okRate}%` }} title={`OK: ${runAnalytics.okCount}`} />
                      <div className="etl-dist-segment skipped" style={{ width: `${runAnalytics.skippedRate}%` }} title={`Skipped: ${runAnalytics.skippedCount}`} />
                      <div className="etl-dist-segment failed" style={{ width: `${runAnalytics.failedRate}%` }} title={`Failed: ${runAnalytics.failedCount}`} />
                    </div>
                    <div className="etl-distribution-stats">
                      <span><strong>{runAnalytics.okCount}</strong> {t('Successful')} ({runAnalytics.okRate}%)</span>
                      <span><strong>{runAnalytics.skippedCount}</strong> {t('Skipped')} ({runAnalytics.skippedRate}%)</span>
                      <span><strong>{runAnalytics.failedCount}</strong> {t('Failed')} ({runAnalytics.failedRate}%)</span>
                    </div>
                  </div>

                  {hoveredRun && (
                    <div className="etl-hover-card">
                      <div className="etl-hover-header">
                        <strong>Run #{hoveredRun.run_id}</strong>
                        <span className={`etl-status-pill etl-status-${hoveredRun.status}`}>
                          {hoveredRun.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="etl-hover-meta">
                        <div>{formatTime(hoveredRun.started_at)} • <strong>{hoveredRun.durationSec.toFixed(2)}s</strong></div>
                        <div>{t('Rows Written')}: {hoveredRun.written} | {t('Pending Changes')}: {hoveredRun.staged}</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* 4. Filter Buttons & Runs Table */}
                <div className="etl-run-filter-bar">
                  <div className="etl-run-filter-title">{t('Run History')}</div>
                  <div className="etl-run-filter-buttons">
                    <button
                      type="button"
                      className={`etl-filter-btn ${runFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setRunFilter('all')}
                    >
                      {t('All')} ({runAnalytics.totalRuns})
                    </button>
                    <button
                      type="button"
                      className={`etl-filter-btn ok ${runFilter === 'ok' ? 'active' : ''}`}
                      onClick={() => setRunFilter('ok')}
                    >
                      {t('Successful')} ({runAnalytics.okCount})
                    </button>
                    <button
                      type="button"
                      className={`etl-filter-btn skipped ${runFilter === 'skipped' ? 'active' : ''}`}
                      onClick={() => setRunFilter('skipped')}
                    >
                      {t('Skipped')} ({runAnalytics.skippedCount})
                    </button>
                    <button
                      type="button"
                      className={`etl-filter-btn failed ${runFilter === 'failed' ? 'active' : ''}`}
                      onClick={() => setRunFilter('failed')}
                    >
                      {t('Failed')} ({runAnalytics.failedCount})
                    </button>
                  </div>
                </div>

                <div className="etl-table-wrap">
                  <table className="etl-table">
                    <thead>
                      <tr>
                        <th>{t('Run ID')}</th>
                        <th>{t('Status')}</th>
                        <th>{t('Started')}</th>
                        <th>{t('Duration')}</th>
                        <th>{t('Execution Metrics')} / Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRuns.map(run => {
                        const summary = (run.summary || {}) as Record<string, unknown>;
                        const isOk = run.status === 'ok';
                        const isSkipped = run.status === 'skipped';
                        const isFailed = run.status === 'failed';
                        
                        let details = '-';
                        if (isSkipped) {
                          details = typeof summary.reason === 'string' ? summary.reason : t('Skipped');
                        } else if (isFailed) {
                          details = typeof summary.error === 'string' ? summary.error : t('Failed');
                        } else if (isOk) {
                          details = `${t('Rows Written')}: ${run.written} | ${t('Pending Changes')}: ${run.staged}`;
                        }

                        return (
                          <tr key={run.run_id} className={hoveredRun?.run_id === run.run_id ? 'selected' : ''}>
                            <td><strong>#{run.run_id}</strong></td>
                            <td>
                              <span className={`etl-status-pill etl-status-${run.status}`}>
                                {run.status.toUpperCase()}
                              </span>
                              {run.forced && (
                                <span className="etl-tag-forced">forced</span>
                              )}
                            </td>
                            <td className="etl-timestamp">{formatTime(run.started_at)}</td>
                            <td className="etl-duration">{formatDuration(run.started_at, run.finished_at)}</td>
                            <td className="etl-run-details">
                              <code>{details}</code>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 4: Audit History (SCD Type 2) */}
        {activeTab === 'history' && (
          <div className="etl-tab-content">
            <div className="etl-history-search-bar">
              <Search size={15} className="text-muted" />
              <input
                type="text"
                className="etl-history-input"
                placeholder={t('Filter by Target ID, VM Nr, or Reason...')}
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') fetchHistory(historySearch);
                }}
              />
              <button
                type="button"
                className="permission-btn"
                style={{ padding: '2px 8px', fontSize: '12px' }}
                onClick={() => fetchHistory(historySearch)}
                disabled={loadingHistory}
              >
                {loadingHistory ? <RefreshCw size={12} className="animate-spin" /> : t('Search')}
              </button>
            </div>

            {loadingHistory ? (
              <div className="etl-empty-state">
                <RefreshCw size={24} className="animate-spin etl-empty-icon" />
                <p>{t('Loading...')}</p>
              </div>
            ) : historyRecords.length === 0 ? (
              <div className="etl-empty-state">
                <History size={32} className="etl-empty-icon" />
                <p>{t('No audit history records found.')}</p>
              </div>
            ) : (
              <div className="etl-table-wrap">
                <table className="etl-table">
                  <thead>
                    <tr>
                      <th>{t('Version')}</th>
                      <th>{t('Target ID')} / {t('VM Nr')}</th>
                      <th>{t('Project')}</th>
                      <th>Easting / Northing</th>
                      <th>{t('Evaluated Depth')}</th>
                      <th>{t('Category')} / {t('Layer')}</th>
                      <th>{t('Reason')}</th>
                      <th>{t('Valid From')}</th>
                      <th>{t('Valid To')}</th>
                      <th>{t('Decided By')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRecords.filter(r => {
                      if (!historySearch.trim()) return true;
                      const q = historySearch.toLowerCase();
                      return (
                        (r.target_id && r.target_id.toLowerCase().includes(q)) ||
                        (r.vm_nr && r.vm_nr.toLowerCase().includes(q)) ||
                        (r.change_reason && r.change_reason.toLowerCase().includes(q)) ||
                        (r.project_id && r.project_id.toLowerCase().includes(q))
                      );
                    }).map(r => (
                      <tr key={r.history_id} className={r.is_current ? 'selected' : ''}>
                        <td>
                          <span className={`etl-history-badge ${r.is_current ? 'current' : 'historical'}`}>
                            {r.is_current ? t('Current') : t('Historical')}
                          </span>
                        </td>
                        <td>
                          <strong>{r.vm_nr || '-'}</strong>
                          <div className="etl-sub-target">{r.target_id}</div>
                        </td>
                        <td><span className="etl-code">{r.project_id}</span></td>
                        <td className="etl-coords">
                          {r.easting != null ? r.easting.toFixed(3) : '-'}, {r.northing != null ? r.northing.toFixed(3) : '-'}
                        </td>
                        <td>{r.evaluated_depth != null ? `${r.evaluated_depth} m` : '-'}</td>
                        <td>
                          {r.category && <span className="etl-field-pill">{r.category}</span>}
                          {r.layer && <div className="etl-sub-target">{r.layer}</div>}
                        </td>
                        <td>
                          <span className="etl-reason-pill">{r.change_reason}</span>
                          {r.decision_id != null && (
                            <span className="etl-metric-sub" style={{ display: 'block' }}>
                              #{r.decision_id}
                            </span>
                          )}
                        </td>
                        <td className="etl-timestamp">{formatTime(r.valid_from)}</td>
                        <td className="etl-timestamp">{formatTime(r.valid_to)}</td>
                        <td className="etl-metric-sub">{r.changed_by || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="permission-actions etl-footer">
          <span className="etl-footer-note">
            {t('Auto-refreshing')} • {t('Decisions execute with etl_approver privileges')}
          </span>
          <button type="button" className="permission-btn" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  );
};
