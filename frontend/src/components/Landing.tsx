import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowRight, ChevronDown, Menu, Moon, Pause, Play, Sun, X } from 'lucide-react';
import { makeT, type AppLang, type Translator } from '../i18n';
import { LangSwitch } from './LangSwitch';

/**
 * The public landing page - the one surface a visitor sees before signing in.
 *
 * Built like the rest of the app now: the page ground, a white header with a
 * hairline, a regular-weight headline set against the logo-yellow rule, the gold
 * button for the one action and an outlined one beside it. It follows the app's
 * theme; every colour is a token.
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

// Field operations, shown in the hero. The photos live in /public.
const SLIDES = [
  {
    img: '/field1.png',
    title: 'Magnetometer Survey',
    desc: 'Hand-pushed multi-sensor gradiometer cart with RTK-GPS positioning'
  },
  {
    img: '/field2.png',
    title: 'Georadar Survey (GPR)',
    desc: 'Tablet-controlled GPR cart profiling dense vegetation and embankments'
  },
  {
    img: '/field3.png',
    title: 'Rail Corridor Clearance',
    desc: 'Track-guided sensor array for UXO detection in active rail infrastructure'
  },
  {
    img: '/field4.png',
    title: 'Vehicle-Towed Array',
    desc: 'High-throughput towed magnetometer array for large open areas'
  }
];

const SLIDE_MS = 5000;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribeMotion = (cb: () => void) => {
  reducedMotion.addEventListener('change', cb);
  return () => reducedMotion.removeEventListener('change', cb);
};

/** True while the visitor asks for less motion. */
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeMotion, () => reducedMotion.matches);
}

export function Landing({ lang, onLangChange, theme, onToggleTheme, onSignIn, onRequestAccess }: LandingProps) {
  const t = makeT(lang);
  const [navOpen, setNavOpen] = useState(false);

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
        <div className="landing-copy">
          <h1 className="landing-title">
            {t('Investigated before')}{' '}
            <span className="landing-title-em">{t("it's a problem")}</span>
          </h1>
          <p className="landing-sub">
            {t('Navigate every anomaly and UXO inspection with real-time, actionable target detection, automated GPR logging, and instant field-to-office sync.')}
          </p>
          <div className="landing-cta">
            <button type="button" className="btn-primary landing-cta-btn" onClick={onRequestAccess}>
              {t('Get early access')} <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button type="button" className="btn-secondary landing-cta-btn" onClick={onSignIn}>
              {t('Sign in')}
            </button>
          </div>
        </div>

        <Showcase t={t} />
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

/**
 * The field photographs. They cross-fade rather than cut, all four stacked so the
 * next one is already loaded. The slideshow pauses while the pointer or focus is on
 * it, stops for good under reduced motion, and can be paused outright.
 */
function Showcase({ t }: { t: Translator }) {
  const [slide, setSlide] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const reduced = usePrefersReducedMotion();
  const running = !stopped && !reduced;

  useEffect(() => {
    if (!running || hovered || focused) return;
    const timer = setInterval(() => setSlide(s => (s + 1) % SLIDES.length), SLIDE_MS);
    return () => clearInterval(timer);
  }, [running, hovered, focused]);

  const current = SLIDES[slide];
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <section
      className="landing-showcase"
      aria-roledescription={t('carousel')}
      aria-label={t('Field operations')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}
    >
      <div className="hero-frame">
        {SLIDES.map((s, i) => (
          <img
            key={s.img}
            className="hero-photo"
            data-active={i === slide ? '' : undefined}
            src={s.img}
            alt={i === slide ? t(s.title) : ''}
            aria-hidden={i === slide ? undefined : true}
          />
        ))}
      </div>

      <div className="hero-caption" key={slide}>
        <div className="hero-caption-text">
          <span className="hero-caption-title">{t(current.title)}</span>
          <span className="hero-caption-desc">{t(current.desc)}</span>
        </div>
        <span className="hero-count num">{pad(slide + 1)} / {pad(SLIDES.length)}</span>
      </div>

      <div className="hero-controls">
        <div className="hero-dots" role="group" aria-label={t('Choose a photo')}>
          {SLIDES.map((s, i) => (
            <button
              key={s.img}
              type="button"
              className="hero-dot"
              aria-label={`${pad(i + 1)}: ${t(s.title)}`}
              aria-current={i === slide ? 'true' : undefined}
              onClick={() => setSlide(i)}
            >
              <span className="hero-dot-mark" aria-hidden="true"></span>
            </button>
          ))}
        </div>
        {!reduced && (
          <button
            type="button"
            className="hero-pause"
            onClick={() => setStopped(s => !s)}
            aria-label={stopped ? t('Play slideshow') : t('Pause slideshow')}
            title={stopped ? t('Play slideshow') : t('Pause slideshow')}
          >
            {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          </button>
        )}
      </div>
    </section>
  );
}
