import { useLayoutEffect, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Info, X } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';
import { useModal } from '../useModal';

export type AuthView = 'login' | 'signup' | 'forgot';

/**
 * Sign in, create an account, reset a password - one dialog, three views.
 *
 * The app's dialog: a raised surface rising over a scrim, the heading step of the
 * scale, the app's inputs and buttons. It is a real modal: labelled, focus moves in
 * when it opens and is held inside it, Escape or a press on the scrim closes it, and
 * focus goes back to whatever opened it.
 *
 * Presentation only. The fields' state and the three submit handlers are App's,
 * unchanged, so nothing here decides who gets in.
 */

interface AuthDialogProps {
  lang: AppLang;
  view: AuthView;
  onViewChange: (view: AuthView) => void;
  onClose: () => void;
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  signupFullName: string;
  onSignupFullNameChange: (value: string) => void;
  signupUsername: string;
  onSignupUsernameChange: (value: string) => void;
  signupEmail: string;
  onSignupEmailChange: (value: string) => void;
  onLogin: (e: FormEvent) => void;
  onSignup: (e: FormEvent) => void;
  onForgot: (e: FormEvent) => void;
}

export function AuthDialog(props: AuthDialogProps) {
  const { lang, view, onViewChange, onClose } = props;
  const t = makeT(lang);

  // Focus returning to the opener, Escape, Tab held inside and the scrim closing: the
  // app's one modal behaviour, shared with the Dashboard's expanded panels.
  const [dialogRef, onBackdropMouseDown] = useModal<HTMLDivElement>(onClose);

  // The first field of whichever view is showing takes focus - on opening, and on
  // moving between sign-in, sign-up and reset.
  useLayoutEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [view, dialogRef]);

  const title = view === 'login' ? t('Sign in') : view === 'signup' ? t('Create account') : t('Reset password');

  return (
    <div
      className="permission-overlay auth-overlay"
      // A press that starts on the scrim closes; one that starts in a field and is
      // released outside (selecting text) does not.
      onMouseDown={onBackdropMouseDown}
    >
      <div
        ref={dialogRef}
        className="permission-dialog auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <button type="button" className="auth-close" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
          <X size={18} aria-hidden="true" />
        </button>

        <div className="auth-head">
          <img src="/logo.png" alt="" className="auth-logo" />
          <span className="auth-kicker">{t('NOLTE Geoservices platform')}</span>
          <h2 id="auth-title" className="auth-title">{title}</h2>
        </div>

        {view === 'login' && (
          <form className="auth-form" onSubmit={props.onLogin}>
            <Field id="login-username" label={t('Username / Operator ID')}>
              <input
                id="login-username"
                type="text"
                className="form-input"
                autoComplete="username"
                value={props.username}
                onChange={(e) => props.onUsernameChange(e.target.value)}
                placeholder={t('Enter your username')}
                required
              />
            </Field>
            <Field id="login-password" label={t('Password')}>
              <input
                id="login-password"
                type="password"
                className="form-input"
                autoComplete="current-password"
                value={props.password}
                onChange={(e) => props.onPasswordChange(e.target.value)}
                required
              />
            </Field>
            <button type="submit" className="btn-primary auth-submit">
              {t('Sign in')} <ArrowRight size={16} aria-hidden="true" />
            </button>
            <div className="auth-links">
              <button type="button" className="auth-link" onClick={() => onViewChange('forgot')}>
                {t('Forgot password?')}
              </button>
              <button type="button" className="auth-link auth-link--strong" onClick={() => onViewChange('signup')}>
                {t('Create account')}
              </button>
            </div>
          </form>
        )}

        {view === 'signup' && (
          <form className="auth-form" onSubmit={props.onSignup}>
            <Field id="signup-fullname" label={t('Full Name')}>
              <input
                id="signup-fullname"
                type="text"
                className="form-input"
                autoComplete="name"
                value={props.signupFullName}
                onChange={(e) => props.onSignupFullNameChange(e.target.value)}
                placeholder={t('Jane Smith')}
                required
              />
            </Field>
            <Field id="signup-username" label={t('Username / Operator ID')}>
              <input
                id="signup-username"
                type="text"
                className="form-input"
                autoComplete="username"
                value={props.signupUsername}
                onChange={(e) => props.onSignupUsernameChange(e.target.value)}
                placeholder={t('e.g. j.smith')}
                required
              />
            </Field>
            <Field id="signup-email" label={t('Corporate Email')}>
              <input
                id="signup-email"
                type="email"
                className="form-input"
                autoComplete="email"
                value={props.signupEmail}
                onChange={(e) => props.onSignupEmailChange(e.target.value)}
                placeholder="name@nolte-geoservices.de"
                required
              />
            </Field>
            <Field id="signup-password" label={t('Create Password')}>
              <input
                id="signup-password"
                type="password"
                className="form-input"
                autoComplete="new-password"
                value={props.password}
                onChange={(e) => props.onPasswordChange(e.target.value)}
                required
              />
            </Field>
            <p className="auth-note">
              <Info size={16} aria-hidden="true" />
              <span>{t('New accounts start with the Field App; Dashboard access is requested from an administrator.')}</span>
            </p>
            <button type="submit" className="btn-primary auth-submit">
              {t('Create & sign in')}
            </button>
            <div className="auth-links auth-links--center">
              <button type="button" className="auth-link" onClick={() => onViewChange('login')}>
                {t('Back to sign in')}
              </button>
            </div>
          </form>
        )}

        {view === 'forgot' && (
          <form className="auth-form" onSubmit={props.onForgot}>
            <Field id="forgot-email" label={t('Username or Email')}>
              <input
                id="forgot-email"
                type="text"
                className="form-input"
                autoComplete="username"
                placeholder={t('Enter your email')}
                required
              />
            </Field>
            <p className="auth-note">
              <Info size={16} aria-hidden="true" />
              <span>{t('An administrator will issue a temporary password.')}</span>
            </p>
            <button type="submit" className="btn-primary auth-submit">
              {t('Request reset')}
            </button>
            <div className="auth-links auth-links--center">
              <button type="button" className="auth-link" onClick={() => onViewChange('login')}>
                {t('Back to sign in')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}
