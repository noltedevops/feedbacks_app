import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { db, type LocalPoint, type PendingFeedback, type TeamsTools } from './db/indexedDb';
import { FieldMap } from './components/FieldMap';
import { Dashboard, matchesDepthBucket } from './components/Dashboard';
import { FeedbackForm } from './components/FeedbackForm';
import { ImportExport } from './components/ImportExport';
import { ReportDialog, type ProjectOption } from './components/ReportDialog';
import { FilterBar } from './components/FilterBar';
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
  Menu
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

type AppRole = 'collector' | 'dashboard';

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

// Modern segmented language switch with a sliding highlight.
// `compact` renders the narrow variant used inside the 80px app sidebar.
function LangSwitch({ lang, onChange, compact = false }: {
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
  const syncColor = syncState === 'synced' ? '#10b981' : syncState === 'syncing' ? '#38bdf8' : '#f59e0b';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '18px',
      height: '100%',
      textAlign: 'center',
      padding: '8px 4px',
      overflowY: 'auto',
      animation: 'fade-in-up 0.25s ease-out'
    }}>
      <div style={{
        width: '64px',
        height: '64px',
        borderRadius: '50%',
        backgroundColor: 'rgba(16, 185, 129, 0.12)',
        border: '1px solid rgba(16, 185, 129, 0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}>
        <CheckCircle2 size={32} color="#10b981" />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#f1f5f9', margin: 0 }}>
          {t('Submission Received')}
        </h2>
        <p style={{ fontSize: '0.82rem', color: '#cbd5e1', margin: 0, lineHeight: 1.5 }}>
          {t('Thank you! Your record has been submitted.')}
        </p>
        <span style={{ fontSize: '0.7rem', color: '#8c9f96' }}>
          {t('Target')} VM {vmNr}
        </span>
      </div>

      {/* Non-blocking sync indicator */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderRadius: '999px',
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
        border: `1px solid ${syncColor}33`,
        fontSize: '0.68rem',
        color: syncColor,
        fontWeight: 600
      }}>
        {syncState === 'offline'
          ? <WifiOff size={12} />
          : <RefreshCw size={12} className={syncState === 'syncing' ? 'animate-spin' : ''} />}
        {syncLabel[syncState]}
      </div>

      <div style={{ width: '100%', height: '1px', backgroundColor: 'rgba(255, 255, 255, 0.06)' }} />

      <p style={{ fontSize: '0.85rem', color: '#e2e8f0', fontWeight: 600, margin: 0 }}>
        {t('Would you like to add another record?')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
        <button
          type="button"
          className="btn-primary"
          onClick={onOpenForm}
          style={{ padding: '11px', fontSize: '0.8rem', justifyContent: 'center', gap: '8px', width: '100%' }}
        >
          <FilePlus2 size={15} />
          {t('Open Field Application Form')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onBackToList}
          style={{ padding: '10px', fontSize: '0.78rem', justifyContent: 'center', gap: '8px', width: '100%' }}
        >
          <ListChecks size={14} />
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
  const [userRole, setUserRole] = useState<AppRole>('collector');
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
  
  // Theme States
  const [theme, setTheme] = useState<'dark' | 'light'>((localStorage.getItem('theme') as any) || 'dark');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Narrow screens reflow both surfaces into a single scrolling column. Everything a
  // media query can do stays in index.css; this drives only the parts CSS cannot reach -
  // chiefly moving the dashboard map out of its background layer and into the flow.
  const isMobile = useIsMobile();

  useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }, [theme]);
  
  // Auth Form State
  const [authView, setAuthView] = useState<'login' | 'signup' | 'forgot'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupFullName, setSignupFullName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);

  // Language & Carousel States
  const [lang, setLang] = useState<AppLang>((localStorage.getItem('nolte_lang') as AppLang) || 'EN');
  const [showPlatformDropdown, setShowPlatformDropdown] = useState(false);
  const [activeFieldImg, setActiveFieldImg] = useState(0);

  // Landing header on phones: the brand, the two nav tabs, the language switch and
  // both auth buttons cannot share one row at 375px, so everything but the brand
  // moves into a drawer. The trigger and the drawer are hidden by a media query
  // rather than by `isMobile`, so the desktop render is byte-identical to before.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Remember the chosen language across sessions and keep <html lang> in sync
  useEffect(() => {
    localStorage.setItem('nolte_lang', lang);
    document.documentElement.lang = lang === 'DE' ? 'de' : 'en';
  }, [lang]);

  // Translator for the signed-in application shell
  const t = makeT(lang);

  // Auto rotate field screenshots carousel
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveFieldImg(prev => (prev + 1) % 4);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  // Field operations showcase (images live in /public)
  const fieldSurveys = lang === 'EN' ? [
    { img: '/field1.png', title: 'Magnetometer Survey', desc: 'Hand-pushed multi-sensor gradiometer cart with RTK-GPS positioning' },
    { img: '/field2.png', title: 'Georadar Survey (GPR)', desc: 'Tablet-controlled GPR cart profiling dense vegetation and embankments' },
    { img: '/field3.png', title: 'Rail Corridor Clearance', desc: 'Track-guided sensor array for UXO detection in active rail infrastructure' },
    { img: '/field4.png', title: 'Vehicle-Towed Array', desc: 'High-throughput towed magnetometer array for large open areas' }
  ] : [
    { img: '/field1.png', title: 'Magnetikmessung', desc: 'Handgeführter Multisensor-Gradiometerwagen mit RTK-GPS-Ortung' },
    { img: '/field2.png', title: 'Georadar-Messung (GPR)', desc: 'Tablet-gesteuerter GPR-Wagen für dichte Vegetation und Böschungen' },
    { img: '/field3.png', title: 'Räumung im Gleisbereich', desc: 'Gleisgeführtes Sensorarray zur Kampfmittelortung im Bahnbetrieb' },
    { img: '/field4.png', title: 'Fahrzeuggezogenes Array', desc: 'Leistungsstarkes Schlepp-Magnetometerarray für große Freiflächen' }
  ];

  // Every platform entry point (header dropdown + footer links) funnels through login
  const openPlatform = () => {
    setShowPlatformDropdown(false);
    setShowAuthModal(true);
    setAuthView('login');
  };

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
        // userRole doubles as the surface on screen, so land on one this account
        // can actually open: their stored role when allowed, otherwise the other.
        setUserRole(
          role === 'dashboard' && granted.can_dashboard ? 'dashboard'
            : granted.can_field ? 'collector'
            : 'dashboard'
        );
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
        setUserRole(granted.can_field ? 'collector' : 'dashboard');
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
      setUserRole('collector');
      setActiveTab('map');
    } else {
      setUserRole('dashboard');
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
  const projectIdSelect = (
    <select
      className="form-input"
      value={filterProjectId}
      onChange={(e) => setFilterProjectId(e.target.value)}
      title={t('Project ID')}
      style={{
        fontSize: '0.78rem',
        fontWeight: 700,
        height: '28px',
        padding: '0 8px',
        backgroundColor: 'rgba(10, 22, 18, 0.6)',
        borderColor: 'rgba(255, 255, 255, 0.06)',
        color: '#fff',
        width: '100%',
        cursor: 'pointer'
      }}
    >
      <option value="all">{t('All Projects')}</option>
      {uniqueProjectIds.map(id => (
        <option key={id} value={id}>{id}</option>
      ))}
    </select>
  );

  const vmNrSelect = (
    <div className="select-with-icon" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <Shield size={12} style={{ position: 'absolute', left: '8px', color: '#8c9f96', zIndex: 1 }} />
      <select
        className="form-input"
        value={filterVmNr}
        onChange={(e) => setFilterVmNr(e.target.value)}
        title={t('All VM Nr.')}
        style={{ width: '100%', paddingLeft: '26px', fontSize: '0.75rem', appearance: 'none', backgroundColor: 'rgba(10,22,18,0.4)', borderColor: 'rgba(255,255,255,0.06)' }}
      >
        <option value="all">{t('All VM Nr.')}</option>
        {allVmNumbers.map(vm => (
          <option key={vm} value={vm.toString()}>VM {vm}</option>
        ))}
      </select>
    </div>
  );

  const instrumentSelect = (
    <div className="select-with-icon" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <Layers size={12} style={{ position: 'absolute', left: '8px', color: '#8c9f96', zIndex: 1 }} />
      <select
        className="form-input"
        value={filterInstrument}
        onChange={(e) => setFilterInstrument(e.target.value)}
        title={t('All Instruments')}
        style={{ width: '100%', paddingLeft: '26px', fontSize: '0.75rem', appearance: 'none', backgroundColor: 'rgba(10,22,18,0.4)', borderColor: 'rgba(255,255,255,0.06)' }}
      >
        <option value="all">{t('All Instruments')}</option>
        <option value="georadar">{t('Georadar')}</option>
        <option value="magnetic">{t('Magnetic')}</option>
      </select>
    </div>
  );

  const statusSelect = (
    <select
      className="form-input"
      value={filterStatus}
      onChange={(e) => setFilterStatus(e.target.value)}
      title={t('Status filter')}
      style={isMobile
        ? { width: '100%', fontSize: '0.75rem', background: 'rgba(10, 22, 18, 0.6)', borderColor: 'rgba(255,255,255,0.06)' }
        : { width: '120px', fontSize: '0.7rem', height: '24px', padding: '0 4px', background: 'rgba(10, 22, 18, 0.6)', borderColor: 'rgba(255,255,255,0.06)' }}
    >
      <option value="all">{t('All Targets')}</option>
      <option value="investigated">{t('Investigated')}</option>
      <option value="pending">{t('Pending')}</option>
    </select>
  );

  const exportCsvButton = (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => setReportDialog('field')}
      disabled={!isOnline}
      title={isOnline ? t('Export CSV') : t('Network Connection: Offline')}
      style={{ marginTop: isMobile ? '2px' : '8px', padding: '7px', fontSize: '0.72rem', justifyContent: 'center', gap: '6px', width: '100%' }}
    >
      <Table2 size={13} />
      {t('Export CSV')}
    </button>
  );

  return (
    <div className="app-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', backgroundColor: '#090d16' }}>
      
      {/* 1. Sentry-Inspired Landing Page View */}
      {!isLoggedIn ? (
        <div className="landing-root" style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          width: '100vw',
          backgroundColor: '#090d16',
          backgroundImage: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(245, 130, 32, 0.15), rgba(9, 13, 22, 1)), radial-gradient(circle at 80% 60%, rgba(56, 189, 248, 0.08), transparent 50%)',
          color: '#ffffff',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          overflowX: 'hidden'
        }}>
          
          {/* Top Header Navigation Bar */}
          <header className={mobileNavOpen ? 'landing-header is-nav-open' : 'landing-header'} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 48px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            backgroundColor: 'rgba(9, 13, 22, 0.75)',
            backdropFilter: 'blur(16px)',
            position: 'sticky',
            top: 0,
            zIndex: 100
          }}>
            {/* Brand Logo & Wordmark — the top-most element, so it outweighs the nav */}
            <div className="brand-mark">
              <img src="/logo.png" alt="Nolte Logo" style={{ height: '40px', width: 'auto', objectFit: 'contain' }} />
              <span className="brand-name">Nolte Geoservices GmbH</span>
            </div>

            {/* Hamburger — hidden above 768px, so it costs the desktop header nothing */}
            <button
              type="button"
              className="landing-burger"
              aria-label={lang === 'EN' ? 'Menu' : 'Menü'}
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(open => !open)}
            >
              {mobileNavOpen ? <X size={22} /> : <Menu size={22} />}
            </button>

            {/* Middle Nav Links: ONLY Platform (with dropdown) and Company */}
            <nav className="landing-nav" style={{ display: 'flex', alignItems: 'center', gap: '36px', position: 'relative' }}>
              
              {/* Platform Tab with Dropdown */}
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setShowPlatformDropdown(true)}
                onMouseLeave={() => setShowPlatformDropdown(false)}
              >
                <button
                  type="button"
                  className={showPlatformDropdown ? 'nav-tab is-open' : 'nav-tab'}
                  onClick={() => setShowPlatformDropdown(open => !open)}
                >
                  {lang === 'EN' ? 'Platform' : 'Plattform'}
                  <span className="nav-caret">▼</span>
                </button>

                {/* Dropdown Menu on Hover — labels only, no icons or descriptions */}
                {showPlatformDropdown && (
                  <div className="landing-nav-pop" style={{
                    position: 'absolute',
                    top: '100%',
                    left: '-14px',
                    paddingTop: '14px',
                    zIndex: 1000
                  }}>
                    <div className="nav-menu">
                      <button type="button" className="nav-menu-item" onClick={openPlatform}>
                        {lang === 'EN' ? 'Dashboard' : 'Dashboard'}
                      </button>
                      <button type="button" className="nav-menu-item" onClick={openPlatform}>
                        {lang === 'EN' ? 'Field App' : 'Feld-App'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Company Tab -> Links to Nolte Services GmbH */}
              <a
                className="nav-tab"
                href="https://www.nolteservices.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                {lang === 'EN' ? 'Company' : 'Unternehmen'}
              </a>

            </nav>

            {/* Right Controls: Translator & Auth Buttons */}
            <div className="landing-actions" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>

              {/* Language Switcher (English <-> Deutsch) */}
              <LangSwitch lang={lang} onChange={setLang} />

              <button
                onClick={() => {
                  setShowAuthModal(true);
                  setAuthView('login');
                }}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  borderRadius: '6px',
                  padding: '8px 18px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.12)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.06)')}
              >
                {lang === 'EN' ? 'Sign in' : 'Anmelden'}
              </button>

              <button
                onClick={() => {
                  setShowAuthModal(true);
                  setAuthView('signup');
                }}
                style={{
                  backgroundColor: '#f58220',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 20px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 14px rgba(245, 130, 32, 0.35)',
                  transition: 'all 0.15s'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#ea6a00')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#f58220')}
              >
                {lang === 'EN' ? 'Get Access' : 'Zugang anfordern'}
              </button>
            </div>
          </header>

          {/* Hero Section Container */}
          <main className="landing-main" style={{
            display: 'flex',
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '50px 48px',
            maxWidth: '1380px',
            margin: '0 auto',
            width: '100%',
            gap: '40px'
          }}>

            {/* Left Hero Text Content */}
            <div className="landing-copy" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', maxWidth: '580px', zIndex: 2 }}>

              {/* Hero Main Headline */}
              <h1 className="landing-title" style={{
                fontSize: '3.5rem',
                fontWeight: 800,
                color: '#ffffff',
                lineHeight: 1.08,
                letterSpacing: '-0.03em',
                margin: '0 0 20px 0'
              }}>
                {lang === 'EN' ? 'Investigated before' : 'Untersucht, bevor es'}<br />
                <span style={{
                  background: 'linear-gradient(135deg, #ffffff 0%, #f58220 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent'
                }}>
                  {lang === 'EN' ? "it's a problem" : 'zum Problem wird'}
                </span>
              </h1>

              {/* Sub-headline Description */}
              <p className="landing-sub" style={{
                fontSize: '1.15rem',
                color: '#94a3b8',
                lineHeight: 1.6,
                margin: '0 0 36px 0',
                fontWeight: 400
              }}>
                {lang === 'EN' 
                  ? 'Navigate every anomaly and UXO inspection with real-time, actionable target detection, automated GPR logging, and instant field-to-office sync.'
                  : 'Führen Sie jede Anomalie- und Kampfmittelinspektion mit Echtzeit-Zieldetektion, automatisierter Radarderfassung und sofortiger Feld-Büro-Synchronisierung durch.'}
              </p>

              {/* Hero CTA Action Buttons */}
              <div className="landing-cta" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button
                  onClick={() => {
                    setShowAuthModal(true);
                    setAuthView('signup');
                  }}
                  style={{
                    backgroundColor: '#f58220',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '14px 32px',
                    fontSize: '1rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    boxShadow: '0 8px 24px rgba(245, 130, 32, 0.4)',
                    transition: 'all 0.15s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#ea6a00';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#f58220';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  {lang === 'EN' ? 'Get Early Access' : 'Jetzt Zugang anfordern'} <ArrowRight size={18} />
                </button>

                <button
                  onClick={() => {
                    setShowAuthModal(true);
                    setAuthView('login');
                  }}
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '8px',
                    padding: '14px 28px',
                    fontSize: '1rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)')}
                >
                  {lang === 'EN' ? 'Sign In' : 'Anmelden'}
                </button>
              </div>
            </div>

            {/* Right Side Visual Showcase: Field Operations Carousel */}
            <div className="landing-showcase" style={{
              flexShrink: 0,
              width: '580px',
              height: '420px',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center'
            }}>

              {/*
                No border and no solid backdrop: the photo is feathered by a mask
                and sits inside the drifting spectrum bloom, so it reads as part of
                the page rather than something trapped in a rectangle.
              */}
              <div className="hero-stage">
                <div className="hero-frame">
                  {/* key forces a remount per slide so the reveal replays top -> bottom */}
                  <img
                    key={activeFieldImg}
                    className="hero-photo"
                    src={fieldSurveys[activeFieldImg].img}
                    alt={fieldSurveys[activeFieldImg].title}
                  />

                  {/* Continuous black-to-white ramp laid over the photo */}
                  <div className="hero-veil"></div>

                  {/* Light bar travelling top -> bottom, keeps the frame alive between slides */}
                  <div className="hero-scan"></div>

                  {/* Legibility wash for the caption */}
                  <div className="hero-wash"></div>
                </div>

                {/* Caption sits outside the masked frame so its text stays crisp */}
                <div className="hero-caption" key={`cap-${activeFieldImg}`}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#f58220', flexShrink: 0 }}></span>
                      <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#ffffff' }}>
                        {fieldSurveys[activeFieldImg].title}
                      </span>
                    </div>
                    <span style={{ fontSize: '0.78rem', color: '#cbd5e1' }}>
                      {fieldSurveys[activeFieldImg].desc}
                    </span>
                  </div>

                  <span style={{
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    color: '#c3cddd',
                    backgroundColor: 'rgba(148, 173, 214, 0.16)',
                    padding: '4px 10px',
                    borderRadius: '5px',
                    fontWeight: 700,
                    flexShrink: 0
                  }}>
                    0{activeFieldImg + 1} / 0{fieldSurveys.length}
                  </span>
                </div>
              </div>

              {/* Carousel Navigation Indicators */}
              <div className="landing-dots" style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginTop: '26px'
              }}>
                {fieldSurveys.map((_, idx) => (
                  <button
                    key={idx}
                    className={activeFieldImg === idx ? 'hero-dot is-active' : 'hero-dot'}
                    onClick={() => setActiveFieldImg(idx)}
                    style={{ width: activeFieldImg === idx ? '34px' : '8px' }}
                    title={`View screenshot ${idx + 1}`}
                  />
                ))}
              </div>

            </div>
          </main>

          {/* Footer: company mark, then the same two platform entry points as the header */}
          <footer className="site-footer">
            <div className="footer-inner">
              <div className="brand-mark brand-mark--sm">
                <img src="/logo.png" alt="Nolte Logo" style={{ height: '18px', width: 'auto', objectFit: 'contain' }} />
                <span className="brand-name">Nolte Geoservices GmbH</span>
              </div>

              <div className="footer-links">
                <button type="button" className="footer-link" onClick={openPlatform}>
                  {lang === 'EN' ? 'Field App' : 'Feld-App'}
                </button>
                <span className="footer-sep"></span>
                <button type="button" className="footer-link" onClick={openPlatform}>
                  {lang === 'EN' ? 'Dashboard' : 'Dashboard'}
                </button>
              </div>
            </div>
          </footer>

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
                backgroundColor: '#0f172a',
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

        </div>
      ) : (
        
        // 2. Logged In Screens Layout
        <>
        <div className="app-container">
          {/* Vertical left sidebar navigation */}
          <aside className={`app-sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`} style={{ transition: 'width 0.2s, padding 0.2s, border-right 0.2s, opacity 0.2s' }}>
            <div className="sidebar-top" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', opacity: isSidebarCollapsed ? 0 : 1, transition: 'opacity 0.15s' }}>
              
              {/* Top Sidebar: Original Nolte Logo Image */}
              <div className="sidebar-logo" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 0' }}>
                <img 
                  src="/logo.png" 
                  alt="Nolte Logo" 
                  style={{ height: '36px', width: 'auto', objectFit: 'contain' }} 
                />
              </div>

              {/* Navigation Menu */}
              <nav className="sidebar-menu">
                <button 
                  className={`sidebar-item ${userRole === 'collector' && activeTab === 'map' ? 'active' : ''} ${access.can_field ? '' : 'locked'}`}
                  onClick={() => openSurface('field')}
                  title={access.can_field ? t('Field App') : t('Field App - permission required')}
                >
                  <Compass size={20} />
                  <span className="sidebar-item-label">{t('Field App')}</span>
                  {!access.can_field && <Lock size={12} className="sidebar-item-lock" />}
                </button>

                <button
                  className={`sidebar-item ${userRole === 'dashboard' ? 'active' : ''} ${access.can_dashboard ? '' : 'locked'}`}
                  onClick={() => openSurface('dashboard')}
                  title={access.can_dashboard ? t('Dashboard') : t('Dashboard - permission required')}
                >
                  {/* Bar chart icon */}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" x2="18" y1="20" y2="10" />
                    <line x1="12" x2="12" y1="20" y2="4" />
                    <line x1="6" x2="6" y1="20" y2="14" />
                  </svg>
                  <span className="sidebar-item-label">{t('Dashboard')}</span>
                  {!access.can_dashboard && <Lock size={12} className="sidebar-item-lock" />}
                </button>

                {access.is_admin && (
                  <button
                    className="sidebar-item"
                    onClick={() => setShowAdminPanel(true)}
                    title={t('Permission requests')}
                  >
                    <ShieldCheck size={20} />
                    <span className="sidebar-item-label">{t('Permissions')}</span>
                    {pendingRequests.length > 0 && (
                      <span className="sidebar-item-badge">{pendingRequests.length}</span>
                    )}
                  </button>
                )}

                {access.is_admin && (
                  <button
                    className="sidebar-item"
                    onClick={() => setShowUsersPanel(true)}
                    title={t('Users')}
                  >
                    <Users size={20} />
                    <span className="sidebar-item-label">{t('Users')}</span>
                  </button>
                )}

                <button 
                  className="sidebar-item"
                  onClick={() => handleSync()}
                  disabled={syncing}
                  title={t('Sync Data')}
                >
                  <RefreshCw size={20} className={syncing ? 'animate-spin' : ''} />
                  <span className="sidebar-item-label">{t('Sync')}</span>
                  {pendingSyncCount > 0 && (
                    <span className="sidebar-item-badge">{pendingSyncCount}</span>
                  )}
                </button>

                <div 
                  className="sidebar-item"
                  style={{ cursor: 'default' }}
                  title={isOnline ? t('Network Connection: Online') : t('Network Connection: Offline')}
                >
                  {isOnline ? (
                    <Wifi size={20} style={{ color: '#10b981' }} />
                  ) : (
                    <WifiOff size={20} style={{ color: '#ef4444' }} />
                  )}
                  <span className="sidebar-item-label" style={{ color: isOnline ? '#10b981' : '#ef4444' }}>
                    {isOnline ? t('Online') : t('Offline')}
                  </span>
                </div>
              </nav>
            </div>

            {/* Bottom Controls */}
            <div className="sidebar-bottom" style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', width: '100%' }}>
              
              {/* User Profile Button & Pop-up Modal */}
              <div style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
                <div 
                  className="sidebar-avatar"
                  style={{ cursor: 'pointer' }}
                  title={`${t('User')}: ${currentUserFullName || currentUser}`}
                  onClick={() => setShowUserModal(!showUserModal)}
                >
                  <div style={{
                    width: '100%', 
                    height: '100%', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    fontWeight: 'bold', 
                    color: '#f58220', 
                    fontSize: '0.85rem',
                    fontFamily: 'var(--font-heading)'
                  }}>
                    {(currentUserFullName || currentUser || 'US').substring(0, 2).toUpperCase()}
                  </div>
                </div>

                {/* Desktop keeps the anchored pop-up next to the avatar. On mobile the
                    sidebar is a fixed bottom bar, so an absolutely-positioned 240px panel
                    anchored inside it lands off the right edge and over the content - the
                    mobile version renders as a bottom sheet outside this subtree instead. */}
                {showUserModal && !isMobile && (
                  <div style={{
                    position: 'absolute',
                    bottom: '50px',
                    left: '60px',
                    backgroundColor: '#0f172a',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '12px',
                    padding: '16px',
                    width: '240px',
                    boxShadow: '0 20px 40px rgba(0, 0, 0, 0.8)',
                    zIndex: 10010,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    color: '#ffffff',
                    backdropFilter: 'blur(12px)',
                    animation: 'fade-in-up 0.2s ease-out'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(245, 130, 32, 0.15)',
                        border: '1px solid rgba(245, 130, 32, 0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#f58220',
                        fontWeight: 'bold',
                        fontSize: '0.95rem'
                      }}>
                        {(currentUserFullName || currentUser || 'US').substring(0, 2).toUpperCase()}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                          {currentUserFullName || 'Eric Musonera'}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                          @{currentUser || 'user'} · <span style={{ color: '#f58220', textTransform: 'capitalize' }}>{userRole}</span>
                        </span>
                      </div>
                    </div>

                    <div style={{ height: '1px', backgroundColor: 'rgba(255, 255, 255, 0.08)', margin: '2px 0' }}></div>

                    <button
                      onClick={() => {
                        setShowUserModal(false);
                        handleSignOut();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        width: '100%',
                        backgroundColor: 'rgba(239, 68, 68, 0.15)',
                        color: '#f87171',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.3)')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.15)')}
                    >
                      <LogOut size={15} /> {lang === 'EN' ? 'Sign Out' : 'Abmelden'}
                    </button>
                  </div>
                )}
              </div>

              {/* Language and theme sit in the bar on desktop. On mobile they move into
                  the profile sheet behind the avatar: four nav items plus the avatar plus
                  these two overflow a 380px bar, which is what was clipping the right
                  edge. The avatar becomes the single entry point instead. */}
              {!isMobile && (
                <>
                  {/* Language Switcher (available in both Field App and Dashboard) */}
                  <LangSwitch lang={lang} onChange={setLang} compact />

                  {/* Theme Toggle Button placed where Logout button was */}
                  <button
                    className="sidebar-logout"
                    onClick={() => {
                      const newTheme = theme === 'dark' ? 'light' : 'dark';
                      setTheme(newTheme);
                      localStorage.setItem('theme', newTheme);
                    }}
                    title={theme === 'dark' ? t('Switch to Light mode') : t('Switch to Dark mode')}
                  >
                    {theme === 'dark' ? <Sun size={18} color="#f58220" /> : <Moon size={18} color="#0f172a" />}
                  </button>
                </>
              )}

            </div>
          </aside>



          {/* Collapsible Sidebar Toggle Handle (Dockable) */}
          <button
            className="sidebar-toggle-handle"
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            style={{
              position: 'absolute',
              left: isSidebarCollapsed ? '0px' : '80px',
              top: '24px',
              zIndex: 10005,
              backgroundColor: theme === 'light' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(10, 22, 18, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderLeft: 'none',
              borderRadius: '0 8px 8px 0',
              width: '20px',
              height: '42px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fa5f1c',
              cursor: 'pointer',
              boxShadow: '4px 0 10px rgba(0,0,0,0.3)',
              transition: 'left 0.2s, background-color 0.2s',
              pointerEvents: 'auto'
            }}
            title={isSidebarCollapsed ? t('Expand Sidebar (Undock)') : t('Collapse Sidebar (Dock)')}
          >
            {isSidebarCollapsed ? <ChevronsRight size={12} /> : <ChevronsLeft size={12} />}
          </button>

          {/* Main Interface Router */}
          {userRole === 'collector' ? (
            
            // ROLE A: FIELD DATA COLLECTOR VIEW (FIELD APP)
            <main className="collector-main" style={{ display: 'flex', flexGrow: 1, padding: '16px', gap: '16px', height: '100vh', overflow: 'hidden' }}>
              
              {/* Left sidebar collector control panel */}
              <section className="glass-panel collector-sidebar" style={{ width: '380px', display: 'flex', flexDirection: 'column', flexShrink: 0, padding: '16px', overflow: 'hidden', border: 'none', background: 'rgba(15, 34, 28, 0.4)' }}>
                
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
                  <div className="collector-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', overflow: 'hidden' }}>

                    {/* Survey Details Header (Screenshot Match). On mobile the project
                        picker and the CSV export move into the folded filter bar below -
                        they are not what the crew reaches for first in the field. */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '0.65rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                        {t('Active Survey Area')}
                      </span>
                      <h2 style={{ fontSize: isMobile ? '1rem' : '1.1rem', fontWeight: 800, color: '#fff', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        Wilhelmshaven Seedeich
                      </h2>
                      {!isMobile && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8c9f96', textTransform: 'uppercase' }}>{t('Project ID')}</span>
                          {projectIdSelect}
                        </div>
                      )}
                      <span style={{ fontSize: '0.68rem', color: '#8c9f96', marginTop: isMobile ? '2px' : '4px' }}>
                        {filteredPoints.length} {t('Targets Detected')}
                      </span>

                      {/* Filtered CSV export, same project + date-range filters as the dashboard report */}
                      {!isMobile && exportCsvButton}
                    </div>

                    {activeTab === 'map' ? (
                      <>
                        {/* Filters Panel */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          
                          {/* Search bar */}
                          <div className="select-with-icon" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                            <Search size={14} style={{ position: 'absolute', left: '10px', color: '#8c9f96', zIndex: 1 }} />
                            <input
                              type="text"
                              className="form-input"
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              placeholder={t('Search targets...')}
                              style={{ width: '100%', paddingLeft: '30px', fontSize: '0.8rem', backgroundColor: 'rgba(10,22,18,0.4)', borderColor: 'rgba(255,255,255,0.06)' }}
                            />
                          </div>

                          {/* Mobile folds the secondary filters (project, VM Nr., instrument,
                              status) and the CSV export behind a one-line bar; the search box
                              above stays visible because it is the primary control here.
                              Desktop keeps the original inline 2-up grid. */}
                          {isMobile ? (
                            <FilterBar label={t('Filter')} summary={fieldFilterSummary} toggleLabel={t('Show filters')}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8c9f96', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('Project ID')}</span>
                                {projectIdSelect}
                              </div>
                              {vmNrSelect}
                              {instrumentSelect}
                              {statusSelect}
                              {exportCsvButton}
                            </FilterBar>
                          ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                              {vmNrSelect}
                              {instrumentSelect}
                            </div>
                          )}
                        </div>

                        {/* List coordinates */}
                        <div className="collector-list-wrap" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, color: '#8c9f96', letterSpacing: '0.02em', textTransform: 'uppercase' }}>{t('TARGET LISTING')} ({filteredPoints.length})</span>
                            {/* On mobile the status filter lives in the folded bar with the rest. */}
                            {!isMobile && statusSelect}
                          </div>
                          <div
                            className="collector-list-scroll"
                            onScroll={handleTargetListScroll}
                            style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? '6px' : '10px', overflowY: 'auto', flexGrow: 1, paddingRight: '2px' }}
                          >
                            {visibleTargetPoints.map((point) => {
                              const isInvestigated = point.local_status === 'investigated';
                              let statusText = t('PENDING');
                              let color = '#ef4444'; // Red for pending

                              if (isInvestigated && point.feedback) {
                                const fund = point.feedback.fundstueck;
                                statusText = fund === 'Sonstige' ? (point.feedback.other || 'Sonstige') : fund;
                                if (fund === 'ohne Fund') {
                                  color = '#64748b'; // Slate for empty holes
                                } else {
                                  color = '#10b981'; // Emerald for findings
                                }
                              }

                              return (
                                <div
                                  key={point.id}
                                  className={`target-card-white ${(selectedPoint as any)?.id === point.id ? 'active' : ''}`}
                                  onClick={() => setSelectedPoint(point)}
                                >
                                  {/* Mobile tightens the rows rather than the type: the VM
                                      number stays 14px and the depth value 12px, but the
                                      badge, the gaps and the depth strip all lose height. */}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontWeight: 800, fontSize: isMobile ? '0.875rem' : '0.85rem', color: '#0f172a', ...(isMobile ? { lineHeight: 1.2 } : {}) }}>VM {point.vm_nr}</span>
                                    <span style={{
                                      fontSize: isMobile ? '0.58rem' : '0.62rem',
                                      fontWeight: 800,
                                      padding: isMobile ? '1px 6px' : '2px 8px',
                                      borderRadius: '9999px',
                                      backgroundColor: 'rgba(0,0,0,0.05)',
                                      color: color,
                                      border: `1px solid ${color}33`,
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      ...(isMobile ? { maxWidth: '55%' } : {})
                                    }} title={statusText}>
                                      {statusText.toUpperCase()}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: isMobile ? '0.64rem' : '0.7rem', color: '#475569', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...(isMobile ? { lineHeight: 1.2 } : {}) }}>
                                    {point.instrument?.toUpperCase()} • {point.layer?.replace('Stoerkoerper ', '') || t('Target Layer')}
                                  </div>

                                  <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '6px',
                                    marginTop: isMobile ? '2px' : '4px',
                                    padding: isMobile ? '1px 6px' : '4px 8px',
                                    backgroundColor: 'rgba(0, 0, 0, 0.02)',
                                    borderRadius: '6px',
                                    ...(isMobile ? { lineHeight: 1.25 } : {})
                                  }}>
                                    <span style={{ fontSize: isMobile ? '0.6rem' : '0.62rem', color: '#64748b', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('EVALUATED DEPTH')}</span>
                                    {/* Held at ~13px on mobile: the label may compact, the measured value may not. */}
                                    <span style={{ fontSize: isMobile ? '0.82rem' : '0.72rem', fontWeight: 800, color: '#0f172a', whiteSpace: 'nowrap' }}>
                                      {point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}

                            {visibleTargetPoints.length < filteredPoints.length && (
                              <button
                                type="button"
                                onClick={() => setVisibleTargetCount(c => c + TARGET_PAGE_SIZE)}
                                style={{
                                  flexShrink: 0,
                                  background: 'rgba(255,255,255,0.04)',
                                  border: '1px solid rgba(255,255,255,0.08)',
                                  borderRadius: '8px',
                                  color: '#8c9f96',
                                  fontWeight: 700,
                                  fontSize: '0.72rem',
                                  padding: '10px',
                                  cursor: 'pointer'
                                }}
                              >
                                {t('Show more')} ({filteredPoints.length - visibleTargetPoints.length})
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

              {/* Collector map widget */}
              <section className="glass-panel map-container-section" style={{ flexGrow: 1, padding: '6px', overflow: 'hidden', position: 'relative' }}>
                
                {/* Floating Quick Summary panel (Screenshot template match). On mobile it
                    drops out of the overlay and stacks above the map - at 380px a 260px
                    floating card would cover most of the map it floats over. */}
                <div className="quick-summary-panel" style={{
                  position: 'absolute',
                  top: '16px',
                  right: '16px',
                  zIndex: 1000,
                  width: '260px',
                  backgroundColor: 'rgba(255, 255, 255, 0.96)',
                  border: '1px solid #e2e8f0',
                  borderRadius: '16px',
                  padding: '16px',
                  boxShadow: '0 10px 25px -5px rgba(0,0,0,0.15)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  color: '#0f172a'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', paddingBottom: '6px' }}>
                    <span style={{ fontWeight: 800, fontSize: '0.75rem', color: '#0f172a', textTransform: 'uppercase', fontFamily: 'var(--font-heading)', letterSpacing: '0.02em' }}>{t('Quick Summary')}</span>
                  </div>

                  {/* Stat 1: Target Investigation Status */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', fontWeight: 700, color: '#64748b' }}>
                      <span>{t('INVESTIGATION PROGRESS')}</span>
                      <span>{filteredPoints.filter(p => p.local_status === 'investigated').length} / {filteredPoints.length}</span>
                    </div>
                    <div style={{ height: '6px', width: '100%', backgroundColor: '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ 
                        height: '100%', 
                        width: `${(filteredPoints.filter(p => p.local_status === 'investigated').length / Math.max(1, filteredPoints.length)) * 100}%`, 
                        backgroundColor: '#10b981',
                        borderRadius: '3px'
                      }} />
                    </div>
                  </div>

                  {/* Stat 2: Instruments Class (Magnetic Progress) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', fontWeight: 700, color: '#64748b' }}>
                      <span>{t('MAGNETIC TARGETS')}</span>
                      <span>
                        {filteredPoints.filter(p => p.instrument?.toLowerCase() === 'magnetic' && p.local_status === 'investigated').length} / {filteredPoints.filter(p => p.instrument?.toLowerCase() === 'magnetic').length}
                      </span>
                    </div>
                    <div style={{ height: '6px', width: '100%', backgroundColor: '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ 
                        height: '100%', 
                        width: `${(filteredPoints.filter(p => p.instrument?.toLowerCase() === 'magnetic' && p.local_status === 'investigated').length / Math.max(1, filteredPoints.filter(p => p.instrument?.toLowerCase() === 'magnetic').length)) * 100}%`, 
                        backgroundColor: '#fa5f1c',
                        borderRadius: '3px'
                      }} />
                    </div>
                  </div>

                  {/* Stat 3: Georadar Targets Progress */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', fontWeight: 700, color: '#64748b' }}>
                      <span>{t('GEORADAR TARGETS')}</span>
                      <span>
                        {filteredPoints.filter(p => p.instrument?.toLowerCase() === 'georadar' && p.local_status === 'investigated').length} / {filteredPoints.filter(p => p.instrument?.toLowerCase() === 'georadar').length}
                      </span>
                    </div>
                    <div style={{ height: '6px', width: '100%', backgroundColor: '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ 
                        height: '100%', 
                        width: `${(filteredPoints.filter(p => p.instrument?.toLowerCase() === 'georadar' && p.local_status === 'investigated').length / Math.max(1, filteredPoints.filter(p => p.instrument?.toLowerCase() === 'georadar').length)) * 100}%`, 
                        backgroundColor: '#38bdf8',
                        borderRadius: '3px'
                      }} />
                    </div>
                  </div>
                </div>

                <div className="collector-map-wrap" style={{ height: '100%', width: '100%' }}>
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
          ) : (
            
            // ROLE B: END USER / DASHBOARD VIEW (DASHBOARD)
            <main className={`dashboard-main${isMobile ? ' dashboard-main--mobile' : ''}`} style={isMobile
              ? { display: 'block', flexGrow: 1, minWidth: 0, position: 'relative' }
              : { display: 'flex', flexGrow: 1, height: '100vh', overflow: 'hidden', position: 'relative' }}>

              {/* On desktop the map is a full-bleed background the panels float over. On
                  mobile there is nothing to float over - the map becomes one block in the
                  reading order, handed to Dashboard as a slot. */}
              {!isMobile && (
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}>
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

              {/* Floating translucent overlay panels */}
              <div style={isMobile ? undefined : {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 10,
                pointerEvents: 'none',
                display: 'flex',
                padding: '8px',
                gap: '8px',
                boxSizing: 'border-box',
                width: '100%',
                height: '100%'
              }}>
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

          )}

        </div>
        </>
      )}

      {/* Mobile profile sheet. Rendered here, outside .app-sidebar, on purpose: the
          sidebar sets backdrop-filter, which makes it a containing block for fixed
          descendants, so a sheet nested inside it could not anchor to the viewport.
          Holds everything the desktop sidebar shows around the avatar - profile,
          language, theme, sign out - so none of it is lost on a phone. */}
      {isLoggedIn && isMobile && showUserModal && (
        <>
          <div
            className="profile-sheet-backdrop"
            onClick={() => setShowUserModal(false)}
            aria-hidden="true"
          />
          <div className="profile-sheet" role="dialog" aria-label={t('Profile and settings')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                width: '42px',
                height: '42px',
                borderRadius: '50%',
                backgroundColor: 'rgba(245, 130, 32, 0.15)',
                border: '1px solid rgba(245, 130, 32, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#f58220',
                fontWeight: 'bold',
                fontSize: '0.95rem',
                flexShrink: 0
              }}>
                {(currentUserFullName || currentUser || 'US').substring(0, 2).toUpperCase()}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {currentUserFullName || currentUser}
                </span>
                <span style={{ fontSize: '0.72rem', color: '#94a3b8', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  @{currentUser || 'user'} · <span style={{ color: '#f58220', textTransform: 'capitalize' }}>{userRole}</span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowUserModal(false)}
                aria-label={t('Close')}
                style={{
                  marginLeft: 'auto', background: 'none', border: 'none', color: '#94a3b8',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: '44px', minHeight: '44px', padding: '0', flexShrink: 0
                }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ height: '1px', backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8' }}>{t('Language')}</span>
              <LangSwitch lang={lang} onChange={setLang} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8' }}>{t('Theme')}</span>
              <button
                type="button"
                onClick={() => {
                  const newTheme = theme === 'dark' ? 'light' : 'dark';
                  setTheme(newTheme);
                  localStorage.setItem('theme', newTheme);
                }}
                title={theme === 'dark' ? t('Switch to Light mode') : t('Switch to Dark mode')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  minHeight: '44px', padding: '0 14px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: '#f1f5f9', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer'
                }}
              >
                {theme === 'dark'
                  ? <><Sun size={16} color="#f58220" /> {t('Light')}</>
                  : <><Moon size={16} color="#f58220" /> {t('Dark')}</>}
              </button>
            </div>

            <button
              onClick={() => {
                setShowUserModal(false);
                handleSignOut();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                width: '100%',
                minHeight: '44px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '10px',
                padding: '8px 12px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <LogOut size={15} /> {lang === 'EN' ? 'Sign Out' : 'Abmelden'}
            </button>
          </div>
        </>
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

      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 18px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: toast.type === 'success' ? '#10b981' : toast.type === 'error' ? '#ef4444' : '#1e293b',
          color: '#fff',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          fontSize: '0.8rem',
          fontWeight: 600,
          animation: 'slide-up-toast 0.2s ease'
        }}>
          {toast.type === 'success' && <CheckCircle2 size={14} />}
          {toast.type === 'error' && <AlertTriangle size={14} />}
          {toast.type === 'info' && <RefreshCw size={14} className="animate-spin" />}
          <span>{toast.message}</span>
        </div>
      )}

      <style>{`
        @keyframes slide-up-toast {
          from { transform: translate(-50%, 20px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
        .animate-spin {
          animation: spin-anim 1.5s linear infinite;
        }
        @keyframes spin-anim {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes slide-in-drawer {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>

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
