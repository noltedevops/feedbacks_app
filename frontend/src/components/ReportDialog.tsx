import React, { useEffect, useState } from 'react';
import { FileText, Table2, X, Loader2 } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import { authFetch } from '../auth';

export interface ProjectOption {
  project_id: string;
  project_name: string;
}

interface ReportDialogProps {
  lang: AppLang;
  apiBase: string;
  /** Projects offered in the filter. Falls back to the API when empty. */
  projects: ProjectOption[];
  /** The field app only exports CSV; the dashboard also renders the PDF report. */
  allowPdf?: boolean;
  title?: string;
  onClose: () => void;
}

/**
 * Filter dialog shared by the dashboard report button and the field app CSV
 * export, so both offer exactly the same project + date-range filters.
 */
export const ReportDialog: React.FC<ReportDialogProps> = ({
  lang,
  apiBase,
  projects,
  allowPdf = false,
  title,
  onClose
}) => {
  const t = makeT(lang);
  const [projectId, setProjectId] = useState<string>(projects[0]?.project_id ?? '');
  const [start, setStart] = useState<string>('');
  const [end, setEnd] = useState<string>('');
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].project_id);
  }, [projects, projectId]);

  const rangeInvalid = Boolean(start && end && start > end);

  const download = async (kind: 'pdf' | 'csv') => {
    if (rangeInvalid) return;
    setBusy(kind);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (projectId) params.set('project_id', projectId);
      if (start) params.set('start', start);
      if (end) params.set('end', end);

      const res = await authFetch(`${apiBase}/api/reports/feedback.${kind}?${params.toString()}`);
      if (res.status === 403) {
        setError(t('You do not have permission to export reports.'));
        return;
      }
      if (!res.ok) throw new Error(`${res.status}`);

      // Read as a blob and click a temporary link so the browser keeps the
      // filename the server set in Content-Disposition.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kind === 'pdf' ? 'oeffnungsmassnahmen' : 'feedback'}-${projectId || 'alle'}${start ? `-${start}` : ''}${end ? `-${end}` : ''}.${kind}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      console.error(err);
      setError(t('Report generation failed. Check that the server is reachable.'));
    } finally {
      setBusy(null);
    }
  };

  const label: React.CSSProperties = { fontSize: '0.68rem', color: '#8c9f96', fontWeight: 700, display: 'block', marginBottom: '4px' };
  // Height and font only; the vertical padding is dropped by .form-input--compact, which
  // .form-input would otherwise apply on top of this height and clip the text.
  const field: React.CSSProperties = { fontSize: '0.75rem', height: '32px', width: '100%', boxSizing: 'border-box' };

  const selectedLabel = projectId
    ? projects.find((p) => p.project_id === projectId)?.project_name
    : '';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-panel"
        style={{ width: '100%', maxWidth: '420px', padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem', color: '#f1f5f9', fontWeight: 700 }}>
            {title || t('Generate Report')}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex' }}>
            <X size={18} />
          </button>
        </div>

        <div>
          <label style={label}>{t('Project ID')}</label>
          <select
            className="form-input form-input--compact"
            style={field}
            value={projectId}
            // The control can only show so much; hovering gives the whole value back.
            title={selectedLabel ? `${projectId} — ${selectedLabel}` : projectId || t('All Projects')}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('All Projects')}</option>
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.project_name ? `${p.project_id} — ${p.project_name}` : p.project_id}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={label}>{t('From')}</label>
            <input type="date" className="form-input form-input--compact" style={field} value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label style={label}>{t('To')}</label>
            <input type="date" className="form-input form-input--compact" style={field} value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <span style={{ fontSize: '0.65rem', color: '#64748b' }}>
          {t('Leave dates empty to include the whole period.')}
        </span>

        {rangeInvalid && (
          <span style={{ fontSize: '0.68rem', color: '#ef4444' }}>{t('The start date must be before the end date.')}</span>
        )}
        {error && <span style={{ fontSize: '0.68rem', color: '#ef4444' }}>{error}</span>}

        <div style={{ display: 'flex', gap: '8px' }}>
          {allowPdf && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || rangeInvalid}
              onClick={() => download('pdf')}
              style={{ flex: 1, padding: '9px', fontSize: '0.75rem', justifyContent: 'center', gap: '6px' }}
            >
              {busy === 'pdf' ? <Loader2 size={14} className="spin" /> : <FileText size={14} />}
              {t('Download PDF')}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null || rangeInvalid}
            onClick={() => download('csv')}
            style={{ flex: 1, padding: '9px', fontSize: '0.75rem', justifyContent: 'center', gap: '6px' }}
          >
            {busy === 'csv' ? <Loader2 size={14} className="spin" /> : <Table2 size={14} />}
            {t('Download CSV')}
          </button>
        </div>
      </div>
    </div>
  );
};
