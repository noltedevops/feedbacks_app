import { useLayoutEffect, useRef } from 'react';
import { Compass, BarChart3, Lock, ArrowRight } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import type { Access, Surface } from '../auth';

/**
 * The post-login home page, reached by signing in or by the logo in the rail.
 *
 * A short introduction and the way into a guided tour of each surface this account
 * can open. It describes nothing the tour can show: the tour runs on the live app,
 * so it cannot fall out of date the way a written or screenshotted description does.
 *
 * It needs no permission and calls no API. That is what makes it safe as the landing
 * view for every account, including one holding neither flag, and as the fallback arm
 * of the router.
 */

interface OverviewProps {
  lang: AppLang;
  access: Access;
  /** Opens the surface and starts its tour. */
  onStartTour: (surface: Surface) => void;
  /** App.tsx's openSurface: here only for the request dialog of a locked surface. */
  onOpenSurface: (surface: Surface) => void;
}

export function Overview({ lang, access, onStartTour, onOpenSurface }: OverviewProps) {
  const t = makeT(lang);
  const rootRef = useRef<HTMLElement | null>(null);

  // Sections rise in once, on first paint.
  //
  // The hidden state is gated on `js-reveal`, which is added here: a decorative
  // animation must never be able to hide the page, so if this effect does not run at
  // all, nothing is ever hidden. It can also fail the other way - an occluded or
  // throttled tab produces no frames, so the observer never fires - and the timer is
  // the floor under that.
  //
  // Layout effect so `js-reveal` lands before the first paint; added afterwards it
  // would show the content and then hide it again, one frame later.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>('.reveal')];
    const revealAll = () => items.forEach(el => el.classList.add('is-visible'));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduced || typeof IntersectionObserver === 'undefined') {
      revealAll();
      return;
    }

    root.classList.add('js-reveal');
    const io = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      }),
      { threshold: 0.05 }
    );
    items.forEach(el => io.observe(el));

    const failsafe = window.setTimeout(revealAll, 1200);
    return () => { window.clearTimeout(failsafe); io.disconnect(); };
  }, [access.can_field, access.can_dashboard]);

  // A tour is offered only for a surface this account can open. Stricter than the
  // left rail on purpose: the rail shows a locked entry with a lock icon, this page
  // stays silent about a surface the user cannot reach. The one exception is an
  // account with neither flag, which would otherwise be left on a page with nothing
  // on it and no way forward.
  const hasNoSurface = !access.can_field && !access.can_dashboard;

  return (
    <main className="overview-main" ref={rootRef}>
      <div className="overview-inner">

        <header className="overview-hero reveal">
          <span className="overview-kicker">{t('UXO Target Sync Platform')}</span>
          <h1 className="overview-title">
            {t('Survey anomalies out to the crew, excavation results back to the office.')}
          </h1>
          <p className="overview-lead">
            {t('Geophysical surveys produce a list of anomalies - points that might be ordnance. This platform puts that list in front of the people who dig, records what each excavation actually found, and syncs it back to the office.')}
          </p>
        </header>

        {!hasNoSurface && (
          <section className="overview-tours reveal" aria-label={t('Guided tours')}>
            <div className="overview-tour-grid">
              {access.can_field && (
                <button type="button" className="overview-tour" onClick={() => onStartTour('field')}>
                  <span className="overview-tour-icon"><Compass size={20} aria-hidden="true" /></span>
                  <span className="overview-tour-name">{t('Field App')}</span>
                  <span className="overview-tour-covers">
                    {t('Finding a target, the map, the excavation form, offline and sync.')}
                  </span>
                  <span className="overview-tour-go">
                    {t('Take the Field App tour')}
                    <ArrowRight size={15} aria-hidden="true" />
                  </span>
                </button>
              )}

              {access.can_dashboard && (
                <button type="button" className="overview-tour" onClick={() => onStartTour('dashboard')}>
                  <span className="overview-tour-icon"><BarChart3 size={20} aria-hidden="true" /></span>
                  <span className="overview-tour-name">{t('Dashboard')}</span>
                  <span className="overview-tour-covers">
                    {t('Filtering, the charts, depth accuracy, generating a report.')}
                  </span>
                  <span className="overview-tour-go">
                    {t('Take the Dashboard tour')}
                    <ArrowRight size={15} aria-hidden="true" />
                  </span>
                </button>
              )}
            </div>

            <p className="overview-tours-note">
              {t('Each tour runs on the live app and takes about a minute. Leave it whenever you like, and take it again from here or from your profile menu.')}
            </p>
          </section>
        )}

        {hasNoSurface && (
          <section className="overview-section reveal" aria-labelledby="ov-access">
            <span className="overview-kicker">{t('Access')}</span>
            <h2 id="ov-access" className="overview-h2">{t('Your account has no surface yet')}</h2>
            <p className="overview-copy">
              {t('Access is granted per surface by an administrator. Ask for the one you need and they will decide on it.')}
            </p>
            <div className="overview-actions">
              <button type="button" className="btn-secondary" onClick={() => onOpenSurface('field')}>
                <Lock size={14} aria-hidden="true" />
                {t('Request the Field App')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => onOpenSurface('dashboard')}>
                <Lock size={14} aria-hidden="true" />
                {t('Request the Dashboard')}
              </button>
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
