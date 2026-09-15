import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowRight, ChevronDown, Menu, Moon, Sun, X } from 'lucide-react';
import { makeT, type AppLang, type Translator } from '../i18n';
import { LangSwitch } from './LangSwitch';

/**
 * The public landing page - the one surface a visitor sees before signing in.
 *
 * Laid out after mongodb.com's front page, measured rather than eyeballed: a
 * full-width header, an experience toggle above a centred hero - bold capitals, a
 * one-line subhead, two buttons - and below it the product the chosen experience
 * uses. Collector shows the Field App, Decision Maker the Dashboard; the toggle
 * swaps the headline, subhead, second button and the product section together, as
 * the reference swaps its hero. Colour, face and shape stay NOLTE; every colour is a
 * token.
 *
 * The sign-in dialog is rendered by App, next to this, because it owns the auth
 * state. Every entry point here - the header, the hero, the Platform menu, the
 * footer - just asks for it.
 */

interface LandingProps {
  lang: AppLang;
  onLangChange: (lang: AppLang) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onSignIn: () => void;
  onRequestAccess: () => void;
}

type Experience = 'collector' | 'decision';

interface ExperienceCopy {
  tab: string;
  title: [string, string];
  sub: string;
  open: string;
  kicker: string;
  heading: string;
  shotAlt: string;
  points: [title: string, desc: string][];
}

const ORDER: Experience[] = ['collector', 'decision'];

// The English strings are the i18n keys.
const EXPERIENCES: Record<Experience, ExperienceCopy> = {
  collector: {
    tab: 'Collector',
    title: ['Investigated before', "it's a problem"],
    sub: 'Find the next target, open its point and log the excavation - online or offline.',
    open: 'Open the Field App',
    kicker: 'Field data collection',
    heading: 'Built for the crew at the target.',
    shotAlt: 'The Field App: the target list beside the survey map',
    points: [
      ['Browse and filter targets', 'Narrow a survey by project, category, instrument and status, or search by VM number.'],
      ['Open a point', 'Each target on the map shows its evaluated depth and instrument, with the distance and bearing from where you stand.'],
      ['Log the excavation', 'Record the find, the depth actually dug, the size of the opening, the Sohle status and photos.'],
      ['Works offline', 'Targets and logs stay on the device and sync when the connection returns.'],
    ],
  },
  decision: {
    tab: 'Decision Maker',
    title: ['Every site.', 'One clear picture.'],
    sub: 'Follow clearance progress, compare sensor estimates with what was dug, and export reports.',
    open: 'Open the Dashboard',
    kicker: 'Operations dashboard',
    heading: 'Built for the people who sign off.',
    shotAlt: 'The Dashboard: clearance charts around the survey map',
    points: [
      ['Clearance analytics', 'Findings by type, Sohle status by finding and target dimensions, charted as the logs arrive.'],
      ['Progress at a glance', 'Targets investigated against pending, per project and category, with the excavated volume.'],
      ['Sensor accuracy', 'Evaluated depth against excavated depth, with mean error and estimation bias.'],
      ['Reports', 'Export the feedback log as PDF or CSV for any date range.'],
    ],
  },
};

export function Landing({ lang, onLangChange, theme, onToggleTheme, onSignIn, onRequestAccess }: LandingProps) {
  const t = makeT(lang);
  const [navOpen, setNavOpen] = useState(false);
  const [experience, setExperience] = useState<Experience>('collector');
  const baseId = useId();
  const tabId = (x: Experience) => `${baseId}-tab-${x}`;
  const panelId = `${baseId}-panel`;
  const headingId = `${baseId}-heading`;
  const xp = EXPERIENCES[experience];

  // Anything that opens the dialog also folds the phone menu away behind it.
  const signIn = () => { setNavOpen(false); onSignIn(); };
  const requestAccess = () => { setNavOpen(false); onRequestAccess(); };

  // Escape folds the phone menu, as it closes every other layer in the app.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const themeLabel = theme === 'dark' ? t('Switch to Light mode') : t('Switch to Dark mode');
  // Screenshots of the real app on demo data, one per experience, theme and language.
  const shot = `/landing/${experience}-${theme}-${lang === 'DE' ? 'de' : 'en'}.jpg`;

  return (
    <div className="landing-root">
      <header className={navOpen ? 'landing-header is-nav-open' : 'landing-header'}>
        <div className="landing-header-inner">
          <div className="brand-mark">
            <img src="/logo.png" alt="" className="brand-logo" />
            <span className="brand-name">Nolte Geoservices GmbH</span>
          </div>

          {/* Tablets and phones: everything but the brand folds into this menu. */}
          <button
            type="button"
            className="landing-burger"
            aria-label={t('Menu')}
            aria-expanded={navOpen}
            aria-controls="landing-sheet"
            onClick={() => setNavOpen(open => !open)}
          >
            {navOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <div className="landing-sheet" id="landing-sheet">
            <nav className="landing-nav" aria-label={t('Main navigation')}>
              <PlatformMenu t={t} onChoose={signIn} />
              <a className="nav-tab" href="https://www.nolteservices.com" target="_blank" rel="noopener noreferrer">
                {t('Company')}
              </a>
            </nav>

            <div className="landing-actions">
              <div className="landing-prefs">
                <LangSwitch lang={lang} onChange={onLangChange} />
                {/* The same control, state and stored key as the rail's inside the app. */}
                <button
                  type="button"
                  className="landing-theme-toggle"
                  onClick={onToggleTheme}
                  title={themeLabel}
                  aria-label={themeLabel}
                >
                  {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                </button>
              </div>
              <button type="button" className="btn-secondary landing-auth" onClick={signIn}>
                {t('Sign in')}
              </button>
              <button type="button" className="btn-primary landing-auth" onClick={requestAccess}>
                {t('Get access')}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="landing-main">
        <ExperienceToggle t={t} value={experience} onChange={setExperience} tabId={tabId} panelId={panelId} />

        <div className="landing-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(experience)}>
          {/* Keyed, so a switch fades the new copy in rather than swapping it hard. */}
          <div className="landing-hero" key={`hero-${experience}`}>
            <h1 className="landing-title">
              {t(xp.title[0])}{' '}
              <span className="landing-title-em">{t(xp.title[1])}</span>
            </h1>
            <p className="landing-sub">{t(xp.sub)}</p>
            <div className="landing-cta">
              <button type="button" className="btn-primary landing-cta-btn" onClick={onRequestAccess}>
                {t('Get early access')} <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button type="button" className="btn-secondary landing-cta-btn" onClick={onSignIn}>
                {t(xp.open)}
              </button>
            </div>
          </div>

          <section className="xp-section" key={`xp-${experience}`} aria-labelledby={headingId}>
            <figure className="xp-shot">
              <img src={shot} alt={t(xp.shotAlt)} width={1440} height={900} />
            </figure>
            <div className="xp-copy">
              <p className="xp-kicker">{t(xp.kicker)}</p>
              <h2 className="xp-heading" id={headingId}>{t(xp.heading)}</h2>
              <ul className="xp-points">
                {xp.points.map(([title, desc]) => (
                  <li key={title} className="xp-point">
                    <h3 className="xp-point-title">{t(title)}</h3>
                    <p className="xp-point-desc">{t(desc)}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </main>

      <footer className="site-footer">
        <div className="footer-inner">
          <div className="brand-mark brand-mark--sm">
            <img src="/logo.png" alt="" className="brand-logo" />
            <span className="brand-name">Nolte Geoservices GmbH</span>
          </div>
          <div className="footer-links">
            <button type="button" className="footer-link" onClick={onSignIn}>{t('Field App')}</button>
            <span className="footer-sep" aria-hidden="true"></span>
            <button type="button" className="footer-link" onClick={onSignIn}>{t('Dashboard')}</button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * The experience toggle: a tab list inside a pill, the selected tab marked by a
 * filled indicator that slides between the two. Arrow keys, Home and End move the
 * selection (tabs that select on focus - there are only two, both cheap to show).
 * The indicator is ink, not gold: a selection is a state, not an action.
 */
function ExperienceToggle({ t, value, onChange, tabId, panelId }: {
  t: Translator;
  value: Experience;
  onChange: (x: Experience) => void;
  tabId: (x: Experience) => string;
  panelId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<Experience, HTMLButtonElement | null>>>({});
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);

  // The indicator has to know the selected tab's box, which moves with the
  // language, the webfont arriving and the viewport - so it is observed, not read once.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const tab = tabRefs.current[value];
      if (tab) setIndicator({ x: tab.offsetLeft, w: tab.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    Object.values(tabRefs.current).forEach(el => { if (el) observer.observe(el, { box: 'border-box' }); });
    // The webfont arriving widens the tabs; measure again whenever a face lands.
    document.fonts.addEventListener('loadingdone', measure);
    document.fonts.ready.then(measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [value]);

  const onKey = (e: ReactKeyboardEvent) => {
    const i = ORDER.indexOf(value);
    const next =
      e.key === 'ArrowRight' ? ORDER[(i + 1) % ORDER.length] :
      e.key === 'ArrowLeft' ? ORDER[(i - 1 + ORDER.length) % ORDER.length] :
      e.key === 'Home' ? ORDER[0] :
      e.key === 'End' ? ORDER[ORDER.length - 1] :
      null;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="xp-toggle">
      <span className="xp-toggle-label" aria-hidden="true">{t('Select experience:')}</span>
      <div
        ref={listRef}
        className="xp-tabs"
        role="tablist"
        aria-label={t('Select experience')}
        onKeyDown={onKey}
        data-ready={indicator ? '' : undefined}
      >
        {indicator && (
          <span
            className="xp-indicator"
            aria-hidden="true"
            style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }}
          />
        )}
        {ORDER.map(x => (
          <button
            key={x}
            ref={el => { tabRefs.current[x] = el; }}
            id={tabId(x)}
            type="button"
            role="tab"
            aria-selected={x === value}
            aria-controls={panelId}
            tabIndex={x === value ? 0 : -1}
            className="xp-tab"
            onClick={() => onChange(x)}
          >
            {t(EXPERIENCES[x].tab)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The Platform menu: a menu button. Opens on a click, not a hover - a hover menu
 * cannot be opened by touch or kept open while the pointer crosses the gap. Arrow
 * keys move through it, Escape and a press outside close it, and focus returns to
 * the button. In the phone sheet the same menu opens in place, pushing the list down.
 */
function PlatformMenu({ t, onChoose }: { t: Translator; onChoose: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const focusOnOpen = useRef(0);
  const menuId = useId();

  const items = [t('Dashboard'), t('Field App')];

  const openAt = (index: number) => {
    focusOnOpen.current = index;
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (open) itemsRef.current[focusOnOpen.current]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); openAt(0); }
    if (e.key === 'ArrowUp') { e.preventDefault(); openAt(items.length - 1); }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const current = itemsRef.current.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => itemsRef.current[(i + items.length) % items.length]?.focus();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(current + 1); break;
      case 'ArrowUp': e.preventDefault(); move(current - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(items.length - 1); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
      case 'Tab': setOpen(false); break;
    }
  };

  return (
    <div className="nav-menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="nav-tab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKey}
      >
        {t('Platform')}
        <ChevronDown size={16} className="nav-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div id={menuId} className="nav-menu" role="menu" aria-label={t('Platform')} onKeyDown={onMenuKey}>
          {items.map((label, i) => (
            <button
              key={label}
              ref={el => { itemsRef.current[i] = el; }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="nav-menu-item"
              onClick={() => { setOpen(false); onChoose(); }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
