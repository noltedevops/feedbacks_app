import React from 'react';
import { 
  X, 
  LogOut, 
  Sun, 
  Moon, 
  ShieldCheck, 
  Users, 
  Database, 
  RefreshCw, 
  Wifi, 
  WifiOff 
} from 'lucide-react';
import { LangSwitch } from './LangSwitch';
import { TourLaunchers } from '../tour/TourLaunchers';
import type { AppLang } from '../i18n';
import type { Access, Surface } from '../auth';

function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'US';
  const first = [...parts[0]];
  if (parts.length === 1) return first.slice(0, 2).join('').toUpperCase();
  const last = [...parts[parts.length - 1]];
  return (first[0] + last[0]).toUpperCase();
}

export interface MoreSheetProps {
  t: (s: string) => string;
  lang: AppLang;
  onLangChange: (lang: AppLang) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  fullName: string;
  username: string;
  role: string;
  access: Access;
  onStartTour: (surface: Surface) => void;
  onSignOut: () => void;
  onClose: () => void;
  onOpenAdminPanel?: () => void;
  pendingRequestsCount?: number;
  onOpenUsersPanel?: () => void;
  onOpenEtlPanel?: () => void;
  etlPendingCount?: number;
  isOnline: boolean;
  syncing: boolean;
  pendingSyncCount: number;
  onSync: () => void;
}

export const MoreSheet: React.FC<MoreSheetProps> = ({
  t,
  lang,
  onLangChange,
  theme,
  onToggleTheme,
  fullName,
  username,
  role,
  access,
  onStartTour,
  onSignOut,
  onClose,
  onOpenAdminPanel,
  pendingRequestsCount = 0,
  onOpenUsersPanel,
  onOpenEtlPanel,
  etlPendingCount = 0,
  isOnline,
  syncing,
  pendingSyncCount,
  onSync,
}) => {
  const name = fullName || username;

  return (
    <>
      <div className="profile-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="profile-sheet more-sheet" role="dialog" aria-label={t('Menu and Settings')}>
        
        {/* User Identity Header */}
        <div className="profile-head">
          <span className="profile-avatar" aria-hidden="true">{initialsFor(name)}</span>
          <div className="profile-id">
            <span className="profile-name">{name}</span>
            <span className="profile-meta">
              @{username || 'user'} · <span className="profile-role">{role}</span>
            </span>
          </div>
          <button type="button" className="profile-close" onClick={onClose} aria-label={t('Close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Sync & Connectivity Widget */}
        <div className="more-sheet-section">
          <div className="more-sheet-row">
            <div className="more-status-indicator" data-online={isOnline}>
              {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
              <span>{isOnline ? t('Network Online') : t('Network Offline')}</span>
            </div>
            <button
              type="button"
              className="btn-secondary more-sync-btn"
              onClick={onSync}
              disabled={syncing || !isOnline}
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              <span>{syncing ? t('Syncing...') : t('Sync Data')}</span>
              {pendingSyncCount > 0 && (
                <span className="more-badge">{pendingSyncCount}</span>
              )}
            </button>
          </div>
        </div>

        {/* Admin Tools Section (Only visible for Admins) */}
        {access.is_admin && (
          <div className="more-sheet-section">
            <span className="more-section-title">{t('Administration')}</span>
            <div className="more-admin-grid">
              {onOpenAdminPanel && (
                <button
                  type="button"
                  className="more-admin-item"
                  onClick={() => { onClose(); onOpenAdminPanel(); }}
                >
                  <ShieldCheck size={18} className="more-admin-icon" />
                  <span className="more-admin-label">{t('Permissions')}</span>
                  {pendingRequestsCount > 0 && (
                    <span className="more-badge">{pendingRequestsCount}</span>
                  )}
                </button>
              )}

              {onOpenUsersPanel && (
                <button
                  type="button"
                  className="more-admin-item"
                  onClick={() => { onClose(); onOpenUsersPanel(); }}
                >
                  <Users size={18} className="more-admin-icon" />
                  <span className="more-admin-label">{t('Users')}</span>
                </button>
              )}

              {onOpenEtlPanel && (
                <button
                  type="button"
                  className="more-admin-item"
                  onClick={() => { onClose(); onOpenEtlPanel(); }}
                >
                  <Database size={18} className="more-admin-icon" />
                  <span className="more-admin-label">{t('ETL Pipeline')}</span>
                  {etlPendingCount > 0 && (
                    <span className="more-badge">{etlPendingCount}</span>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Language and Theme Settings */}
        <div className="profile-settings">
          <div className="profile-row">
            <span className="profile-row-label">{t('Language')}</span>
            <LangSwitch lang={lang} onChange={onLangChange} />
          </div>
          <div className="profile-row">
            <span className="profile-row-label">{t('Theme')}</span>
            <button
              type="button"
              className="btn-secondary profile-theme"
              onClick={onToggleTheme}
              title={theme === 'dark' ? t('Switch to Light mode') : t('Switch to Dark mode')}
            >
              {theme === 'dark'
                ? <><Sun size={16} aria-hidden="true" /> {t('Light')}</>
                : <><Moon size={16} aria-hidden="true" /> {t('Dark')}</>}
            </button>
          </div>
        </div>

        {/* Guided Surface Tours */}
        <TourLaunchers lang={lang} access={access} onStart={onStartTour} />

        {/* Sign Out Button */}
        <button type="button" className="profile-signout" onClick={onSignOut}>
          <LogOut size={16} aria-hidden="true" /> {t('Sign Out')}
        </button>

      </div>
    </>
  );
};
