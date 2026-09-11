import { CirclePlay } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import type { Access } from '../auth';
import { TOUR_NAME, type TourId } from './steps';

/**
 * The way back into a tour from the profile menu, desktop pop-up and mobile sheet
 * alike. Same rule as the Overview: a tour is offered only for a surface this account
 * can open, and an account with neither gets nothing here.
 */
export function TourLaunchers({ lang, access, onStart }: {
  lang: AppLang;
  access: Access;
  onStart: (tour: TourId) => void;
}) {
  const t = makeT(lang);
  const tours = (['field', 'dashboard'] as const).filter(s => (s === 'field' ? access.can_field : access.can_dashboard));
  if (tours.length === 0) return null;

  return (
    <div className="tour-launchers">
      <span className="tour-launchers-label">{t('Guided tours')}</span>
      {tours.map(s => (
        <button key={s} type="button" className="tour-launcher" onClick={() => onStart(s)}>
          <CirclePlay size={15} aria-hidden="true" />
          {t(TOUR_NAME[s])}
        </button>
      ))}
    </div>
  );
}
