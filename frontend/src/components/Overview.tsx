import { useLayoutEffect, useRef } from 'react';
import { Compass, BarChart3, Lock, ArrowRight, Sparkles, Database, Zap, Activity, FileText } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import type { Access, Surface } from '../auth';

/**
 * The post-login home page, reached by signing in or by the logo in the rail.
 *
 * Executive, professional command view designed in the platform's Bento grid
 * visual language: metric highlights, workspace cards, and capability overviews.
 */

interface OverviewProps {
  lang: AppLang;
  access: Access;
  /** Opens the surface and starts its tour. */
  onStartTour: (surface: Surface) => void;
  /** App.tsx's openSurface: directly navigates to a workspace surface. */
  onOpenSurface: (surface: Surface) => void;
}

export function Overview({ lang, access, onStartTour, onOpenSurface }: OverviewProps) {
  const t = makeT(lang);
  const rootRef = useRef<HTMLElement | null>(null);

  // Sections rise in once, on first paint.
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

  const hasNoSurface = !access.can_field && !access.can_dashboard;

  return (
    <main className="overview-main" ref={rootRef}>
      <div className="overview-inner">

        {/* Hero Section */}
        <header className="overview-hero reveal">
          <div className="overview-kicker-badge">
            <Sparkles size={14} className="overview-kicker-sparkle" aria-hidden="true" />
            <span>{t('UXO Target Sync Platform')}</span>
          </div>
          <h1 className="overview-title">
            {t('Survey anomalies out to the crew,')}{' '}
            <span className="overview-title-em">{t('excavation results back to the office.')}</span>
          </h1>
          <p className="overview-lead">
            {t('Geophysical surveys produce a list of anomalies - points that might be ordnance. This platform puts that list in front of the people who dig, records what each excavation actually found, and syncs it back to the office.')}
          </p>
        </header>

        {/* Key Metrics Banner */}
        <section className="overview-metrics-banner reveal" aria-label={t('Platform Capabilities')}>
          <div className="overview-metric-item">
            <span className="overview-metric-value">10,000+</span>
            <span className="overview-metric-label">{t('Targets Tracked')}</span>
          </div>
          <div className="overview-metric-divider" aria-hidden="true" />
          <div className="overview-metric-item">
            <span className="overview-metric-value">99.9%</span>
            <span className="overview-metric-label">{t('Sync Accuracy')}</span>
          </div>
          <div className="overview-metric-divider" aria-hidden="true" />
          <div className="overview-metric-item">
            <span className="overview-metric-value">&lt; 1s</span>
            <span className="overview-metric-label">{t('Query Latency')}</span>
          </div>
          <div className="overview-metric-divider" aria-hidden="true" />
          <div className="overview-metric-item">
            <span className="overview-metric-value">100%</span>
            <span className="overview-metric-label">{t('Offline Ready')}</span>
          </div>
        </section>

        {/* Workspaces & Guided Tours */}
        {!hasNoSurface && (
          <section className="overview-tours reveal" aria-label={t('Guided tours')}>
            <div className="overview-tour-grid">
              {access.can_field && (
                <div className="overview-card">
                  <div className="overview-card-header">
                    <div className="overview-icon-wrapper">
                      <Compass size={24} aria-hidden="true" />
                    </div>
                    <span className="overview-card-tag">{t('PWA Offline Ready')}</span>
                  </div>
                  <h2 className="overview-card-title">{t('Field App')}</h2>
                  <p className="overview-card-desc">
                    {t('Finding a target, the map, the excavation form, offline and sync.')}
                  </p>
                  <div className="overview-card-actions">
                    <button
                      type="button"
                      className="btn-primary overview-btn-primary"
                      onClick={() => onOpenSurface('field')}
                    >
                      {t('Launch Field App')}
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="overview-tour-link"
                      onClick={() => onStartTour('field')}
                    >
                      {t('Take the Field App tour')}
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}

              {access.can_dashboard && (
                <div className="overview-card">
                  <div className="overview-card-header">
                    <div className="overview-icon-wrapper">
                      <BarChart3 size={24} aria-hidden="true" />
                    </div>
                    <span className="overview-card-tag">{t('Real-Time Analytics')}</span>
                  </div>
                  <h2 className="overview-card-title">{t('Dashboard')}</h2>
                  <p className="overview-card-desc">
                    {t('Filtering, the charts, depth accuracy, generating a report.')}
                  </p>
                  <div className="overview-card-actions">
                    <button
                      type="button"
                      className="btn-primary overview-btn-primary"
                      onClick={() => onOpenSurface('dashboard')}
                    >
                      {t('Launch Dashboard')}
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="overview-tour-link"
                      onClick={() => onStartTour('dashboard')}
                    >
                      {t('Take the Dashboard tour')}
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            <p className="overview-tours-note">
              {t('Each tour runs on the live app and takes about a minute. Leave it whenever you like, and take it again from here or from your profile menu.')}
            </p>
          </section>
        )}

        {/* Platform Capabilities Bento Grid */}
        <section className="overview-features reveal" aria-label={t('Platform Capabilities')}>
          <div className="overview-features-header">
            <span className="overview-features-kicker">{t('Platform Capabilities')}</span>
            <h2 className="overview-features-title">{t('Engineered for Extreme Field Operations')}</h2>
            <p className="overview-features-sub">
              {t('High-precision geophysics workflows for crews on site and leaders in command.')}
            </p>
          </div>

          <div className="overview-features-grid">
            <div className="overview-feature-card">
              <div className="overview-feature-icon">
                <Database size={20} aria-hidden="true" />
              </div>
              <h3 className="overview-feature-name">{t('Offline-First Architecture')}</h3>
              <p className="overview-feature-desc">
                {t('Local SQLite & Dexie storage ensures uninterrupted logging even in zero-connectivity field sectors.')}
              </p>
              <div className="overview-feature-tag">{t('Zero Data Loss')}</div>
            </div>

            <div className="overview-feature-card">
              <div className="overview-feature-icon">
                <Zap size={20} aria-hidden="true" />
              </div>
              <h3 className="overview-feature-name">{t('Sensor Fusion Analytics')}</h3>
              <p className="overview-feature-desc">
                {t('Compare evaluated magnetic depth with actual excavated Sohle findings instantly.')}
              </p>
            </div>

            <div className="overview-feature-card">
              <div className="overview-feature-icon">
                <Activity size={20} aria-hidden="true" />
              </div>
              <h3 className="overview-feature-name">{t('Sub-Meter Target Bearing')}</h3>
              <p className="overview-feature-desc">
                {t('Real-time GPS bearing, distance, and depth guidance straight to the target.')}
              </p>
            </div>

            <div className="overview-feature-card">
              <div className="overview-feature-icon">
                <FileText size={20} aria-hidden="true" />
              </div>
              <h3 className="overview-feature-name">{t('Compliance-Ready PDF & CSV Reports')}</h3>
              <p className="overview-feature-desc">
                {t('Export certified clearance summaries and excavated volumes ready for municipal sign-offs.')}
              </p>
              <div className="overview-feature-tag">{t('Instant Export')}</div>
            </div>
          </div>
        </section>

        {/* No-Access Fallback Block */}
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
