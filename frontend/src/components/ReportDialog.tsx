import React, { useEffect, useState } from 'react';
import { FileText, Table2, X, Loader2 } from 'lucide-react';
import { Select } from './Select';
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

  const selectedLabel = projectId
    ? projects.find((p) => p.project_id === projectId)?.project_name
    : '';

  return (
    <div className="report-overlay" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="report-dialog"
        data-tour="report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
      >
        <div className="report-head">
          <h3 id="report-dialog-title" className="report-title">{title || t('Generate Report')}</h3>
          <button type="button" className="report-close" onClick={onClose} aria-label={t('Close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <label className="form-group">
          <span className="form-label">{t('Project ID')}</span>
          <Select
            className="report-field"
            value={projectId}
            onChange={setProjectId}
            ariaLabel={t('Project ID')}
            title={selectedLabel ? `${projectId} — ${selectedLabel}` : projectId || t('All Projects')}
            options={[
              { value: '', label: t('All Projects') },
              ...projects.map((p) => ({ value: p.project_id, label: p.project_id, description: p.project_name || undefined, group: t('Projects') }))
            ]}
          />
        </label>

        {/* minmax(0, 1fr) and a shrinkable input: a date input carries a wide intrinsic
            minimum, and in a plain 1fr track that is what pushed "To" past the dialog's
            edge at 390px. Stacks on the narrowest screens. */}
        <div className="report-dates">
          <label className="form-group">
            <span className="form-label">{t('From')}</span>
            <input type="date" className="form-input report-field" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="form-group">
            <span className="form-label">{t('To')}</span>
            <input type="date" className="form-input report-field" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        <span className="report-hint">{t('Leave dates empty to include the whole period.')}</span>

        {rangeInvalid && (
          <span className="report-error" role="alert">{t('The start date must be before the end date.')}</span>
        )}
        {error && <span className="report-error" role="alert">{error}</span>}

        <div className="report-actions">
          {allowPdf && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || rangeInvalid}
              onClick={() => download('pdf')}
            >
              {busy === 'pdf' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
              {t('Download PDF')}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null || rangeInvalid}
            onClick={() => download('csv')}
          >
            {busy === 'csv' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />}
            {t('Download CSV')}
          </button>
        </div>
      </div>
    </div>
  );
};
