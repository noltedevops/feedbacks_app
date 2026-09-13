import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { db, type LocalPoint, type PendingFeedback, type TeamsTools } from './db/indexedDb';
import { FieldMap } from './components/FieldMap';
import { Dashboard, matchesDepthBucket } from './components/Dashboard';
import { FeedbackForm } from './components/FeedbackForm';
import { ImportExport } from './components/ImportExport';
import { ReportDialog, type ProjectOption } from './components/ReportDialog';
import { FilterBar } from './components/FilterBar';
import { Select } from './components/Select';
import { Overview } from './components/Overview';
import { Landing } from './components/Landing';
import { LangSwitch } from './components/LangSwitch';
import { TourHost } from './tour/TourHost';
import { TourLaunchers } from './tour/TourLaunchers';
import type { TourId } from './tour/steps';
import { makeT, type AppLang } from './i18n';
import { useIsMobile } from './useIsMobile';
import { 
  Compass, 
  Wifi, 
  WifiOff, 
  RefreshCw, 
  Search, 
  CheckCircle2, 
  AlertTriangle, 
  LogOut, 
  Shield, 
  ArrowRight,
  X,
  Layers,
  Sun,
  Moon,
  ChevronsLeft,
  ChevronsRight,
  Table2,
  FilePlus2,
  ListChecks,
  Lock,
  ShieldCheck,
  Users,
  BarChart3
} from 'lucide-react';
import {
  authFetch, getAccess, setSession, clearSession, NO_ACCESS,
  rememberOnlineLogin, offlineAccessFor,
  type Access, type Surface,
} from './auth';

// Same-origin: FastAPI serves this bundle out of static/, so /api/... resolves against
// whatever host the app was opened from. Lets field devices reach the server by LAN IP
// instead of pointing at their own localhost. `npm run dev` relies on the proxy in
// vite.config.ts to forward /api to the backend.
const API_BASE = '';

// Feedback ids key the update-vs-insert branch on the server, so a collision would
// overwrite another target's findings. crypto.randomUUID() is only defined in secure
// contexts, so degrade to getRandomValues before ever falling back to Math.random.
function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Avatar initials. The three call sites used to slice the first two characters off
// the full name, which turned "Emmy Blaize" into "EM" instead of "EB" - it only ever
// looked right for people whose first two letters happened to match their initials.
// A full name gives first-initial + last-initial; a single token (a username, or a
// mononym) still falls back to its first two letters, which is what those callers
// relied on for values like "admin".
// Split on any whitespace run so double spaces do not produce an empty part, and
// iterate by code point so a name starting outside the BMP is not cut in half.
function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'US';

  const first = [...parts[0]];
  if (parts.length === 1) return first.slice(0, 2).join('').toUpperCase();

  const last = [...parts[parts.length - 1]];
  return (first[0] + last[0]).toUpperCase();
}

type AppRole = 'collector' | 'dashboard';

/**
 * Which surface is on screen.
 *
 * Deliberately not the same thing as AppRole, which the two used to be: AppRole is
 * the account's role as the server records it and now only labels the avatar, while
 * this is view state and nothing else.
 *
 * Just as deliberately not a member of `Surface` (auth.ts). That type is the
 * *permission* vocabulary the server mirrors - require_surface(), the 403 body,
 * permission_requests.surface - and the overview needs no permission, so widening it
 * would push a non-permission into every one of those places.
 */
type AppView = 'overview' | 'field' | 'dashboard';

// The view survives a reload, so a crew member reloading the PWA is not thrown back
// out of the field app. Signing in afresh always resets to the overview.
const VIEW_KEY = 'nolte_view';

/** The persisted view, or the overview for anything unrecognised. */
function storedView(): AppView {
  const raw = localStorage.getItem(VIEW_KEY);
  return raw === 'field' || raw === 'dashboard' ? raw : 'overview';
}

interface AdminUserRow {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  role: string;
  can_field: boolean;
  can_dashboard: boolean;
  is_admin: boolean;
  must_change_password: boolean;
}

interface PermissionRequestRow {
  id: string;
  surface: Surface;
  status: string;
  message: string | null;
  created_at: string | null;
  user: { id: string; username: string; full_name: string };
}

// How many target cards the field app's list keeps in the DOM before the user scrolls
// for more. See visibleTargetPoints.
const TARGET_PAGE_SIZE = 40;

// The profile menu behind the avatar - one body for the desktop pop-up and the phone
// sheet, which used to be two copies of the same markup with their own hardcoded
// colours (white text on a surface that is white in the light theme). Language and
// theme are only in the phone version: on a desktop they sit in the rail itself.
function ProfileMenu({
  t, lang, onLangChange, theme, onToggleTheme, fullName, username, role,
  access, onStartTour, onSignOut, onClose, withSettings,
}: {
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
  onClose?: () => void;
  withSettings: boolean;
}) {
  const name = fullName || username;
  return (
    <>
      <div className="profile-head">
        <span className="profile-avatar" aria-hidden="true">{initialsFor(name)}</span>
        <div className="profile-id">
          <span className="profile-name">{name}</span>
          <span className="profile-meta">@{username || 'user'} · <span className="profile-role">{role}</span></span>
        </div>
        {onClose && (
          <button type="button" className="profile-close" onClick={onClose} aria-label={t('Close')}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      {withSettings && (
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
      )}

      <TourLaunchers lang={lang} access={access} onStart={onStartTour} />

      <button type="button" className="profile-signout" onClick={onSignOut}>
        <LogOut size={15} aria-hidden="true" /> {t('Sign Out')}
      </button>
    </>
  );
}

// How the just-submitted record is doing on its way to the server. Purely
// informational - none of these states gate the confirmation screen.
type SubmissionSyncState = 'syncing' | 'synced' | 'offline' | 'pending';

// Replaces the field form once a record is written to IndexedDB. It is deliberately
// driven by the local save alone: /api/sync runs in the background, so an offline
// crew - or one whose sync just 4xx'd - still gets their confirmation.
function SubmissionConfirmation({ lang, vmNr, syncState, onOpenForm, onBackToList }: {
  lang: AppLang;
  vmNr: string;
  syncState: SubmissionSyncState;
  onOpenForm: () => void;
  onBackToList: () => void;
}) {
  const t = makeT(lang);

  const syncLabel: Record<SubmissionSyncState, string> = {
    syncing: t('Syncing to the cloud database...'),
    synced: t('Synced to the cloud database.'),
    offline: t('Saved offline - it will sync automatically once back online.'),
    pending: t('Not synced yet - the app will retry automatically.')
  };

  return (
    <div className="submit-done">
      <span className="submit-done-mark" aria-hidden="true">
        <CheckCircle2 size={28} />
      </span>

      <div className="submit-done-text">
        <h2 className="submit-done-title">{t('Submission Received')}</h2>
        <p className="submit-done-body">{t('Thank you! Your record has been submitted.')}</p>
        <span className="submit-done-meta num">{t('Target')} VM {vmNr}</span>
      </div>

      {/* Non-blocking sync indicator. The state is in the icon and the words; the
          colour only repeats it. */}
      <div className="submit-done-sync" data-state={syncState} role="status">
        {syncState === 'offline'
          ? <WifiOff size={14} aria-hidden="true" />
          : <RefreshCw size={14} className={syncState === 'syncing' ? 'animate-spin' : ''} aria-hidden="true" />}
        {syncLabel[syncState]}
      </div>

      <p className="submit-done-ask">{t('Would you like to add another record?')}</p>

      <div className="submit-done-actions">
        <button type="button" className="btn-primary" onClick={onOpenForm}>
          <FilePlus2 size={16} aria-hidden="true" />
          {t('Open Field Application Form')}
        </button>
        <button type="button" className="btn-secondary" onClick={onBackToList}>
          <ListChecks size={16} aria-hidden="true" />
          {t('Back to Target List')}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  // Session States
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState('');
  const [currentUserFullName, setCurrentUserFullName] = useState('');
  // The account's role, as the server records it. Labels the avatar; routes nothing.
  const [userRole, setUserRole] = useState<AppRole>('collector');
  // The surface the user asked for. What actually renders is `view` below, which
  // re-checks it against the access flags.
  const [requestedView, setRequestedView] = useState<AppView>('overview');
  // The guided tour running over a surface, if any. Started only by a click - from the
  // Overview or the profile menu - never automatically.
  const [tour, setTour] = useState<TourId | null>(null);
  // Keys the tour, so starting one again - even the same one - begins at step one.
  const [tourRun, setTourRun] = useState(0);
  // What this account may open. Mirrored from the server; the server re-checks.
  const [access, setAccess] = useState<Access>(NO_ACCESS);
  // Surface the user tried to open without permission -> drives the request dialog.
  const [permissionPrompt, setPermissionPrompt] = useState<Surface | null>(null);
  const [permissionNote, setPermissionNote] = useState('');
  const [permissionSending, setPermissionSending] = useState(false);
  const [permissionSent, setPermissionSent] = useState<Surface | null>(null);
  // Admin-only: pending requests waiting on a decision.
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<PermissionRequestRow[]>([]);
  // Admin-only: the user list, and the one-time password a reset just produced.
  const [showUsersPanel, setShowUsersPanel] = useState(false);
  const [userRows, setUserRows] = useState<AdminUserRow[]>([]);
  const [issuedPassword, setIssuedPassword] = useState<{ username: string; password: string } | null>(null);
  // Forced password change after an admin reset.
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwRepeat, setPwRepeat] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  
  // Theme States. Light is the default identity; dark is kept for anyone who chose it.
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Narrow screens reflow both surfaces into a single scrolling column. Everything a
  // media query can do stays in index.css; this drives only the parts CSS cannot reach -
  // chiefly moving the dashboard map out of its background layer and into the flow.
  const isMobile = useIsMobile();

  // The tokens key off body.dark-theme; light is :root and needs no class. A layout
  // effect so the class is on before the first paint: light is the default, and a
  // dark user would otherwise see one frame of it on every load.
  useLayoutEffect(() => {
    document.body.classList.toggle('dark-theme', theme === 'dark');
  }, [theme]);

  // Three controls now flip the theme - the rail, the mobile sheet and the landing
  // header - and each was repeating the same setState-then-write. One of them
  // forgetting the localStorage line is the kind of bug that only shows up as "the
  // landing page forgot my theme" after a reload, so the pair lives here once.
  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      return next;
    });
  }, []);
  
  // Auth Form State
  const [authView, setAuthView] = useState<'login' | 'signup' | 'forgot'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupFullName, setSignupFullName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);

  // Language
  const [lang, setLang] = useState<AppLang>((localStorage.getItem('nolte_lang') as AppLang) || 'EN');

  // Remember the chosen language across sessions and keep <html lang> in sync
  useEffect(() => {
    localStorage.setItem('nolte_lang', lang);
    document.documentElement.lang = lang === 'DE' ? 'de' : 'en';
  }, [lang]);

  // Translator for the signed-in application shell
  const t = makeT(lang);

  // Map and Data States
  const [points, setPoints] = useState<LocalPoint[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<LocalPoint | null>(null);
  const [serverProjects, setServerProjects] = useState<ProjectOption[]>([]);
  // 'dashboard' offers PDF + CSV, 'field' is CSV only
  const [reportDialog, setReportDialog] = useState<false | 'dashboard' | 'field'>(false);

  // Latest teams & tools recorded on this project, read from the local mirror so the
  // "Need update? -> No" path still auto-populates when the crew is offline.
  const lastTeamsTools = useMemo<TeamsTools | null>(() => {
    const projectId = selectedPoint?.project_id;
    if (!projectId) return null;
    return points
      .filter((p) => p.project_id === projectId && p.feedback?.teams_tools)
      .sort((a, b) => (b.feedback!.logged_at || '').localeCompare(a.feedback!.logged_at || ''))[0]
      ?.feedback?.teams_tools ?? null;
  }, [points, selectedPoint?.project_id]);
  const [activeTab, setActiveTab] = useState<'map' | 'import'>('map');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [addDataOpen, setAddDataOpen] = useState(false);
  const [isEditLocationMode, setIsEditLocationMode] = useState(false);

  // Set once a record is written to IndexedDB; swaps the form out for the thank-you
  // screen. Never touched by the sync result - see handleSaveFeedback.
  const [submission, setSubmission] = useState<{ point: LocalPoint; vmNr: string } | null>(null);
  // Target whose form must open blank, so "Open Field Application Form" hands back an
  // empty sheet instead of the record that was just filed against it.
  const [blankFormPointId, setBlankFormPointId] = useState<string | null>(null);

  // Overlapping sync cycles are what POSTed the same feedback id twice; these collapse
  // them into one run plus at most one follow-up. See handleSync.
  const syncInFlightRef = useRef(false);
  const syncQueuedRef = useRef(false);

  // Search and Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterVmNr, setFilterVmNr] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all'); // all, investigated, pending
  const [filterInstrument, setFilterInstrument] = useState('all'); // all, georadar, magnetic
  const [filterProjectId, setFilterProjectId] = useState('all');
  // Dashboard-only depth bucket; see DEPTH_BUCKETS. 'all' means no depth constraint.
  const [filterDepth, setFilterDepth] = useState('all');
  
  // Toast Notification
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Restore session
  useEffect(() => {
    const sessionUser = localStorage.getItem('nolte_user');
    const sessionRole = localStorage.getItem('nolte_role');
    let sessionFullName = localStorage.getItem('nolte_user_fullname');
    if (sessionUser && sessionRole) {
      if (!sessionFullName || sessionFullName === sessionUser || !sessionFullName.includes(' ')) {
        if (sessionUser.toLowerCase().includes('musoso') || sessionUser.toLowerCase().includes('musonera')) {
          sessionFullName = 'Eric Musonera';
        } else {
          sessionFullName = 'Eric Musonera'; // Default first and last name
        }
        localStorage.setItem('nolte_user_fullname', sessionFullName);
      }
      setCurrentUser(sessionUser);
      setUserRole(sessionRole as AppRole);
      setCurrentUserFullName(sessionFullName);
      setAccess(getAccess());
      // A reload resumes where the user was, unlike a sign-in. `view` still holds
      // this against the flags, so a surface revoked in the meantime cannot return.
      setRequestedView(storedView());
      setIsLoggedIn(true);
    }
  }, []);

  // Re-read our own access on start, so permission granted while this device was
  // offline takes effect without making the user sign out and back in.
  useEffect(() => {
    if (!isLoggedIn) return;
    authFetch(`${API_BASE}/api/auth/me`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!data) return;
        const fresh: Access = {
          can_field: !!data.can_field,
          can_dashboard: !!data.can_dashboard,
          is_admin: !!data.is_admin,
        };
        setAccess(fresh);
        setSession(null, fresh);
        setMustChangePassword(!!data.must_change_password);
      })
      .catch(() => { /* offline: keep the cached flags */ });
  }, [isLoggedIn]);

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      showToast('success', t('Connection restored. Cloud sync enabled.'));
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast('info', t('Offline mode active. Logs queued in IndexedDB.'));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Sync / Load data
  useEffect(() => {
    if (isLoggedIn) {
      loadLocalData();
      updatePendingCount();
      if (navigator.onLine) {
        fetchFromServer();
      }
    }
  }, [isLoggedIn]);

  // Auto-sync when online. Silent: the crew did not ask for this run, and a failure
  // here is harmless because the records stay queued locally.
  useEffect(() => {
    if (isOnline && pendingSyncCount > 0 && isLoggedIn) {
      void handleSync({ silent: true });
    }
  }, [isOnline, pendingSyncCount, isLoggedIn]);

  const showToast = (type: 'success' | 'error' | 'info', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const loadLocalData = async () => {
    try {
      const localPoints = await db.points.toArray();
      setPoints(localPoints);
    } catch (err) {
      console.error(err);
    }
  };

  const updatePendingCount = async () => {
    try {
      const feedbackCount = await db.pendingFeedback.count();
      const pointUpdatesCount = await db.pendingPointUpdates.count();
      setPendingSyncCount(feedbackCount + pointUpdatesCount);
    } catch (err) {
      console.error(err);
    }
  };

  // Project names for the report filter; best effort, the local ids are the fallback.
  useEffect(() => {
    if (!isOnline) return;
    authFetch(`${API_BASE}/api/projects`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setServerProjects)
      .catch(() => setServerProjects([]));
  }, [isOnline]);

  const fetchFromServer = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/points`);
      if (!res.ok) throw new Error('API server error');
      const serverPoints = await res.json();
      
      await db.transaction('rw', db.points, async () => {
        await db.points.clear();
        for (const p of serverPoints) {
          const status = p.feedback ? 'investigated' : 'unvisited';
          await db.points.put({
            id: p.id,
            project_id: p.project_id || '11-24-2736',
            target_id: p.target_id || '',
            vm_nr: p.vm_nr,
            easting: p.easting,
            northing: p.northing,
            latitude: p.latitude,
            longitude: p.longitude,
            evaluated_depth: p.evaluated_depth,
            opening_length: p.opening_length,
            opening_width: p.opening_width,
            opening_depth: p.opening_depth,
            opening_volume: p.opening_volume,
            find_description: p.find_description,
            image_id: p.image_id,
            remarks: p.remarks,
            created_at: p.created_at,
            local_status: status,
            feedback: p.feedback,
            instrument: p.instrument,
            layer: p.layer
          });
        }
      });
      await loadLocalData();
    } catch (err) {
      console.warn('Could not contact API server. Operating on cached local DB.', err);
    }
  };

  // `silent` suppresses the failure toasts for syncs the crew did not ask for, so a
  // background retry never shouts over the submission confirmation.
  const handleSync = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!isOnline) {
      if (!silent) showToast('error', t('Sync aborted: Network is offline.'));
      return;
    }
    // Saving a record starts a sync and also bumps the pending counter the auto-sync
    // effect watches, so two cycles used to POST the same row concurrently and the
    // loser came back as a duplicate-key 400. Coalesce instead: the in-flight run
    // picks up whatever was queued behind it.
    if (syncInFlightRef.current) {
      syncQueuedRef.current = true;
      return;
    }
    syncInFlightRef.current = true;
    setSyncing(true);
    try {
      const pendingItems = await db.pendingFeedback.toArray();
      const pendingPoints = await db.pendingPointUpdates.toArray();
      const sentFeedbackIds = pendingItems.map((i) => i.id);
      const sentPointIds = pendingPoints.map((p) => p.id);

      const res = await authFetch(`${API_BASE}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          feedback: pendingItems,
          point_updates: pendingPoints
        })
      });
      
      if (!res.ok) throw new Error(`Sync endpoint failed with ${res.status}`);
      const syncResult = await res.json();

      // Drop only what this request actually carried, so a record queued while it was
      // in flight survives for the next cycle - and, just as importantly, an accepted
      // record is never re-sent and can never collide with itself server-side.
      await db.pendingFeedback.bulkDelete(sentFeedbackIds);
      await db.pendingPointUpdates.bulkDelete(sentPointIds);

      await db.transaction('rw', db.points, async () => {
        await db.points.clear();
        for (const p of syncResult.points) {
          const status = p.feedback ? 'investigated' : 'unvisited';
          await db.points.put({
            id: p.id,
            project_id: p.project_id || '11-24-2736',
            target_id: p.target_id || '',
            vm_nr: p.vm_nr,
            easting: p.easting,
            northing: p.northing,
            latitude: p.latitude,
            longitude: p.longitude,
            evaluated_depth: p.evaluated_depth,
            opening_length: p.opening_length,
            opening_width: p.opening_width,
            opening_depth: p.opening_depth,
            opening_volume: p.opening_volume,
            find_description: p.find_description,
            image_id: p.image_id,
            remarks: p.remarks,
            created_at: p.created_at,
            local_status: status,
            feedback: p.feedback,
            instrument: p.instrument,
            layer: p.layer
          });
        }
      });
      
      await loadLocalData();
      await updatePendingCount();
      showToast('success', `Data Sync Complete! Synchronized ${syncResult.synced_feedback} logs and ${syncResult.synced_points || 0} target locations.`);
    } catch (err) {
      console.error(err);
      // Records stay queued in IndexedDB, so nothing is lost - the next cycle retries.
      if (!silent) showToast('error', t('Cloud database sync failed.'));
    } finally {
      setSyncing(false);
      syncInFlightRef.current = false;
      if (syncQueuedRef.current) {
        syncQueuedRef.current = false;
        void handleSync({ silent });
      }
    }
  };

  const handleSaveFeedback = async (feedbackData: {
    status: string;
    actual_depth: number | null;
    photos: string[];
    notes: string | null;
    investigator: string | null;
    investigator_username: string | null;
    easting?: number;
    northing?: number;
    latitude?: number;
    longitude?: number;
    
    // New fields
    target_id: string;
    sohle_status: string;
    bilder_n: number;
    other: string | null;
    fundstueck: string;
    laenge: number | null;
    breite: number | null;
    m_cube: number | null;
    teams_tools: TeamsTools;
  }) => {
    if (!selectedPoint) return;

    try {
      const feedbackRecord: PendingFeedback = {
        id: selectedPoint.feedback?.id || newId(),
        point_id: selectedPoint.id,
        visited: true,
        status: feedbackData.status,
        actual_depth: feedbackData.actual_depth,
        photos: feedbackData.photos,
        notes: feedbackData.notes,
        investigator: feedbackData.investigator,
        investigator_username: feedbackData.investigator_username,
        logged_at: new Date().toISOString(),
        
        // New fields
        target_id: feedbackData.target_id,
        sohle_status: feedbackData.sohle_status,
        bilder_n: feedbackData.bilder_n,
        other: feedbackData.other,
        fundstueck: feedbackData.fundstueck,
        laenge: feedbackData.laenge,
        breite: feedbackData.breite,
        m_cube: feedbackData.m_cube,
        teams_tools: feedbackData.teams_tools
      };

      await db.pendingFeedback.put(feedbackRecord);
      
      const coordsUpdated = feedbackData.latitude !== undefined && feedbackData.longitude !== undefined;
      if (coordsUpdated) {
        await db.pendingPointUpdates.put({
          id: selectedPoint.id,
          easting: feedbackData.easting!,
          northing: feedbackData.northing!,
          latitude: feedbackData.latitude!,
          longitude: feedbackData.longitude!
        });
      }
      
      const updatedPoint: LocalPoint = {
        ...selectedPoint,
        easting: coordsUpdated ? feedbackData.easting! : selectedPoint.easting,
        northing: coordsUpdated ? feedbackData.northing! : selectedPoint.northing,
        latitude: coordsUpdated ? feedbackData.latitude! : selectedPoint.latitude,
        longitude: coordsUpdated ? feedbackData.longitude! : selectedPoint.longitude,
        local_status: 'investigated',
        feedback: {
          id: feedbackRecord.id,
          visited: true,
          status: feedbackData.status,
          actual_depth: feedbackData.actual_depth,
          photos: feedbackData.photos,
          notes: feedbackData.notes,
          investigator: feedbackData.investigator,
          investigator_username: feedbackData.investigator_username,
          logged_at: feedbackRecord.logged_at,
          
          // New fields
          target_id: feedbackData.target_id,
          sohle_status: feedbackData.sohle_status,
          bilder_n: feedbackData.bilder_n,
          other: feedbackData.other,
          fundstueck: feedbackData.fundstueck,
          laenge: feedbackData.laenge,
          breite: feedbackData.breite,
          m_cube: feedbackData.m_cube,
          teams_tools: feedbackData.teams_tools
        }
      };
      
      await db.points.put(updatedPoint);
      await loadLocalData();
      await updatePendingCount();

      // The local write succeeded, so the record is safe - confirm it now. The server
      // round trip below is fire-and-forget: offline, a 4xx or a 5xx must never leave
      // the crew staring at a form that looks like it did nothing.
      setSubmission({ point: updatedPoint, vmNr: selectedPoint.vm_nr });
      setSelectedPoint(null);
      setBlankFormPointId(null);
      setIsEditLocationMode(false);

      if (isOnline) {
        void handleSync({ silent: true });
      }
    } catch (err) {
      // Nothing was confirmed and selectedPoint is untouched, so the form keeps every
      // value the crew typed and they can hit Submit again.
      console.error(err);
      showToast('error', t('Failed to save feedback findings.'));
    }
  };

  const handleImportPoints = async (importedPoints: any[]) => {
    try {
      if (isOnline) {
        const res = await authFetch(`${API_BASE}/api/points/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(importedPoints)
        });
        if (!res.ok) throw new Error('Failed import');
        await fetchFromServer();
      } else {
        await db.transaction('rw', db.points, async () => {
          for (const p of importedPoints) {
            const tempId = newId();
            const target_id_val = `11-24-2736-${p.easting.toFixed(3)}-${p.northing.toFixed(3)}`;
            await db.points.put({
              id: tempId,
              project_id: '11-24-2736',
              target_id: target_id_val,
              vm_nr: String(p.vm_nr),
              easting: p.easting,
              northing: p.northing,
              latitude: p.latitude,
              longitude: p.longitude,
              evaluated_depth: p.evaluated_depth,
              opening_length: p.opening_length,
              opening_width: p.opening_width,
              opening_depth: p.opening_depth,
              opening_volume: p.opening_volume,
              find_description: p.find_description,
              image_id: p.image_id,
              remarks: p.remarks,
              created_at: new Date().toISOString(),
              local_status: 'unvisited',
              feedback: null,
              instrument: p.instrument || 'georadar'
            });
          }
        });
        await loadLocalData();
      }
      showToast('success', `Imported ${importedPoints.length} GPR targets.`);
    } catch (err) {
      console.error(err);
      showToast('error', t('Failed to import GPR points.'));
    }
  };

  const handleSeedRequest = async () => {
    const res = await authFetch(`${API_BASE}/api/seed`, { method: 'POST' });
    if (!res.ok) throw new Error('Seeding failed');
    await fetchFromServer();
  };

  // Auth Submit Handlers
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const usernameClean = usernameInput.trim();
    if (!usernameClean) return;

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameClean, password: passwordInput })
      });
      if (res.ok) {
        const data = await res.json();
        const role = (data.role || 'collector') as AppRole;
        const fullname = data.full_name || 'Eric Musonera';
        
        const granted: Access = {
          can_field: !!data.can_field,
          can_dashboard: !!data.can_dashboard,
          is_admin: !!data.is_admin,
        };

        localStorage.setItem('nolte_user', data.username);
        localStorage.setItem('nolte_role', role);
        localStorage.setItem('nolte_user_fullname', fullname);
        setSession(data.token, granted);
        // The server vouched for this account here, which is what later lets it
        // sign in offline. Recorded under the name the server returned, so a
        // difference in casing cannot open a second, unverified entry.
        rememberOnlineLogin(data.username, granted);

        setCurrentUser(data.username);
        setCurrentUserFullName(fullname);
        setUserRole(role);
        // Signing in lands on the overview, whatever the account may open. It needs
        // no permission and calls no API, so it is the one surface that is right for
        // every account - including one holding neither flag, which used to be
        // dropped into the dashboard to collect 403s.
        changeView('overview');
        setAccess(granted);
        setMustChangePassword(!!data.must_change_password);
        setIsLoggedIn(true);
        showToast('success', `Welcome back, ${fullname}!`);
        return;
      }
      // The server answered and turned us down. Stop here: falling through to
      // the offline path below would accept any password whenever the backend
      // is actually reachable.
      showToast('error', t('Invalid username or password.'));
      return;
    } catch (err) {
      console.warn('Backend login unreachable, using local fallback', err);
    }

    // Local fallback, reached only when the backend could not be contacted at
    // all, so crews can keep working offline. Nothing here checks the password -
    // there is nothing to check it against - so it is limited to accounts the
    // server has already authenticated on this device, and to the field app.
    const offlineAccess = offlineAccessFor(usernameClean);
    if (!offlineAccess) {
      // Refusing beats a silent local sign-in: an unverified session used to
      // look exactly like a real one, so a wrong password read as success and
      // only failed once the backend came back.
      showToast('error', t('No connection, and this account has not signed in on this device before. Connect to the network to sign in.'));
      return;
    }
    const role: AppRole = 'collector';
    const fullname = localStorage.getItem('nolte_user_fullname') || usernameClean;

    localStorage.setItem('nolte_user', usernameClean);
    localStorage.setItem('nolte_role', role);
    localStorage.setItem('nolte_user_fullname', fullname);
    setSession(null, offlineAccess);

    setCurrentUser(usernameClean);
    setCurrentUserFullName(fullname);
    setUserRole(role);
    // Safe with no network: the overview fetches nothing.
    changeView('overview');
    setAccess(offlineAccess);
    setIsLoggedIn(true);
    showToast('info', t('OFFLINE MODE: your password was not checked. Field app only; data syncs when back online.'));
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const usernameClean = signupUsername.trim();
    const fullNameClean = signupFullName.trim();
    if (!usernameClean || !fullNameClean) return;

    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullNameClean,
          username: usernameClean,
          email: signupEmail.trim(),
          password: passwordInput || 'password'
        })
      });
      if (res.ok) {
        const data = await res.json();
        const role = (data.role || 'collector') as AppRole;
        
        const granted: Access = {
          can_field: !!data.can_field,
          can_dashboard: !!data.can_dashboard,
          is_admin: !!data.is_admin,
        };

        localStorage.setItem('nolte_user', data.username);
        localStorage.setItem('nolte_role', role);
        localStorage.setItem('nolte_user_fullname', data.full_name);
        setSession(data.token, granted);

        setCurrentUser(data.username);
        setCurrentUserFullName(data.full_name);
        setUserRole(role);
        changeView('overview');
        setAccess(granted);
        setIsLoggedIn(true);
        setShowAuthModal(false);
        showToast('success', `Account created successfully! Welcome, ${data.full_name}.`);
        return;
      }
      // Same reasoning as handleLogin: a rejected registration (usually a taken
      // username) must not hand out a local session for that name.
      const detail = await res.json().catch(() => null);
      showToast('error', detail?.detail || t('Registration failed.'));
      return;
    } catch (err) {
      console.warn('Backend register unreachable; refusing to fake an account', err);
    }

    // No offline fallback here, unlike sign-in. An account only exists once the
    // server has created it, so the old local session announced "Account created
    // successfully" for an account that was never created anywhere - and any data
    // collected under that name synced with an investigator no user row matched.
    showToast('error', t('No connection. Creating an account needs the server; please try again once online.'));
  };


  const handleForgot = (e: React.FormEvent) => {
    e.preventDefault();
    // There is no self-service reset: no mail server is configured. This used to
    // claim an email had been sent, which left people waiting for nothing. An
    // admin issues a temporary password from the Users panel instead.
    showToast('info', t('Please ask your administrator to reset your password.'));
    setAuthView('login');
  };

  /** Move to a view and remember it, so a reload comes back to the same place. */
  const changeView = (next: AppView) => {
    setRequestedView(next);
    localStorage.setItem(VIEW_KEY, next);
  };

  // Surface switching goes through here so a user without the permission gets
  // the request dialog instead of a view they are not allowed to see.
  const openSurface = (surface: Surface) => {
    const allowed = surface === 'field' ? access.can_field : access.can_dashboard;
    if (!allowed) {
      setPermissionNote('');
      setPermissionPrompt(surface);
      return;
    }
    if (surface === 'field') {
      changeView('field');
      setActiveTab('map');
    } else {
      changeView('dashboard');
    }
  };

  // Opens the surface and runs its tour over it. A locked surface gets openSurface's
  // request dialog and no tour - though neither entry point offers one.
  const startTour = (surface: Surface) => {
    setShowUserModal(false);
    openSurface(surface);
    if (surface === 'field' ? access.can_field : access.can_dashboard) {
      setTour(surface);
      setTourRun(n => n + 1);
    }
  };

  const submitPermissionRequest = async () => {
    if (!permissionPrompt) return;
    setPermissionSending(true);
    try {
      const res = await authFetch(`${API_BASE}/api/permissions/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: permissionPrompt, message: permissionNote.trim() || null }),
      });
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      const data = await res.json();
      if (data.status === 'already_granted') {
        // An admin approved it while the dialog was open.
        const fresh = { ...access, [permissionPrompt === 'field' ? 'can_field' : 'can_dashboard']: true };
        setAccess(fresh);
        setSession(null, fresh);
        setPermissionPrompt(null);
        showToast('success', t('Access granted.'));
        return;
      }
      setPermissionSent(permissionPrompt);
      showToast('success', t('Request sent to the administrator.'));
    } catch (err) {
      console.warn('Permission request failed', err);
      showToast('error', t('Could not send the request. Check your connection.'));
    } finally {
      setPermissionSending(false);
    }
  };

  const loadUsers = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/admin/users`);
      if (!res.ok) return;
      setUserRows(await res.json());
    } catch (err) {
      console.warn('Could not load users', err);
    }
  };

  useEffect(() => {
    if (showUsersPanel && access.is_admin) loadUsers();
  }, [showUsersPanel, access.is_admin]);

  const updateUserAccess = async (row: AdminUserRow, patch: Partial<AdminUserRow>) => {
    try {
      const res = await authFetch(`${API_BASE}/api/admin/users/${row.id}/access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // The server refuses to remove the last admin; surface its reason.
        showToast('error', body?.detail || t('Could not change access.'));
        return;
      }
      setUserRows(prev => prev.map(u => (u.id === row.id ? { ...u, ...patch } : u)));
      // Changing our own access has to be reflected here too.
      if (row.username === currentUser) {
        const fresh = { ...access, ...patch } as Access;
        setAccess(fresh);
        setSession(null, fresh);
      }
    } catch (err) {
      console.warn('Could not change access', err);
      showToast('error', t('Could not change access.'));
    }
  };

  const resetUserPassword = async (row: AdminUserRow) => {
    try {
      const res = await authFetch(`${API_BASE}/api/admin/users/${row.id}/reset-password`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      // Shown once - there is no way to read it back.
      setIssuedPassword({ username: data.username, password: data.temporary_password });
      setUserRows(prev => prev.map(u => (u.id === row.id ? { ...u, must_change_password: true } : u)));
    } catch (err) {
      console.warn('Could not reset password', err);
      showToast('error', t('Could not reset the password.'));
    }
  };

  const submitPasswordChange = async () => {
    setPwError('');
    if (pwNext.length < 8) {
      setPwError(t('The new password needs at least 8 characters.'));
      return;
    }
    if (pwNext !== pwRepeat) {
      setPwError(t('The two new passwords do not match.'));
      return;
    }
    setPwSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: pwCurrent, new_password: pwNext }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPwError(data?.detail || t('Could not change the password.'));
        return;
      }
      const fresh: Access = {
        can_field: !!data.can_field,
        can_dashboard: !!data.can_dashboard,
        is_admin: !!data.is_admin,
      };
      setSession(data.token, fresh);
      setAccess(fresh);
      setMustChangePassword(false);
      setPwCurrent(''); setPwNext(''); setPwRepeat('');
      showToast('success', t('Password updated.'));
    } catch (err) {
      console.warn('Could not change password', err);
      setPwError(t('Could not change the password.'));
    } finally {
      setPwSaving(false);
    }
  };

  const loadPermissionRequests = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/permissions/requests?status=pending`);
      if (!res.ok) return;
      setPendingRequests(await res.json());
    } catch (err) {
      console.warn('Could not load permission requests', err);
    }
  };

  // Load once when an admin signs in so the sidebar badge is right, then poll
  // only while the panel is open.
  useEffect(() => {
    if (!access.is_admin) return;
    loadPermissionRequests();
    if (!showAdminPanel) return;
    const timer = setInterval(loadPermissionRequests, 20000);
    return () => clearInterval(timer);
  }, [showAdminPanel, access.is_admin]);

  const decideRequest = async (id: string, approve: boolean) => {
    try {
      const res = await authFetch(`${API_BASE}/api/permissions/requests/${id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve }),
      });
      if (!res.ok) throw new Error(`decide failed: ${res.status}`);
      setPendingRequests(prev => prev.filter(r => r.id !== id));
      showToast('success', approve ? t('Permission granted.') : t('Request denied.'));
    } catch (err) {
      console.warn('Could not decide request', err);
      showToast('error', t('Could not save the decision.'));
    }
  };

  const handlePointPositionChange = (lat: number, lng: number) => {
    if (!selectedPoint) return;
    setSelectedPoint(prev => {
      if (!prev) return null;
      return {
        ...prev,
        latitude: lat,
        longitude: lng
      };
    });
  };

  const handleSignOut = () => {
    clearSession();
    setAccess(NO_ACCESS);
    localStorage.removeItem('nolte_user');
    localStorage.removeItem('nolte_role');
    localStorage.removeItem('nolte_user_fullname');
    // Both of these used to survive a sign-out, so the next account on the device
    // started on the previous one's surface and wearing their role label.
    localStorage.removeItem(VIEW_KEY);
    setRequestedView('overview');
    setTour(null);
    setUserRole('collector');
    setIsLoggedIn(false);
    setSelectedPoint(null);
    setSubmission(null);
    setBlankFormPointId(null);
    setIsEditLocationMode(false);
    setUsernameInput('');
    setPasswordInput('');
    setCurrentUser('');
    setCurrentUserFullName('');
  };

  // Reset selectedPoint when any filter changes so map zooms to fit the new selection
  useEffect(() => {
    setSelectedPoint(null);
  }, [searchQuery, filterVmNr, filterStatus, filterInstrument, filterProjectId]);

  // Turn off edit location mode when selectedPoint changes
  useEffect(() => {
    setIsEditLocationMode(false);
    // Opening any target leaves the confirmation screen behind. Submitting clears
    // selectedPoint in the same batch, so this never eats a fresh confirmation.
    if (selectedPoint) setSubmission(null);
  }, [selectedPoint]);

  // The point handed to the form. "Open Field Application Form" asks for a blank sheet
  // on the target just filed, and hiding its feedback puts FeedbackForm on its own
  // empty-form branch rather than duplicating that reset logic here. Keyed by id so
  // picking a different target still shows that target's stored record.
  const formPoint = useMemo(() => {
    if (!selectedPoint) return null;
    return blankFormPointId === selectedPoint.id
      ? { ...selectedPoint, feedback: null }
      : selectedPoint;
  }, [selectedPoint, blankFormPointId]);

  // Non-blocking status for the confirmation screen's sync chip.
  const submissionSyncState: SubmissionSyncState =
    !isOnline ? 'offline' : syncing ? 'syncing' : pendingSyncCount > 0 ? 'pending' : 'synced';

  // Filters logic. Memoized on their actual inputs: every one of these walks the full
  // ~1500-target set, and the arrays they produce are props of the memoized FieldMap and
  // Dashboard - recomputing them on an unrelated render (a sync tick, a toast, an
  // online/offline flip) would hand those children fresh array identities and defeat
  // their memoization entirely.
  const filteredPoints = useMemo(() => points.filter(p => {
    const matchesSearch = p.vm_nr.toString().includes(searchQuery) ||
                          (p.find_description && p.find_description.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesVmNr = filterVmNr === 'all' || p.vm_nr.toString() === filterVmNr;

    let matchesStatus = true;
    const isInvestigated = p.local_status && p.local_status !== 'unvisited';
    if (filterStatus === 'investigated') {
      matchesStatus = !!isInvestigated;
    } else if (filterStatus === 'pending') {
      matchesStatus = !isInvestigated;
    }

    const matchesInstrument = filterInstrument === 'all' ||
                             (p.instrument && p.instrument.toLowerCase() === filterInstrument.toLowerCase());

    const matchesProjectId = filterProjectId === 'all' || p.project_id === filterProjectId;

    return matchesSearch && matchesVmNr && matchesStatus && matchesInstrument && matchesProjectId;
  }), [points, searchQuery, filterVmNr, filterStatus, filterInstrument, filterProjectId]);

  // The depth bucket is a dashboard control, so it narrows the dashboard's log list and
  // map markers only - the field app keeps rendering from the unnarrowed filteredPoints.
  // Status is already applied above; depth composes on top of it (AND).
  const dashboardFilteredPoints = useMemo(() => filteredPoints.filter(p =>
    matchesDepthBucket(p, filterDepth, filterStatus)
  ), [filteredPoints, filterDepth, filterStatus]);

  const allVmNumbers = useMemo(
    () => points.map(p => p.vm_nr).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
    [points]
  );
  const uniqueProjectIds = useMemo(
    () => Array.from(new Set(points.map(p => p.project_id || '11-24-2736'))).sort(),
    [points]
  );

  // Report/export filter options: server names when reachable, otherwise the ids
  // already mirrored locally so the field app can still export offline.
  const projectOptions: ProjectOption[] = useMemo(() => serverProjects.length
    ? serverProjects
    : uniqueProjectIds.map(id => ({ project_id: id, project_name: '' })),
    [serverProjects, uniqueProjectIds]
  );

  // What the field app is currently scoped to, shown above the project picker.
  //
  // This was the string literal "Wilhelmshaven Seedeich", so it survived every change
  // of project and named the wrong one as soon as a second project existed. Derived
  // from the same filter the picker writes, it cannot go stale.
  //
  // The name comes from the server's project list. Offline that list is empty and the
  // picker falls back to bare ids, so this does too. When a name is available the id
  // is not repeated with it: the id is already on the PROJECT ID row immediately
  // below, and this heading is a single line that ellipsises.
  const activeAreaLabel = useMemo(() => {
    if (filterProjectId === 'all') return t('All Projects');
    const name = projectOptions.find(p => p.project_id === filterProjectId)?.project_name;
    return name || filterProjectId;
  }, [filterProjectId, projectOptions, t]);

  // Stable identities so the memoized FieldMap and Dashboard are not invalidated by a
  // fresh inline closure on every render.
  const handleSelectPoint = useCallback((point: LocalPoint | null) => setSelectedPoint(point), []);
  const handleOpenDashboardReport = useCallback(() => setReportDialog('dashboard'), []);

  // The field app's target list is windowed for the same reason as the dashboard log:
  // one shadowed, transition-animated card per target puts ~12k nodes on the page at
  // this dataset's size, and every scroll frame then pays to restyle them.
  // Reset adjusted during render rather than in an effect - see the same pattern in
  // Dashboard's log list.
  const [visibleTargetCount, setVisibleTargetCount] = useState(TARGET_PAGE_SIZE);
  const [lastTargetPoints, setLastTargetPoints] = useState(filteredPoints);

  if (lastTargetPoints !== filteredPoints) {
    setLastTargetPoints(filteredPoints);
    setVisibleTargetCount(TARGET_PAGE_SIZE);
  }

  const handleTargetListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      setVisibleTargetCount(c => (c >= filteredPoints.length ? c : c + TARGET_PAGE_SIZE));
    }
  }, [filteredPoints.length]);

  const visibleTargetPoints = useMemo(
    () => filteredPoints.slice(0, visibleTargetCount),
    [filteredPoints, visibleTargetCount]
  );

  // Active selection shown on the field app's folded filter bar, so the crew can see what
  // the list is scoped to without expanding it. Search is deliberately excluded - it stays
  // visible above the bar because it is the primary control here.
  const fieldFilterSummary = useMemo(() => {
    const project = filterProjectId === 'all' ? t('All Projects') : filterProjectId;
    const vm = filterVmNr === 'all' ? t('All VM Nr.') : `VM ${filterVmNr}`;
    const instrument = filterInstrument === 'all'
      ? t('All Instruments')
      : filterInstrument === 'georadar' ? t('Georadar') : t('Magnetic');
    const status = filterStatus === 'investigated' ? t('Investigated')
      : filterStatus === 'pending' ? t('Pending')
      : t('All Targets');
    return [project, vm, instrument, status].join(' · ');
  }, [filterProjectId, filterVmNr, filterInstrument, filterStatus, t]);

  // Field app controls defined once and placed differently per breakpoint: inline on
  // desktop exactly as before, folded into the filter bar on mobile. Behaviour and
  // styling are identical in both - only their position changes.
  // The Field App's filter controls. Menus on desktop and tablet, the OS picker on a
  // phone (components/Select). A project shows its name under its id, where the name
  // is known - the same list the dashboard and the report dialog offer.
  const projectName = (id: string) => projectOptions.find(p => p.project_id === id)?.project_name || undefined;
  const projectIdSelect = (
    <Select
      className="field-control"
      value={filterProjectId}
      onChange={setFilterProjectId}
      ariaLabel={t('Project ID')}
      options={[
        { value: 'all', label: t('All Projects') },
        ...uniqueProjectIds.map(id => ({ value: id, label: id, description: projectName(id), group: t('Projects') }))
      ]}
    />
  );

  const vmNrSelect = (
    <Select
      className="field-control"
      icon={<Shield size={14} />}
      value={filterVmNr}
      onChange={setFilterVmNr}
      ariaLabel={t('All VM Nr.')}
      options={[
        { value: 'all', label: t('All VM Nr.') },
        ...allVmNumbers.map(vm => ({ value: vm.toString(), label: `VM ${vm}` }))
      ]}
    />
  );

  const instrumentSelect = (
    <Select
      className="field-control"
      icon={<Layers size={14} />}
      value={filterInstrument}
      onChange={setFilterInstrument}
      ariaLabel={t('All Instruments')}
      options={[
        { value: 'all', label: t('All Instruments') },
        { value: 'georadar', label: t('Georadar') },
        { value: 'magnetic', label: t('Magnetic') }
      ]}
    />
  );

  const statusSelect = (
    <Select
      className="field-control field-control--status"
      size="sm"
      value={filterStatus}
      onChange={setFilterStatus}
      ariaLabel={t('Status filter')}
      options={[
        { value: 'all', label: t('All Targets') },
        { value: 'investigated', label: t('Investigated') },
        { value: 'pending', label: t('Pending') }
      ]}
    />
  );

  const exportCsvButton = (
    <button
      type="button"
      className="btn-secondary field-export"
      onClick={() => setReportDialog('field')}
      disabled={!isOnline}
      title={isOnline ? t('Export CSV') : t('Network Connection: Offline')}
    >
      <Table2 size={14} aria-hidden="true" />
      {t('Export CSV')}
    </button>
  );

  // The map's quick summary: investigated out of total, overall and per instrument.
  const isInvestigatedPoint = (p: LocalPoint) => p.local_status === 'investigated';
  const byInstrument = (name: string) => filteredPoints.filter(p => p.instrument?.toLowerCase() === name);
  const magneticPoints = byInstrument('magnetic');
  const georadarPoints = byInstrument('georadar');
  const quickSummaryRows = [
    { label: t('INVESTIGATION PROGRESS'), done: filteredPoints.filter(isInvestigatedPoint).length, total: filteredPoints.length },
    { label: t('MAGNETIC TARGETS'), done: magneticPoints.filter(isInvestigatedPoint).length, total: magneticPoints.length },
    { label: t('GEORADAR TARGETS'), done: georadarPoints.filter(isInvestigatedPoint).length, total: georadarPoints.length },
  ];

  // The one place the access rule is applied to routing. A surface whose flag is
  // gone - revoked between sessions, or taken away by the /api/auth/me refresh while
  // the tab is open - falls back to the overview instead of rendering a view the
  // server will 403. Derived rather than corrected in an effect, so there is no
  // window in which the wrong surface is on screen.
  const view: AppView =
    (requestedView === 'field' && !access.can_field) ||
    (requestedView === 'dashboard' && !access.can_dashboard)
      ? 'overview'
      : requestedView;

  return (
    <div className="app-root">
      
      {!isLoggedIn ? (
        <>
          <Landing
            lang={lang}
            onLangChange={setLang}
            theme={theme}
            onToggleTheme={toggleTheme}
            onSignIn={() => { setAuthView('login'); setShowAuthModal(true); }}
            onRequestAccess={() => { setAuthView('signup'); setShowAuthModal(true); }}
          />

          {/* Glassmorphic Login/Signup Modal Overlay */}
          {showAuthModal && (
            <div style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              backgroundColor: 'rgba(9, 13, 22, 0.8)',
              backdropFilter: 'blur(16px)',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px'
            }}>
              
              <div className="glass-panel" style={{
                width: '100%',
                maxWidth: '420px',
                padding: '32px 28px',
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
                boxShadow: '0 25px 60px rgba(0,0,0,0.8)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                position: 'relative',
                animation: 'modal-scale-up 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                textAlign: 'left',
                backgroundColor: 'var(--surface)',
                borderRadius: '14px'
              }}>
                
                {/* Close Button */}
                <button 
                  onClick={() => setShowAuthModal(false)}
                  style={{
                    position: 'absolute',
                    top: '16px',
                    right: '16px',
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <X size={18} />
                </button>

                {/* Modal Header with Original Logo */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '14px' }}>
                  <img src="/logo.png" alt="Nolte Logo" style={{ height: '42px', width: 'auto', objectFit: 'contain' }} />
                  <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: '#fff', margin: 0 }}>
                    {authView === 'login' ? (lang === 'EN' ? 'Sign In' : 'Anmelden') : authView === 'signup' ? (lang === 'EN' ? 'Create Account' : 'Konto erstellen') : (lang === 'EN' ? 'Reset Password' : 'Passwort zurücksetzen')}
                  </h2>
                  <span style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.05em' }}>
                    NOLTE GEOSERVICES PLATFORM
                  </span>
                </div>

                {/* Login View */}
                {authView === 'login' && (
                  <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="login-username">{t('Username / Operator ID')}</label>
                      <input
                        id="login-username"
                        type="text"
                        className="form-input"
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                        placeholder={t('Enter collector or dashboard')}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="login-password">{t('Security Password')}</label>
                      <input
                        id="login-password"
                        type="password"
                        className="form-input"
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        placeholder="••••••••"
                        required
                      />
                    </div>
                    
                    {/* Demo helpers */}
                    <div style={{ padding: '8px 10px', backgroundColor: 'rgba(245, 130, 32, 0.06)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(245, 130, 32, 0.2)', fontSize: '0.68rem', color: '#f58220', lineHeight: '1.4' }}>
                      <b>{t('Database Accounts:')}</b><br />
                      - {t('Field Collector')}: <b>collector</b> | password<br />
                      - {t('Dashboard Viewer')}: <b>dashboard</b> | password
                    </div>

                    <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '4px', backgroundColor: '#f58220' }}>
                      {lang === 'EN' ? 'Sign In' : 'Anmelden'} <ArrowRight size={14} />
                    </button>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', marginTop: '4px' }}>
                      <span onClick={() => setAuthView('forgot')} style={{ color: '#64748b', cursor: 'pointer' }}>
                        {lang === 'EN' ? 'Forgot Password?' : 'Passwort vergessen?'}
                      </span>
                      <span onClick={() => setAuthView('signup')} style={{ color: '#f58220', cursor: 'pointer', fontWeight: 600 }}>
                        {lang === 'EN' ? 'Create Account' : 'Konto erstellen'}
                      </span>
                    </div>
                  </form>
                )}

                {/* Create Account View */}
                {authView === 'signup' && (
                  <form onSubmit={handleSignup} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="signup-fullname">{t('Full Name')}</label>
                      <input 
                        id="signup-fullname"
                        type="text" 
                        className="form-input" 
                        value={signupFullName}
                        onChange={(e) => setSignupFullName(e.target.value)}
                        placeholder="Eric Musonera" 
                        required 
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="signup-username">{t('Username / Operator ID')}</label>
                      <input 
                        id="signup-username"
                        type="text" 
                        className="form-input" 
                        value={signupUsername}
                        onChange={(e) => setSignupUsername(e.target.value)}
                        placeholder="e.g. collector_west" 
                        required 
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="signup-email">{t('Corporate Email')}</label>
                      <input 
                        id="signup-email"
                        type="email" 
                        className="form-input" 
                        value={signupEmail} 
                        onChange={(e) => setSignupEmail(e.target.value)} 
                        placeholder="name@nolte-geoservices.de" 
                        required 
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="signup-password">{t('Create Password')}</label>
                      <input 
                        id="signup-password"
                        type="password" 
                        className="form-input" 
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        placeholder="••••••••" 
                        required 
                      />
                    </div>
                    
                    <div style={{ padding: '6px 8px', backgroundColor: 'rgba(16, 185, 129, 0.06)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(16,185,129,0.2)', fontSize: '0.68rem', color: '#10b981', lineHeight: '1.3' }}>
                      <b>{t('Development Mode:')}</b> {t('Account will be registered and logged in instantly. Access/Role is assigned at database level.')}
                    </div>

                    <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '4px', backgroundColor: '#f58220' }}>
                      {lang === 'EN' ? 'Create & Sign In' : 'Erstellen & Anmelden'}
                    </button>
                    <div style={{ textAlign: 'center', fontSize: '0.72rem', marginTop: '4px' }}>
                      <span onClick={() => setAuthView('login')} style={{ color: '#64748b', cursor: 'pointer' }}>
                        {lang === 'EN' ? 'Back to Sign In' : 'Zurück zur Anmeldung'}
                      </span>
                    </div>
                  </form>
                )}

                {authView === 'forgot' && (
                  <form onSubmit={handleForgot} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="forgot-email">{t('Username or Email')}</label>
                      <input 
                        id="forgot-email"
                        type="text" 
                        className="form-input" 
                        placeholder={t('Enter your email')}
                        required 
                      />
                    </div>
                    <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '4px', backgroundColor: '#f58220' }}>
                      {lang === 'EN' ? 'Send Recovery Email' : 'Wiederherstellungs-E-Mail senden'}
                    </button>
                    <div style={{ textAlign: 'center', fontSize: '0.72rem', marginTop: '4px' }}>
                      <span onClick={() => setAuthView('login')} style={{ color: '#64748b', cursor: 'pointer' }}>
                        {lang === 'EN' ? 'Back to Sign In' : 'Zurück zur Anmeldung'}
                      </span>
                    </div>
                  </form>
                )}

              </div>
            </div>
          )}

        </>
      ) : (
        
        // 2. Logged In Screens Layout
        <>
        <div className="app-container">
          {/* The rail: the app's primary navigation. A bottom bar on a phone - see the
              mobile block in index.css. Styling lives entirely in the stylesheet, so the
              markup here carries structure and state only. */}
          <aside className={`app-sidebar${isSidebarCollapsed ? ' collapsed' : ''}`} aria-label={t('Main navigation')}>
            <div className="sidebar-top">

              {/* The logo is the way to the Overview - there is no nav item for it. Never
                  locked: the overview needs no permission and calls no API. */}
              <button
                type="button"
                className={`sidebar-logo${view === 'overview' ? ' active' : ''}`}
                onClick={() => changeView('overview')}
                aria-label={t('Overview')}
                aria-current={view === 'overview' ? 'page' : undefined}
                title={t('Overview')}
              >
                <img src="/logo.png" alt="" />
              </button>

              <nav className="sidebar-menu">
                <button
                  type="button"
                  className={`sidebar-item${view === 'field' && activeTab === 'map' ? ' active' : ''}${access.can_field ? '' : ' locked'}`}
                  onClick={() => openSurface('field')}
                  aria-current={view === 'field' ? 'page' : undefined}
                  title={access.can_field ? t('Field App') : t('Field App - permission required')}
                >
                  <Compass size={20} aria-hidden="true" />
                  <span className="sidebar-item-label">{t('Field App')}</span>
                  {!access.can_field && <Lock size={12} className="sidebar-item-lock" aria-hidden="true" />}
                </button>

                <button
                  type="button"
                  className={`sidebar-item${view === 'dashboard' ? ' active' : ''}${access.can_dashboard ? '' : ' locked'}`}
                  onClick={() => openSurface('dashboard')}
                  aria-current={view === 'dashboard' ? 'page' : undefined}
                  title={access.can_dashboard ? t('Dashboard') : t('Dashboard - permission required')}
                >
                  <BarChart3 size={20} aria-hidden="true" />
                  <span className="sidebar-item-label">{t('Dashboard')}</span>
                  {!access.can_dashboard && <Lock size={12} className="sidebar-item-lock" aria-hidden="true" />}
                </button>

                {access.is_admin && (
                  <button
                    type="button"
                    className="sidebar-item"
                    onClick={() => setShowAdminPanel(true)}
                    title={t('Permission requests')}
                  >
                    <ShieldCheck size={20} aria-hidden="true" />
                    <span className="sidebar-item-label">{t('Permissions')}</span>
                    {pendingRequests.length > 0 && (
                      <span className="sidebar-item-badge">{pendingRequests.length}</span>
                    )}
                  </button>
                )}

                {access.is_admin && (
                  <button
                    type="button"
                    className="sidebar-item"
                    onClick={() => setShowUsersPanel(true)}
                    title={t('Users')}
                  >
                    <Users size={20} aria-hidden="true" />
                    <span className="sidebar-item-label">{t('Users')}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="sidebar-item"
                  data-tour="field.sync"
                  onClick={() => handleSync()}
                  disabled={syncing}
                  title={t('Sync Data')}
                >
                  <RefreshCw size={20} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
                  <span className="sidebar-item-label">{t('Sync')}</span>
                  {pendingSyncCount > 0 && (
                    <span className="sidebar-item-badge">{pendingSyncCount}</span>
                  )}
                </button>

                {/* Connection state: not a control, so not a button. The state is in the
                    colour and the word and the icon, never the colour alone. */}
                <div
                  className="sidebar-item sidebar-status"
                  data-online={isOnline ? 'true' : 'false'}
                  role="status"
                  title={isOnline ? t('Network Connection: Online') : t('Network Connection: Offline')}
                >
                  {isOnline ? <Wifi size={20} aria-hidden="true" /> : <WifiOff size={20} aria-hidden="true" />}
                  <span className="sidebar-item-label">{isOnline ? t('Online') : t('Offline')}</span>
                </div>
              </nav>
            </div>

            <div className="sidebar-bottom">
              <div className="sidebar-profile">
                <button
                  type="button"
                  className="sidebar-avatar"
                  onClick={() => setShowUserModal(!showUserModal)}
                  aria-haspopup="dialog"
                  aria-expanded={showUserModal}
                  aria-label={`${t('User')}: ${currentUserFullName || currentUser}`}
                  title={`${t('User')}: ${currentUserFullName || currentUser}`}
                >
                  {initialsFor(currentUserFullName || currentUser)}
                </button>

                {/* Desktop keeps the anchored pop-up next to the avatar. On a phone the
                    rail is a fixed bottom bar, so the menu renders as a sheet outside this
                    subtree instead. */}
                {showUserModal && !isMobile && (
                  <div className="profile-popover" role="dialog" aria-label={t('Profile and settings')}>
                    <ProfileMenu
                      t={t}
                      lang={lang}
                      onLangChange={setLang}
                      theme={theme}
                      onToggleTheme={toggleTheme}
                      fullName={currentUserFullName}
                      username={currentUser}
                      role={userRole}
                      access={access}
                      onStartTour={startTour}
                      onSignOut={() => { setShowUserModal(false); handleSignOut(); }}
                      withSettings={false}
                    />
                  </div>
                )}
              </div>

              {/* Language and theme sit in the rail on desktop. On a phone they move into
                  the profile sheet behind the avatar - the bar has no room for them. */}
              {!isMobile && (
                <>
                  <LangSwitch lang={lang} onChange={setLang} compact />
                  <button
                    type="button"
                    className="sidebar-theme"
                    onClick={toggleTheme}
                    aria-label={theme === 'dark' ? t('Switch to Light mode') : t('Switch to Dark mode')}
                    title={theme === 'dark' ? t('Switch to Light mode') : t('Switch to Dark mode')}
                  >
                    {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
                  </button>
                </>
              )}
            </div>
          </aside>

          {/* Collapse handle. It follows the rail's edge by CSS (the adjacent-sibling rule
              in index.css), so it needs no position of its own here. */}
          <button
            type="button"
            className="sidebar-toggle-handle"
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            aria-label={isSidebarCollapsed ? t('Expand Sidebar (Undock)') : t('Collapse Sidebar (Dock)')}
            title={isSidebarCollapsed ? t('Expand Sidebar (Undock)') : t('Collapse Sidebar (Dock)')}
          >
            {isSidebarCollapsed ? <ChevronsRight size={14} aria-hidden="true" /> : <ChevronsLeft size={14} aria-hidden="true" />}
          </button>

          {/* Main Interface Router.
              Ordered so the overview is the fallback arm, not the dashboard. The
              dashboard used to be the `else` of a binary, which meant any value that
              was not 'collector' rendered it - the one surface that 403s without
              can_dashboard. An unrecognised view now lands on the page that needs no
              permission and fetches nothing. */}
          {view === 'field' ? (
            
            // ROLE A: FIELD DATA COLLECTOR VIEW (FIELD APP)
            <main className="collector-main">

              {/* The working panel: the target list, or the form for the open target,
                  or the confirmation once it is filed. */}
              <section className="glass-panel collector-sidebar">

                {formPoint ? (
                  <FeedbackForm
                    lang={lang}
                    point={formPoint}
                    currentUser={currentUserFullName}
                    currentUserUsername={currentUser}
                    lastTeamsTools={lastTeamsTools}
                    isEditLocationMode={isEditLocationMode}
                    setIsEditLocationMode={setIsEditLocationMode}
                    onSave={handleSaveFeedback}
                    onCancel={() => {
                      setSelectedPoint(null);
                      setBlankFormPointId(null);
                    }}
                  />
                ) : submission ? (
                  <SubmissionConfirmation
                    lang={lang}
                    vmNr={submission.vmNr}
                    syncState={submissionSyncState}
                    onOpenForm={() => {
                      setBlankFormPointId(submission.point.id);
                      setSelectedPoint(submission.point);
                      setSubmission(null);
                    }}
                    onBackToList={() => setSubmission(null)}
                  />
                ) : (
                  <div className="collector-panel-body">

                    {/* The survey area. On a phone the project picker and the CSV export
                        move into the folded filter bar below - they are not what the crew
                        reaches for first in the field. */}
                    <div className="collector-area" data-tour="field.area">
                      <span className="collector-kicker">{t('Active Survey Area')}</span>
                      <h2 className="collector-title" title={activeAreaLabel}>{activeAreaLabel}</h2>
                      {!isMobile && (
                        <label className="collector-field">
                          <span className="collector-field-label">{t('Project ID')}</span>
                          {projectIdSelect}
                        </label>
                      )}
                      <span className="collector-count num">
                        {filteredPoints.length} {t('Targets Detected')}
                      </span>

                      {/* Filtered CSV export, same project + date-range filters as the dashboard report */}
                      {!isMobile && exportCsvButton}
                    </div>

                    {activeTab === 'map' ? (
                      <>
                        <div className="collector-filters" data-tour="field.filters">
                          <div className="select-with-icon">
                            <Search size={14} className="select-with-icon-glyph" aria-hidden="true" />
                            <input
                              type="text"
                              className="form-input field-control"
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              placeholder={t('Search targets...')}
                              aria-label={t('Search targets...')}
                            />
                          </div>

                          {/* A phone folds the secondary filters (project, VM Nr., instrument,
                              status) and the CSV export behind a one-line bar; the search box
                              above stays visible because it is the primary control here. */}
                          {isMobile ? (
                            <FilterBar label={t('Filter')} summary={fieldFilterSummary} toggleLabel={t('Show filters')}>
                              <label className="collector-field">
                                <span className="collector-field-label">{t('Project ID')}</span>
                                {projectIdSelect}
                              </label>
                              {vmNrSelect}
                              {instrumentSelect}
                              {statusSelect}
                              {exportCsvButton}
                            </FilterBar>
                          ) : (
                            <div className="collector-filter-grid">
                              {vmNrSelect}
                              {instrumentSelect}
                            </div>
                          )}
                        </div>

                        <div className="collector-list-wrap" data-tour="field.list">
                          <div className="collector-list-head">
                            <span className="collector-kicker collector-kicker--muted">
                              {t('TARGET LISTING')} <span className="num">({filteredPoints.length})</span>
                            </span>
                            {/* On a phone the status filter lives in the folded bar with the rest. */}
                            {!isMobile && statusSelect}
                          </div>
                          <div className="collector-list-scroll" onScroll={handleTargetListScroll}>
                            {visibleTargetPoints.map((point) => {
                              const isInvestigated = point.local_status === 'investigated';
                              let statusText = t('PENDING');
                              // The state, not the colour. Which colour that becomes is the
                              // stylesheet's business.
                              let status: 'pending' | 'empty' | 'found' = 'pending';

                              if (isInvestigated && point.feedback) {
                                const fund = point.feedback.fundstueck;
                                statusText = fund === 'Sonstige' ? (point.feedback.other || 'Sonstige') : fund;
                                status = fund === 'ohne Fund' ? 'empty' : 'found';
                              }

                              const isSelected = selectedPoint?.id === point.id;
                              return (
                                <button
                                  type="button"
                                  key={point.id}
                                  className={`target-card${isSelected ? ' active' : ''}`}
                                  aria-pressed={isSelected}
                                  onClick={() => setSelectedPoint(point)}
                                >
                                  <span className="target-card-head">
                                    <span className="target-card-vm num">VM {point.vm_nr}</span>
                                    <span className="status-chip" data-status={status} title={statusText}>
                                      {statusText}
                                    </span>
                                  </span>
                                  <span className="target-card-meta">
                                    {point.instrument?.toUpperCase()} · {point.layer?.replace('Stoerkoerper ', '') || t('Target Layer')}
                                  </span>
                                  <span className="target-card-depth">
                                    <span className="target-card-depth-label">{t('EVALUATED DEPTH')}</span>
                                    <span className="target-card-depth-value num">
                                      {point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')}
                                    </span>
                                  </span>
                                </button>
                              );
                            })}

                            {visibleTargetPoints.length < filteredPoints.length && (
                              <button
                                type="button"
                                className="btn-secondary list-more"
                                onClick={() => setVisibleTargetCount(c => c + TARGET_PAGE_SIZE)}
                              >
                                {t('Show more')} <span className="num">({filteredPoints.length - visibleTargetPoints.length})</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <ImportExport
                        lang={lang}
                        onImportSuccess={handleImportPoints}
                        onSeedRequest={handleSeedRequest}
                        isOnline={isOnline}
                      />
                    )}
                  </div>
                )}
              </section>

              {/* The map, with the quick summary floating over it. On a phone the summary
                  drops out of the overlay and stacks above the map - at 380px a floating
                  card would cover most of the map it floats over. */}
              <section className="glass-panel map-container-section" data-popup-open={selectedPoint ? '' : undefined}>
                <div className="quick-summary-panel">
                  <span className="quick-summary-title">{t('Quick Summary')}</span>
                  {quickSummaryRows.map(row => (
                    <div className="quick-summary-row" key={row.label}>
                      <div className="quick-summary-row-head">
                        <span>{row.label}</span>
                        <span className="num">{row.done} / {row.total}</span>
                      </div>
                      {/* One colour for all three: each bar is the same measure - the
                          share investigated - of a different slice. */}
                      <div className="quick-summary-bar" aria-hidden="true">
                        <span style={{ width: `${(row.done / Math.max(1, row.total)) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="collector-map-wrap" data-tour="field.map">
                  <FieldMap
                    lang={lang}
                    points={filteredPoints}
                    selectedPoint={selectedPoint}
                    onSelectPoint={handleSelectPoint}
                    viewMode="collector"
                    isEditLocationMode={isEditLocationMode}
                    onPointPositionChange={handlePointPositionChange}
                    isMobile={isMobile}
                  />
                </div>
              </section>

            </main>
          ) : view === 'dashboard' ? (
            
            // ROLE B: END USER / DASHBOARD VIEW (DASHBOARD)
            <main className={`dashboard-main${isMobile ? ' dashboard-main--mobile' : ''}`}>

              {/* On desktop the map is a full-bleed background the panels float over. On
                  mobile there is nothing to float over - the map becomes one block in the
                  reading order, handed to Dashboard as a slot. */}
              {!isMobile && (
                <div className="dashboard-map-layer">
                  <FieldMap
                    lang={lang}
                    points={dashboardFilteredPoints}
                    selectedPoint={selectedPoint}
                    onSelectPoint={handleSelectPoint}
                    viewMode="dashboard"
                    isEditLocationMode={false}
                  />
                </div>
              )}

              {/* The panels' layer over the map. Transparent to the pointer, so the map
                  between the panels stays usable; each panel takes the pointer back. */}
              <div className={isMobile ? undefined : 'dashboard-panel-layer'}>
                <Dashboard
                  lang={lang}
                  points={points}
                  filteredPoints={dashboardFilteredPoints}
                  selectedPoint={selectedPoint}
                  onSelectPoint={handleSelectPoint}
                  isOnline={isOnline}
                  onSeedRequest={handleSeedRequest}
                  addDataOpen={addDataOpen}
                  setAddDataOpen={setAddDataOpen}
                  filterStatus={filterStatus}
                  setFilterStatus={setFilterStatus}
                  filterInstrument={filterInstrument}
                  setFilterInstrument={setFilterInstrument}
                  filterDepth={filterDepth}
                  setFilterDepth={setFilterDepth}
                  filterProjectId={filterProjectId}
                  setFilterProjectId={setFilterProjectId}
                  projectOptions={projectOptions}
                  onGenerateReport={handleOpenDashboardReport}
                  isMobile={isMobile}
                  mapSlot={isMobile ? (
                    <FieldMap
                      lang={lang}
                      points={dashboardFilteredPoints}
                      selectedPoint={selectedPoint}
                      onSelectPoint={handleSelectPoint}
                      viewMode="dashboard"
                      isEditLocationMode={false}
                      isMobile
                    />
                  ) : undefined}
                />
              </div>

            </main>

          ) : (

            // POST-LOGIN HOME: orientation, and a guided tour of each surface this
            // account may actually open.
            <Overview
              lang={lang}
              access={access}
              onStartTour={startTour}
              onOpenSurface={openSurface}
            />

          )}

        </div>
        </>
      )}

      {/* Phone profile sheet. Rendered here, outside .app-sidebar, so it anchors to the
          viewport rather than to the fixed bar. Holds everything the desktop rail shows
          around the avatar - profile, language, theme, tours, sign out. */}
      {isLoggedIn && isMobile && showUserModal && (
        <>
          <div
            className="profile-sheet-backdrop"
            onClick={() => setShowUserModal(false)}
            aria-hidden="true"
          />
          <div className="profile-sheet" role="dialog" aria-label={t('Profile and settings')}>
            <ProfileMenu
              t={t}
              lang={lang}
              onLangChange={setLang}
              theme={theme}
              onToggleTheme={toggleTheme}
              fullName={currentUserFullName}
              username={currentUser}
              role={userRole}
              access={access}
              onStartTour={startTour}
              onSignOut={() => { setShowUserModal(false); handleSignOut(); }}
              onClose={() => setShowUserModal(false)}
              withSettings
            />
          </div>
        </>
      )}

      {/* Guided tour over the live surface. Ends by itself if that surface leaves the
          screen, so nothing here has to remember to stop it. */}
      {isLoggedIn && tour && (
        <TourHost
          key={`${tour}-${tourRun}`}
          tour={tour}
          lang={lang}
          onScreen={view === tour}
          onClose={() => setTour(null)}
        />
      )}

      {/* Floating Action Notifications */}
      {/* Forced password change. No dismiss: the server refuses every surface
          until this is done, so an escape hatch would only strand the user. */}
      {isLoggedIn && mustChangePassword && (
        <div className="permission-overlay">
          <div className="permission-dialog" onClick={e => e.stopPropagation()}>
            <div className="permission-dialog-head">
              <Lock size={18} />
              <h3>{t('Choose a new password')}</h3>
            </div>
            <p>{t('Your administrator issued a temporary password. Set your own to continue.')}</p>

            <input
              className="permission-note"
              type="password"
              autoComplete="current-password"
              placeholder={t('Temporary password')}
              value={pwCurrent}
              onChange={e => setPwCurrent(e.target.value)}
            />
            <input
              className="permission-note"
              type="password"
              autoComplete="new-password"
              placeholder={t('New password')}
              value={pwNext}
              onChange={e => setPwNext(e.target.value)}
            />
            <input
              className="permission-note"
              type="password"
              autoComplete="new-password"
              placeholder={t('Repeat new password')}
              value={pwRepeat}
              onChange={e => setPwRepeat(e.target.value)}
            />
            {pwError && <p className="permission-error">{pwError}</p>}

            <div className="permission-actions">
              <button className="permission-btn" onClick={handleSignOut}>{t('Sign Out')}</button>
              <button className="permission-btn primary" onClick={submitPasswordChange} disabled={pwSaving}>
                {pwSaving ? t('Saving...') : t('Save password')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin: users and their access */}
      {showUsersPanel && access.is_admin && (
        <div className="permission-overlay" onClick={() => setShowUsersPanel(false)}>
          <div className="permission-dialog wide" onClick={e => e.stopPropagation()}>
            <div className="permission-dialog-head">
              <Users size={18} />
              <h3>{t('Users')}</h3>
            </div>

            {issuedPassword && (
              <div className="issued-password">
                <strong>{t('Temporary password for')} @{issuedPassword.username}</strong>
                <code>{issuedPassword.password}</code>
                <span>{t('Shown once. Pass it on now - it cannot be displayed again.')}</span>
                <button className="permission-btn" onClick={() => setIssuedPassword(null)}>
                  {t('Done')}
                </button>
              </div>
            )}

            <ul className="permission-request-list">
              {userRows.map(row => (
                <li key={row.id}>
                  <div className="permission-request-who">
                    <strong>{row.full_name || row.username}</strong>
                    <span>@{row.username}</span>
                    {row.must_change_password && <span className="pill">{t('reset pending')}</span>}
                  </div>
                  <div className="access-toggles">
                    <label>
                      <input
                        type="checkbox"
                        checked={row.can_field}
                        onChange={e => updateUserAccess(row, { can_field: e.target.checked })}
                      />
                      {t('Field App')}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.can_dashboard}
                        onChange={e => updateUserAccess(row, { can_dashboard: e.target.checked })}
                      />
                      {t('Dashboard')}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.is_admin}
                        onChange={e => updateUserAccess(row, { is_admin: e.target.checked })}
                      />
                      {t('Administrator')}
                    </label>
                    <button className="permission-btn" onClick={() => resetUserPassword(row)}>
                      {t('Reset password')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="permission-actions">
              <button className="permission-btn" onClick={() => setShowUsersPanel(false)}>
                {t('Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permission request dialog - shown when a locked surface is opened */}
      {permissionPrompt && (
        <div className="permission-overlay" onClick={() => setPermissionPrompt(null)}>
          <div className="permission-dialog" onClick={e => e.stopPropagation()}>
            <div className="permission-dialog-head">
              <Lock size={18} />
              <h3>
                {permissionPrompt === 'field' ? t('Field App') : t('Dashboard')}
              </h3>
            </div>

            {permissionSent === permissionPrompt ? (
              <>
                <p>{t('Your request has been sent to the administrator. You will get access once it is approved.')}</p>
                <div className="permission-actions">
                  <button className="permission-btn primary" onClick={() => setPermissionPrompt(null)}>
                    {t('Close')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {t('You do not have permission to open this area. Request access from your administrator.')}
                </p>
                <textarea
                  className="permission-note"
                  rows={3}
                  placeholder={t('Optional: why do you need access?')}
                  value={permissionNote}
                  onChange={e => setPermissionNote(e.target.value)}
                />
                <div className="permission-actions">
                  <button className="permission-btn" onClick={() => setPermissionPrompt(null)}>
                    {t('Cancel')}
                  </button>
                  <button
                    className="permission-btn primary"
                    onClick={submitPermissionRequest}
                    disabled={permissionSending}
                  >
                    {permissionSending ? t('Sending...') : t('Request permission')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Admin: decide pending requests */}
      {showAdminPanel && access.is_admin && (
        <div className="permission-overlay" onClick={() => setShowAdminPanel(false)}>
          <div className="permission-dialog wide" onClick={e => e.stopPropagation()}>
            <div className="permission-dialog-head">
              <ShieldCheck size={18} />
              <h3>{t('Permission requests')}</h3>
            </div>

            {pendingRequests.length === 0 ? (
              <p>{t('No pending requests.')}</p>
            ) : (
              <ul className="permission-request-list">
                {pendingRequests.map(req => (
                  <li key={req.id}>
                    <div className="permission-request-who">
                      <strong>{req.user.full_name || req.user.username}</strong>
                      <span>@{req.user.username}</span>
                    </div>
                    <div className="permission-request-what">
                      {req.surface === 'field' ? t('Field App') : t('Dashboard')}
                      {req.message && <em>"{req.message}"</em>}
                    </div>
                    <div className="permission-actions">
                      <button className="permission-btn" onClick={() => decideRequest(req.id, false)}>
                        {t('Deny')}
                      </button>
                      <button className="permission-btn primary" onClick={() => decideRequest(req.id, true)}>
                        {t('Approve')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="permission-actions">
              <button className="permission-btn" onClick={() => setShowAdminPanel(false)}>
                {t('Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast. A raised panel with ink text, the type carried by the icon and a rule in
          its colour - the old solid green and red fills put white text at 2.5:1 and
          3.8:1. Positioned and animated in index.css. */}
      {toast && (
        <div className="toast" data-type={toast.type} role="status">
          {toast.type === 'success' && <CheckCircle2 size={16} aria-hidden="true" />}
          {toast.type === 'error' && <AlertTriangle size={16} aria-hidden="true" />}
          {toast.type === 'info' && <RefreshCw size={16} className="animate-spin" aria-hidden="true" />}
          <span>{toast.message}</span>
        </div>
      )}

      {reportDialog && (
        <ReportDialog
          lang={lang}
          apiBase={API_BASE}
          projects={projectOptions}
          allowPdf={reportDialog === 'dashboard'}
          title={reportDialog === 'field' ? t('Export CSV') : undefined}
          onClose={() => setReportDialog(false)}
        />
      )}

    </div>
  );
}
