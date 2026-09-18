import { Globe } from 'lucide-react';
import type { AppLang } from '../i18n';

// Segmented language switch. `compact` is the narrow variant that fits the rail.
export function LangSwitch({ lang, onChange, compact = false }: {
  lang: AppLang;
  onChange: (lang: AppLang) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? 'lang-switch lang-switch-compact' : 'lang-switch'}
      data-lang={lang}
      role="group"
      aria-label={lang === 'EN' ? 'Language' : 'Sprache'}
      title={lang === 'EN' ? 'Switch language (English / Deutsch)' : 'Sprache wechseln (Deutsch / English)'}
    >
      {!compact && <Globe size={13} className="lang-switch-globe" aria-hidden="true" />}
      <span className="lang-switch-thumb" aria-hidden="true"></span>
      {(['EN', 'DE'] as AppLang[]).map((code) => (
        <button
          key={code}
          type="button"
          className={lang === code ? 'lang-switch-option active' : 'lang-switch-option'}
          onClick={() => onChange(code)}
          aria-pressed={lang === code}
          title={code === 'EN' ? 'English' : 'Deutsch'}
        >
          {code}
        </button>
      ))}
    </div>
  );
}
