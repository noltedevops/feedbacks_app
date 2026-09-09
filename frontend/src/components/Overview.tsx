import { Compass, BarChart3, Lock, ArrowRight } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import type { Access, Surface } from '../auth';

/**
 * The post-login home page.
 *
 * Orientation for someone who is already signed in - what the platform is for, and
 * how the surfaces they can open work. Not the public landing page, which lives in
 * App.tsx and is what an anonymous visitor sees.
 *
 * It needs no permission and calls no API. That is what makes it safe as the landing
 * view for every account, including one holding neither flag, and as the fallback arm
 * of the router.
 */

interface OverviewProps {
  lang: AppLang;
  access: Access;
  /** App.tsx's openSurface: opens the surface, or the request dialog when locked. */
  onOpenSurface: (surface: Surface) => void;
}

export function Overview({ lang, access, onOpenSurface }: OverviewProps) {
  const t = makeT(lang);

  // A surface section exists only if this account can open it. Stricter than the
  // left rail on purpose: the rail shows a locked entry with a lock icon, this page
  // stays silent about a surface the user cannot reach - no heading, no visual, no
  // button. The one exception is an account with neither flag, below, which would
  // otherwise be left on a page with nothing on it and no way forward.
  const hasNoSurface = !access.can_field && !access.can_dashboard;

  return (
    <main className="overview-main">
      <div className="overview-inner">

        <header className="overview-hero">
          <span className="overview-kicker">{t('UXO Target Sync Platform')}</span>
          <h1>{t('Survey anomalies out to the crew, excavation results back to the office.')}</h1>
          <p>
            {t('Geophysical surveys produce a list of anomalies - points that might be ordnance. This platform puts that list in front of the people who dig, records what each excavation actually found, and syncs it back to the office.')}
          </p>
        </header>

        {access.can_field && (
          <section className="overview-section">
            <div className="overview-section-body">
              <span className="overview-kicker">{t('Field App')}</span>
              <h2>{t('Log what the excavation found')}</h2>
              <p>
                {t('Browse and filter the targets for your survey area, open a point on the map, and record the excavation: Sohle-Status, Fundstück, actual depth, Länge/Breite/m³, photos and the Trupp & Geräte block.')}
              </p>
              <p>
                {t('It works with no network - targets are cached on the device and submissions queue locally until a connection returns.')}
              </p>
              {/* Orientation, not a route: no field-only account is offered the
                  dashboard anywhere on this page. */}
              {!access.can_dashboard && (
                <p>{t('Your results sync back to the office when the device is online.')}</p>
              )}
              <button type="button" className="btn-primary" onClick={() => onOpenSurface('field')}>
                <Compass size={16} />
                {t('Open the Field App')}
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {access.can_dashboard && (
          <section className="overview-section">
            <div className="overview-section-body">
              <span className="overview-kicker">{t('Dashboard')}</span>
              <h2>{t('Review what the crew brought back')}</h2>
              <p>
                {t('Progress, findings breakdown, Sohle split, evaluated-against-excavated depth accuracy and excavated volume, over the whole target set or any slice of it.')}
              </p>
              <p>
                {t('Filter by project, status, instrument or depth, then export the selection as CSV or as the site report PDF.')}
              </p>
              <button type="button" className="btn-primary" onClick={() => onOpenSurface('dashboard')}>
                <BarChart3 size={16} />
                {t('Open the Dashboard')}
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        )}

        {hasNoSurface && (
          <section className="overview-section">
            <div className="overview-section-body">
              <span className="overview-kicker">{t('Access')}</span>
              <h2>{t('Your account has no surface yet')}</h2>
              <p>
                {t('Access is granted per surface by an administrator. Ask for the one you need and they will decide on it.')}
              </p>
              <div className="overview-actions">
                <button type="button" className="btn-secondary" onClick={() => onOpenSurface('field')}>
                  <Lock size={14} />
                  {t('Request the Field App')}
                </button>
                <button type="button" className="btn-secondary" onClick={() => onOpenSurface('dashboard')}>
                  <Lock size={14} />
                  {t('Request the Dashboard')}
                </button>
              </div>
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
