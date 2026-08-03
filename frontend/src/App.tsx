import { useState, useEffect, useMemo, useRef } from 'react';
import { db, type LocalPoint, type PendingFeedback, type TeamsTools } from './db/indexedDb';
import { FieldMap } from './components/FieldMap';
import { Dashboard, matchesDepthBucket } from './components/Dashboard';
import { FeedbackForm } from './components/FeedbackForm';
import { ImportExport } from './components/ImportExport';
import { ReportDialog, type ProjectOption } from './components/ReportDialog';
import { makeT, type AppLang } from './i18n';
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
  ListChecks
} from 'lucide-react';

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
  
  // Theme States
  const [theme, setTheme] = useState<'dark' | 'light'>((localStorage.getItem('theme') as any) || 'dark');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

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
      setIsLoggedIn(true);
    }
  }, []);

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
    fetch(`${API_BASE}/api/projects`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setServerProjects)
      .catch(() => setServerProjects([]));
  }, [isOnline]);

  const fetchFromServer = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/points`);
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

      const res = await fetch(`${API_BASE}/api/sync`, {
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
        const res = await fetch(`${API_BASE}/api/points/import`, {
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
    const res = await fetch(`${API_BASE}/api/seed`, { method: 'POST' });
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
        
        localStorage.setItem('nolte_user', data.username);
        localStorage.setItem('nolte_role', role);
        localStorage.setItem('nolte_user_fullname', fullname);
        
        setCurrentUser(data.username);
        setCurrentUserFullName(fullname);
        setUserRole(role);
        setIsLoggedIn(true);
        showToast('success', `Welcome back, ${fullname}!`);
        return;
      }
    } catch (err) {
      console.warn('Backend login unreachable, using local fallback', err);
    }

    // Local fallback for offline/demo
    let role: AppRole = 'collector';
    let fullname = 'Eric Musonera';
    if (usernameClean.toLowerCase() === 'dashboard' || usernameClean.toLowerCase() === 'admin') {
      role = 'dashboard';
      fullname = 'Operations Analyst';
    }
    localStorage.setItem('nolte_user', usernameClean);
    localStorage.setItem('nolte_role', role);
    localStorage.setItem('nolte_user_fullname', fullname);
    
    setCurrentUser(usernameClean);
    setCurrentUserFullName(fullname);
    setUserRole(role);
    setIsLoggedIn(true);
    showToast('success', `Welcome back, ${fullname}!`);
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
        
        localStorage.setItem('nolte_user', data.username);
        localStorage.setItem('nolte_role', role);
        localStorage.setItem('nolte_user_fullname', data.full_name);
        
        setCurrentUser(data.username);
        setCurrentUserFullName(data.full_name);
        setUserRole(role);
        setIsLoggedIn(true);
        setShowAuthModal(false);
        showToast('success', `Account created successfully! Welcome, ${data.full_name}.`);
        return;
      }
    } catch (err) {
      console.warn('Backend register unreachable, using local session fallback', err);
    }

    const role: AppRole = 'collector';
    localStorage.setItem('nolte_user', usernameClean);
    localStorage.setItem('nolte_role', role);
    localStorage.setItem('nolte_user_fullname', fullNameClean);
    
    setCurrentUser(usernameClean);
    setCurrentUserFullName(fullNameClean);
    setUserRole(role);
    setIsLoggedIn(true);
    setShowAuthModal(false);
    showToast('success', `Account created successfully! Welcome, ${fullNameClean}.`);
  };


  const handleForgot = (e: React.FormEvent) => {
    e.preventDefault();
    alert("Password reset instructions sent to your email.");
    setAuthView('login');
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

  // Filters logic
  const filteredPoints = points.filter(p => {
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
  });

  // The depth bucket is a dashboard control, so it narrows the dashboard's log list and
  // map markers only - the field app keeps rendering from the unnarrowed filteredPoints.
  // Status is already applied above; depth composes on top of it (AND).
  const dashboardFilteredPoints = filteredPoints.filter(p =>
    matchesDepthBucket(p, filterDepth, filterStatus)
  );

  const allVmNumbers = points.map(p => p.vm_nr).sort((a,b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const uniqueProjectIds = Array.from(new Set(points.map(p => p.project_id || '11-24-2736'))).sort();

  // Report/export filter options: server names when reachable, otherwise the ids
  // already mirrored locally so the field app can still export offline.
  const projectOptions: ProjectOption[] = serverProjects.length
    ? serverProjects
    : uniqueProjectIds.map(id => ({ project_id: id, project_name: '' }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', backgroundColor: '#090d16' }}>
      
      {/* 1. Sentry-Inspired Landing Page View */}
      {!isLoggedIn ? (
        <div style={{
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
          <header style={{
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

            {/* Middle Nav Links: ONLY Platform (with dropdown) and Company */}
            <nav style={{ display: 'flex', alignItems: 'center', gap: '36px', position: 'relative' }}>
              
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
                  <div style={{
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              
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
          <main style={{
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
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', maxWidth: '580px', zIndex: 2 }}>
              
              {/* Hero Main Headline */}
              <h1 style={{
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
              <p style={{
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
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
            <div style={{
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
              <div style={{
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
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', opacity: isSidebarCollapsed ? 0 : 1, transition: 'opacity 0.15s' }}>
              
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
                  className={`sidebar-item ${userRole === 'collector' && activeTab === 'map' ? 'active' : ''}`}
                  onClick={() => {
                    setUserRole('collector');
                    setActiveTab('map');
                  }}
                  title={t('Field App')}
                >
                  <Compass size={20} />
                  <span className="sidebar-item-label">{t('Field App')}</span>
                </button>

                <button 
                  className={`sidebar-item ${userRole === 'dashboard' ? 'active' : ''}`}
                  onClick={() => {
                    setUserRole('dashboard');
                  }}
                  title={t('Dashboard')}
                >
                  {/* Bar chart icon */}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" x2="18" y1="20" y2="10" />
                    <line x1="12" x2="12" y1="20" y2="4" />
                    <line x1="6" x2="6" y1="20" y2="14" />
                  </svg>
                  <span className="sidebar-item-label">{t('Dashboard')}</span>
                </button>

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

                {/* Pop-up Modal on User Button Click */}
                {showUserModal && (
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

            </div>
          </aside>



          {/* Collapsible Sidebar Toggle Handle (Dockable) */}
          <button
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', overflow: 'hidden' }}>
                    
                    {/* Survey Details Header (Screenshot Match) */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '0.65rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                        {t('Active Survey Area')}
                      </span>
                      <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        Wilhelmshaven Seedeich
                      </h2>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
                        <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8c9f96', textTransform: 'uppercase' }}>{t('Project ID')}</span>
                        <select
                          className="form-input"
                          value={filterProjectId}
                          onChange={(e) => setFilterProjectId(e.target.value)}
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
                      </div>
                      <span style={{ fontSize: '0.68rem', color: '#8c9f96', marginTop: '4px' }}>
                        {filteredPoints.length} {t('Targets Detected')}
                      </span>

                      {/* Filtered CSV export, same project + date-range filters as the dashboard report */}
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setReportDialog('field')}
                        disabled={!isOnline}
                        title={isOnline ? t('Export CSV') : t('Network Connection: Offline')}
                        style={{ marginTop: '8px', padding: '7px', fontSize: '0.72rem', justifyContent: 'center', gap: '6px', width: '100%' }}
                      >
                        <Table2 size={13} />
                        {t('Export CSV')}
                      </button>
                    </div>

                    {activeTab === 'map' ? (
                      <>
                        {/* Filters Panel */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          
                          {/* Search bar */}
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                            <Search size={14} style={{ position: 'absolute', left: '10px', color: '#8c9f96' }} />
                            <input
                              type="text"
                              className="form-input"
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              placeholder={t('Search targets...')}
                              style={{ width: '100%', paddingLeft: '30px', fontSize: '0.8rem', backgroundColor: 'rgba(10,22,18,0.4)', borderColor: 'rgba(255,255,255,0.06)' }}
                            />
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            
                            {/* VM Nr. Filter Select */}
                            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                              <Shield size={12} style={{ position: 'absolute', left: '8px', color: '#8c9f96' }} />
                              <select
                                className="form-input"
                                value={filterVmNr}
                                onChange={(e) => setFilterVmNr(e.target.value)}
                                style={{ width: '100%', paddingLeft: '26px', fontSize: '0.75rem', appearance: 'none', backgroundColor: 'rgba(10,22,18,0.4)', borderColor: 'rgba(255,255,255,0.06)' }}
                              >
                                <option value="all">{t('All VM Nr.')}</option>
                                {allVmNumbers.map(vm => (
                                  <option key={vm} value={vm.toString()}>VM {vm}</option>
                                ))}
                              </select>
                            </div>

                            {/* Instrument Filter Select */}
                            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                              <Layers size={12} style={{ position: 'absolute', left: '8px', color: '#8c9f96' }} />
                              <select
                                className="form-input"
                                value={filterInstrument}
                                onChange={(e) => setFilterInstrument(e.target.value)}
                                style={{ width: '100%', paddingLeft: '26px', fontSize: '0.75rem', appearance: 'none', backgroundColor: 'rgba(10,22,18,0.4)', borderColor: 'rgba(255,255,255,0.06)' }}
                              >
                                <option value="all">{t('All Instruments')}</option>
                                <option value="georadar">{t('Georadar')}</option>
                                <option value="magnetic">{t('Magnetic')}</option>
                              </select>
                            </div>

                          </div>
                        </div>

                        {/* List coordinates */}
                        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, color: '#8c9f96', letterSpacing: '0.02em', textTransform: 'uppercase' }}>{t('TARGET LISTING')} ({filteredPoints.length})</span>
                            <select
                              className="form-input"
                              value={filterStatus}
                              onChange={(e) => setFilterStatus(e.target.value)}
                              style={{ width: '120px', fontSize: '0.7rem', height: '24px', padding: '0 4px', background: 'rgba(10, 22, 18, 0.6)', borderColor: 'rgba(255,255,255,0.06)' }}
                            >
                              <option value="all">{t('All Targets')}</option>
                              <option value="investigated">{t('Investigated')}</option>
                              <option value="pending">{t('Pending')}</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', flexGrow: 1, paddingRight: '2px' }}>
                            {filteredPoints.map((point) => {
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
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontWeight: 800, fontSize: '0.85rem', color: '#0f172a' }}>VM {point.vm_nr}</span>
                                    <span style={{ 
                                      fontSize: '0.62rem', 
                                      fontWeight: 800,
                                      padding: '2px 8px', 
                                      borderRadius: '9999px',
                                      backgroundColor: 'rgba(0,0,0,0.05)',
                                      color: color,
                                      border: `1px solid ${color}33`
                                    }}>
                                      {statusText.toUpperCase()}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: '0.7rem', color: '#475569', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {point.instrument?.toUpperCase()} • {point.layer?.replace('Stoerkoerper ', '') || t('Target Layer')}
                                  </div>
                                  
                                  <div style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    justifyContent: 'space-between',
                                    marginTop: '4px',
                                    padding: '4px 8px',
                                    backgroundColor: 'rgba(0, 0, 0, 0.02)',
                                    borderRadius: '6px'
                                  }}>
                                    <span style={{ fontSize: '0.62rem', color: '#64748b', fontWeight: 700 }}>{t('EVALUATED DEPTH')}</span>
                                    <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#0f172a' }}>
                                      {point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
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
                
                {/* Floating Quick Summary panel (Screenshot template match) */}
                <div style={{
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

                <FieldMap
                  lang={lang}
                  points={filteredPoints}
                  selectedPoint={selectedPoint}
                  onSelectPoint={(point) => setSelectedPoint(point)}
                  viewMode="collector"
                  isEditLocationMode={isEditLocationMode}
                  onPointPositionChange={handlePointPositionChange}
                />
              </section>

            </main>
          ) : (
            
            // ROLE B: END USER / DASHBOARD VIEW (DASHBOARD)
            <main className="dashboard-main" style={{ display: 'flex', flexGrow: 1, height: '100vh', overflow: 'hidden', position: 'relative' }}>
              
              {/* Map background for high-tech transparent look (Screenshot 2 Match) */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}>
                <FieldMap
                  lang={lang}
                  points={dashboardFilteredPoints}
                  selectedPoint={selectedPoint}
                  onSelectPoint={(point) => setSelectedPoint(point)}
                  viewMode="dashboard"
                  isEditLocationMode={false}
                />
              </div>

              {/* Floating translucent overlay panels */}
              <div style={{
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
                  onSelectPoint={(point) => setSelectedPoint(point)}
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
                  onGenerateReport={() => setReportDialog('dashboard')}
                />
              </div>

            </main>

          )}

        </div>
        </>
      )}

      {/* Floating Action Notifications */}
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
