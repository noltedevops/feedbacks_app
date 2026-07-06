import { useState, useEffect } from 'react';
import { db, type LocalPoint, type PendingFeedback } from './db/indexedDb';
import { FieldMap } from './components/FieldMap';
import { Dashboard } from './components/Dashboard';
import { FeedbackForm } from './components/FeedbackForm';
import { ImportExport } from './components/ImportExport';
import { 
  Compass, 
  Upload, 
  Wifi, 
  WifiOff, 
  RefreshCw, 
  Search, 
  CheckCircle2, 
  AlertTriangle, 
  ChevronRight, 
  LogOut, 
  User, 
  Shield, 
  MapPin, 
  ArrowRight,
  X
} from 'lucide-react';

const API_BASE = 'http://localhost:8000';

type AppRole = 'collector' | 'dashboard';

export default function App() {
  // Session States
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState('');
  const [currentUserFullName, setCurrentUserFullName] = useState('');
  const [userRole, setUserRole] = useState<AppRole>('collector');
  
  // Auth Form State
  const [authView, setAuthView] = useState<'login' | 'signup' | 'forgot'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupFullName, setSignupFullName] = useState('');
  const [signupRole, setSignupRole] = useState<AppRole>('collector');
  
  // Map and Data States
  const [points, setPoints] = useState<LocalPoint[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<LocalPoint | null>(null);
  const [activeTab, setActiveTab] = useState<'map' | 'import'>('map');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [addDataOpen, setAddDataOpen] = useState(false);
  const [isEditLocationMode, setIsEditLocationMode] = useState(false);
  
  // Search and Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterVmNr, setFilterVmNr] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all'); // all, investigated, pending
  
  // Toast Notification
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Restore session
  useEffect(() => {
    const sessionUser = localStorage.getItem('nolte_user');
    const sessionRole = localStorage.getItem('nolte_role');
    const sessionFullName = localStorage.getItem('nolte_user_fullname');
    if (sessionUser && sessionRole) {
      setCurrentUser(sessionUser);
      setUserRole(sessionRole as AppRole);
      setCurrentUserFullName(sessionFullName || sessionUser);
      setIsLoggedIn(true);
    }
  }, []);

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      showToast('success', 'Connection restored. Cloud sync enabled.');
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast('info', 'Offline mode active. Logs queued in IndexedDB.');
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

  // Auto-sync when online
  useEffect(() => {
    if (isOnline && pendingSyncCount > 0 && isLoggedIn) {
      handleSync();
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

  const fetchFromServer = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/points`);
      if (!res.ok) throw new Error('API server error');
      const serverPoints = await res.json();
      
      await db.transaction('rw', db.points, async () => {
        await db.points.clear();
        for (const p of serverPoints) {
          const status = p.feedback ? p.feedback.status : 'unvisited';
          await db.points.put({
            id: p.id,
            vm_nr: p.vm_nr,
            easting: p.easting,
            northing: p.northing,
            latitude: p.latitude,
            longitude: p.longitude,
            calculated_depth: p.calculated_depth,
            opening_length: p.opening_length,
            opening_width: p.opening_width,
            opening_depth: p.opening_depth,
            opening_volume: p.opening_volume,
            find_description: p.find_description,
            image_id: p.image_id,
            remarks: p.remarks,
            created_at: p.created_at,
            local_status: status,
            feedback: p.feedback
          });
        }
      });
      await loadLocalData();
    } catch (err) {
      console.warn('Could not contact API server. Operating on cached local DB.', err);
    }
  };

  const handleSync = async () => {
    if (!isOnline) {
      showToast('error', 'Sync aborted: Network is offline.');
      return;
    }
    setSyncing(true);
    try {
      const pendingItems = await db.pendingFeedback.toArray();
      const pendingPoints = await db.pendingPointUpdates.toArray();
      
      const res = await fetch(`${API_BASE}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          feedback: pendingItems,
          point_updates: pendingPoints
        })
      });
      
      if (!res.ok) throw new Error('Sync endpoint failed');
      const syncResult = await res.json();
      
      await db.pendingFeedback.clear();
      await db.pendingPointUpdates.clear();
      
      await db.transaction('rw', db.points, async () => {
        await db.points.clear();
        for (const p of syncResult.points) {
          const status = p.feedback ? p.feedback.status : 'unvisited';
          await db.points.put({
            id: p.id,
            vm_nr: p.vm_nr,
            easting: p.easting,
            northing: p.northing,
            latitude: p.latitude,
            longitude: p.longitude,
            calculated_depth: p.calculated_depth,
            opening_length: p.opening_length,
            opening_width: p.opening_width,
            opening_depth: p.opening_depth,
            opening_volume: p.opening_volume,
            find_description: p.find_description,
            image_id: p.image_id,
            remarks: p.remarks,
            created_at: p.created_at,
            local_status: status,
            feedback: p.feedback
          });
        }
      });
      
      await loadLocalData();
      await updatePendingCount();
      showToast('success', `Data Sync Complete! Synchronized ${syncResult.synced_feedback} logs and ${syncResult.synced_points || 0} target locations.`);
    } catch (err) {
      console.error(err);
      showToast('error', 'Cloud database sync failed.');
    } finally {
      setSyncing(false);
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
  }) => {
    if (!selectedPoint) return;

    try {
      const feedbackRecord: PendingFeedback = {
        id: selectedPoint.feedback?.id || Math.random().toString(36).substring(2, 15),
        point_id: selectedPoint.id,
        visited: true,
        status: feedbackData.status,
        actual_depth: feedbackData.actual_depth,
        photos: feedbackData.photos,
        notes: feedbackData.notes,
        investigator: feedbackData.investigator,
        investigator_username: feedbackData.investigator_username,
        logged_at: new Date().toISOString()
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
        local_status: feedbackData.status,
        feedback: {
          id: feedbackRecord.id,
          visited: true,
          status: feedbackData.status,
          actual_depth: feedbackData.actual_depth,
          photos: feedbackData.photos,
          notes: feedbackData.notes,
          investigator: feedbackData.investigator,
          investigator_username: feedbackData.investigator_username,
          logged_at: feedbackRecord.logged_at
        }
      };
      
      await db.points.put(updatedPoint);
      setSelectedPoint(updatedPoint);
      await loadLocalData();
      await updatePendingCount();
      
      showToast('success', `Feedback ${coordsUpdated ? 'and updated location ' : ''}logged locally for VM ${selectedPoint.vm_nr}.`);
      if (isOnline) {
        handleSync();
      }
    } catch (err) {
      console.error(err);
      showToast('error', 'Failed to save feedback findings.');
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
            const tempId = Math.random().toString(36).substring(2, 15);
            await db.points.put({
              id: tempId,
              vm_nr: p.vm_nr,
              easting: p.easting,
              northing: p.northing,
              latitude: p.latitude,
              longitude: p.longitude,
              calculated_depth: p.calculated_depth,
              opening_length: p.opening_length,
              opening_width: p.opening_width,
              opening_depth: p.opening_depth,
              opening_volume: p.opening_volume,
              find_description: p.find_description,
              image_id: p.image_id,
              remarks: p.remarks,
              created_at: new Date().toISOString(),
              local_status: 'unvisited',
              feedback: null
            });
          }
        });
        await loadLocalData();
      }
      showToast('success', `Imported ${importedPoints.length} GPR targets.`);
    } catch (err) {
      console.error(err);
      showToast('error', 'Failed to import GPR points.');
    }
  };

  const handleSeedRequest = async () => {
    const res = await fetch(`${API_BASE}/api/seed`, { method: 'POST' });
    if (!res.ok) throw new Error('Seeding failed');
    await fetchFromServer();
  };

  // Auth Submit Handlers
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const usernameClean = usernameInput.trim().toLowerCase();
    if (!usernameClean) return;

    let role: AppRole = 'collector';
    let fullname = usernameInput.trim();

    // Default accounts full names
    if (usernameClean === 'collector') {
      role = 'collector';
      fullname = 'Field Collector';
    } else if (usernameClean === 'dashboard' || usernameClean === 'admin') {
      role = 'dashboard';
      fullname = 'Operations Analyst';
    } else {
      // Look up in profiles registry
      const profiles = JSON.parse(localStorage.getItem('nolte_users_profiles') || '{}');
      const userProfile = profiles[usernameClean];
      if (userProfile) {
        role = userProfile.role;
        fullname = userProfile.fullname;
      } else {
        // Fallback for custom logging
        if (usernameClean.includes('dashboard') || usernameClean.includes('admin')) {
          role = 'dashboard';
        }
      }
    }

    localStorage.setItem('nolte_user', usernameInput.trim());
    localStorage.setItem('nolte_role', role);
    localStorage.setItem('nolte_user_fullname', fullname);
    
    setCurrentUser(usernameInput.trim());
    setCurrentUserFullName(fullname);
    setUserRole(role);
    setIsLoggedIn(true);
    showToast('success', `Welcome back, ${fullname}!`);
  };

  const handleSignup = (e: React.FormEvent) => {
    e.preventDefault();
    const usernameClean = signupUsername.trim().toLowerCase();
    const fullNameClean = signupFullName.trim();
    if (!usernameClean || !fullNameClean) return;

    // Save to profiles registry
    const profiles = JSON.parse(localStorage.getItem('nolte_users_profiles') || '{}');
    profiles[usernameClean] = {
      fullname: fullNameClean,
      email: signupEmail.trim(),
      role: signupRole
    };
    localStorage.setItem('nolte_users_profiles', JSON.stringify(profiles));

    // Support legacy lookup
    const usersRegistry = JSON.parse(localStorage.getItem('nolte_users_registry') || '{}');
    usersRegistry[usernameClean] = signupRole;
    localStorage.setItem('nolte_users_registry', JSON.stringify(usersRegistry));

    localStorage.setItem('nolte_user', signupUsername.trim());
    localStorage.setItem('nolte_role', signupRole);
    localStorage.setItem('nolte_user_fullname', fullNameClean);
    
    setCurrentUser(signupUsername.trim());
    setCurrentUserFullName(fullNameClean);
    setUserRole(signupRole);
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
    setIsEditLocationMode(false);
    setUsernameInput('');
    setPasswordInput('');
    setCurrentUser('');
    setCurrentUserFullName('');
  };

  // Reset selectedPoint when any filter changes so map zooms to fit the new selection
  useEffect(() => {
    setSelectedPoint(null);
  }, [searchQuery, filterVmNr, filterStatus]);

  // Turn off edit location mode when selectedPoint changes
  useEffect(() => {
    setIsEditLocationMode(false);
  }, [selectedPoint]);

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
    
    return matchesSearch && matchesVmNr && matchesStatus;
  });

  const allVmNumbers = points.map(p => p.vm_nr).sort((a,b) => a - b);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', backgroundColor: '#090d16' }}>
      
      {/* 1. Landing Page View (Authentication in the style of ArcGIS Field Maps) */}
      {!isLoggedIn ? (
        <div style={{
          display: 'flex',
          flexGrow: 1,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 20px',
          background: 'radial-gradient(circle, rgba(13, 31, 62, 0.75) 0%, rgba(9, 13, 22, 0.96) 100%), url(/aerial_bg.png) no-repeat center center/cover',
          position: 'relative',
          color: '#fff',
          textAlign: 'center'
        }}>
          
          {/* Centralized Presentation Section */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px',
            maxWidth: '620px',
            marginBottom: '32px',
            animation: 'fade-in-up 0.5s ease-out'
          }}>
            {/* Logo */}
            <img 
              src="/logo.png" 
              alt="Nolte Logo" 
              style={{ 
                height: '76px', 
                width: 'auto', 
                objectFit: 'contain',
                filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))'
              }} 
            />

            {/* Titles */}
            <div style={{ marginTop: '4px' }}>
              <h1 style={{ 
                fontSize: '2.5rem', 
                fontWeight: 700, 
                color: '#ffffff', 
                letterSpacing: '-0.02em', 
                margin: 0,
                lineHeight: '1.2'
              }}>
                Nolte Geoservices GmbH
              </h1>
              <p style={{ 
                fontSize: '1.3rem', 
                color: '#94a3b8', 
                fontWeight: 300, 
                margin: '6px 0 0 0',
                letterSpacing: '0.02em'
              }}>
                Target Tracker & Data Visualization Platform
              </p>
            </div>

            {/* Divider Line */}
            <div style={{ 
              width: '50px', 
              height: '1.5px', 
              backgroundColor: 'rgba(255,255,255,0.25)', 
              margin: '8px 0' 
            }}></div>

            {/* Description Paragraph */}
            <p style={{ 
              fontSize: '0.95rem', 
              color: '#cbd5e1', 
              lineHeight: '1.6', 
              margin: '8px 0',
              fontWeight: 400
            }}>
              Welcome to Nolte Geoservices Platforms. This is a secure geophysics and field operations solution that allows you to capture GPR target feedback, perform UXO inspections, take notes, and synchronize data with the office. Use this platform to manage targets and deploy them for use in the field.
            </p>

            {/* Learn More Link */}
            <a 
              href="https://www.nolteservices.com" 
              target="_blank" 
              rel="noopener noreferrer" 
              style={{ 
                color: '#38bdf8', 
                fontSize: '0.85rem', 
                fontWeight: 500,
                textDecoration: 'none',
                marginTop: '4px'
              }}
              onMouseEnter={(e) => (e.target as any).style.color = '#7dd3fc'}
              onMouseLeave={(e) => (e.target as any).style.color = '#38bdf8'}
            >
              Learn more about Nolte Services GmbH
            </a>
          </div>

          {/* Prominent White Sign In Button */}
          {!showAuthModal && (
            <button 
              onClick={() => {
                setShowAuthModal(true);
                setAuthView('login');
              }}
              style={{
                backgroundColor: '#ffffff',
                color: '#0f172a',
                border: 'none',
                borderRadius: '6px',
                padding: '14px 48px',
                fontSize: '1rem',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                transition: 'transform 0.15s, background-color 0.15s',
                animation: 'fade-in-up 0.6s ease-out'
              }}
              onMouseEnter={(e) => {
                (e.target as any).style.backgroundColor = '#f1f5f9';
                (e.target as any).style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                (e.target as any).style.backgroundColor = '#ffffff';
                (e.target as any).style.transform = 'translateY(0)';
              }}
            >
              Sign in
            </button>
          )}

          {/* Glassmorphic Login/Signup Modal Overlay */}
          {showAuthModal && (
            <div style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              backgroundColor: 'rgba(9, 13, 22, 0.75)',
              backdropFilter: 'blur(12px)',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px'
            }}>
              
              <div className="glass-panel" style={{
                width: '100%',
                maxWidth: '420px',
                padding: '30px 24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '20px',
                boxShadow: '0 25px 50px rgba(0,0,0,0.6)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                position: 'relative',
                animation: 'modal-scale-up 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                textAlign: 'left'
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

                {/* Modal Header */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '14px' }}>
                  <img src="/logo.png" alt="Nolte Logo" style={{ height: '40px', width: 'auto' }} />
                  <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#fff', margin: 0 }}>
                    {authView === 'login' ? 'Sign In' : authView === 'signup' ? 'Create Account' : 'Reset Password'}
                  </h2>
                  <span style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 600 }}>
                    NOLTE GEOSERVICES PLATFORM
                  </span>
                </div>

                {/* Login View */}
                {authView === 'login' && (
                  <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="login-username">Username or Operator ID</label>
                      <input
                        id="login-username"
                        type="text"
                        className="form-input"
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                        placeholder="Enter collector or dashboard"
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="login-password">Security Password</label>
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
                    <div style={{ padding: '8px 10px', backgroundColor: 'rgba(249, 115, 22, 0.04)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(249,115,22,0.1)', fontSize: '0.68rem', color: '#f97316', lineHeight: '1.4' }}>
                      <b>Demo Accounts:</b><br />
                      - Field Collector: <b>collector</b> | password<br />
                      - Dashboard Viewer: <b>dashboard</b> | password
                    </div>

                    <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '4px' }}>
                      Sign In <ArrowRight size={14} />
                    </button>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', marginTop: '4px' }}>
                      <span onClick={() => setAuthView('forgot')} style={{ color: '#64748b', cursor: 'pointer' }}>Forgot Password?</span>
                      <span onClick={() => setAuthView('signup')} style={{ color: 'hsl(var(--primary))', cursor: 'pointer', fontWeight: 600 }}>Create Account</span>
                    </div>
                  </form>
                )}

                {authView === 'signup' && (
                  <form onSubmit={handleSignup} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="signup-fullname">Full Name</label>
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
                      <label className="form-label" htmlFor="signup-username">Username / Operator ID</label>
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
                      <label className="form-label" htmlFor="signup-email">Corporate Email</label>
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
                      <label className="form-label" htmlFor="signup-role">Target Role</label>
                      <select 
                        id="signup-role"
                        className="form-input" 
                        value={signupRole}
                        onChange={(e) => setSignupRole(e.target.value as AppRole)}
                        required 
                      >
                        <option value="collector">Field Data Collector</option>
                        <option value="dashboard">Operations Analyst / Dashboard</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="signup-password">Create Password</label>
                      <input 
                        id="signup-password"
                        type="password" 
                        className="form-input" 
                        placeholder="••••••••" 
                        required 
                      />
                    </div>
                    
                    <div style={{ padding: '6px 8px', backgroundColor: 'rgba(16, 185, 129, 0.04)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(16,185,129,0.1)', fontSize: '0.65rem', color: '#10b981', lineHeight: '1.3' }}>
                      <b>Development Mode:</b> Account will be registered and logged in instantly.
                    </div>

                    <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '4px' }}>
                      Create & Sign In
                    </button>
                    <div style={{ textAlign: 'center', fontSize: '0.72rem', marginTop: '4px' }}>
                      <span onClick={() => setAuthView('login')} style={{ color: '#64748b', cursor: 'pointer' }}>Back to Sign In</span>
                    </div>
                  </form>
                )}

                {authView === 'forgot' && (
                  <form onSubmit={handleForgot} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="forgot-email">Username or Email</label>
                      <input 
                        id="forgot-email"
                        type="text" 
                        className="form-input" 
                        placeholder="Enter your email" 
                        required 
                      />
                    </div>
                    <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '4px' }}>
                      Send Recovery Email
                    </button>
                    <div style={{ textAlign: 'center', fontSize: '0.72rem', marginTop: '4px' }}>
                      <span onClick={() => setAuthView('login')} style={{ color: '#64748b', cursor: 'pointer' }}>Back to Sign In</span>
                    </div>
                  </form>
                )}

              </div>
            </div>
          )}

          {/* Landing Animations Styles */}
          <style>{`
            @keyframes fade-in-up {
              from { opacity: 0; transform: translateY(12px); }
              to { opacity: 1; transform: translateY(0); }
            }
            @keyframes modal-scale-up {
              from { opacity: 0; transform: scale(0.96); }
              to { opacity: 1; transform: scale(1); }
            }
          `}</style>

        </div>
      ) : (
        
        // 2. Logged In Screens Layout
        <>
          {/* Universal Header (Screenshot Match) */}
          <header style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            padding: '12px 24px', 
            margin: '10px 10px 0 10px', 
            borderRadius: '10px',
            backgroundColor: '#070a13',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
          }}>
            
            {/* Left Corporate Logo Branding (Screenshot Match) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <img 
                src="/logo.png" 
                alt="Nolte Logo" 
                style={{ 
                  height: '42px', 
                  width: 'auto', 
                  objectFit: 'contain'
                }} 
                onError={(e) => { (e.target as any).style.display = 'none'; }} 
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <h1 style={{ 
                  fontSize: '1.2rem', 
                  fontWeight: 800, 
                  color: '#ffffff', 
                  margin: 0, 
                  textTransform: 'uppercase',
                  letterSpacing: '0.02em',
                  lineHeight: '1.1',
                  fontFamily: "var(--font-heading)"
                }}>
                  Nolte Geoservices
                </h1>
                <span style={{ 
                  fontSize: '0.75rem', 
                  color: '#f97316', 
                  fontWeight: 700, 
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  lineHeight: '1.1',
                  fontFamily: "var(--font-heading)"
                }}>
                  {userRole === 'collector' ? 'TARGET TRACKER FIELD APP' : 'DATA SYNC DASHBOARD'}
                </span>
              </div>
            </div>

            {/* Right Status Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              
              {/* Online/Offline status */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 10px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: isOnline ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                border: `1px solid ${isOnline ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                fontSize: '0.7rem',
                fontWeight: 700,
                color: isOnline ? '#10b981' : '#ef4444'
              }}>
                {isOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
                <span>{isOnline ? 'ONLINE' : 'OFFLINE'}</span>
              </div>

              {/* Sync queue indicator */}
              <button
                onClick={handleSync}
                className="btn-secondary"
                style={{
                  padding: '5px 12px',
                  fontSize: '0.7rem',
                  gap: '4px',
                  border: pendingSyncCount > 0 ? '1px solid rgba(249, 115, 22, 0.4)' : '1px solid rgba(255,255,255,0.08)',
                  background: pendingSyncCount > 0 ? 'rgba(249, 115, 22, 0.06)' : 'rgba(255,255,255,0.03)'
                }}
                disabled={syncing}
              >
                <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                <span>Sync ({pendingSyncCount})</span>
              </button>

              {/* Active User session profile & signout */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: '#cbd5e1' }}>
                  <User size={14} color="#f97316" />
                  <span style={{ fontWeight: 600 }}>{currentUserFullName || currentUser}</span>
                  <span 
                    onClick={() => {
                      const newRole = userRole === 'collector' ? 'dashboard' : 'collector';
                      setUserRole(newRole);
                      localStorage.setItem('nolte_role', newRole);
                      showToast('info', `Switched view mode to: ${newRole}`);
                    }}
                    style={{ 
                      fontSize: '0.6rem', 
                      backgroundColor: 'rgba(249, 115, 22, 0.1)', 
                      border: '1px solid rgba(249, 115, 22, 0.2)',
                      padding: '2px 6px', 
                      borderRadius: '4px', 
                      textTransform: 'uppercase', 
                      color: '#f97316',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      userSelect: 'none'
                    }}
                    title="Click to switch between Collector and Dashboard (Dev Shortcut)"
                  >
                    {userRole} ⇄
                  </span>
                </div>
                <button
                  onClick={handleSignOut}
                  style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.2)',
                    color: '#f87171',
                    borderRadius: 'var(--radius-sm)',
                    padding: '5px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer'
                  }}
                  title="Sign Out"
                >
                  <LogOut size={12} />
                </button>
              </div>

            </div>
          </header>

          {/* Main Interface Router */}
          {userRole === 'collector' ? (
            
            // ROLE A: FIELD DATA COLLECTOR VIEW
            <main className="collector-main" style={{ display: 'flex', flexGrow: 1, padding: '10px', gap: '10px', height: 'calc(100vh - 74px)', overflow: 'hidden' }}>
              
              {/* Left sidebar collector control panel */}
              <section className="glass-panel collector-sidebar" style={{ width: '380px', display: 'flex', flexDirection: 'column', flexShrink: 0, padding: '16px', overflow: 'hidden' }}>
                
                {selectedPoint ? (
                  <FeedbackForm
                    point={selectedPoint}
                    currentUser={currentUserFullName}
                    currentUserUsername={currentUser}
                    isEditLocationMode={isEditLocationMode}
                    setIsEditLocationMode={setIsEditLocationMode}
                    onSave={handleSaveFeedback}
                    onCancel={() => setSelectedPoint(null)}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', overflow: 'hidden' }}>
                    
                    {/* Inner tab switcher (Map Listing / Importer) */}
                    <div style={{ display: 'flex', backgroundColor: 'rgba(255,255,255,0.03)', padding: '3px', borderRadius: 'var(--radius-sm)' }}>
                      <button 
                        onClick={() => setActiveTab('map')}
                        className={activeTab === 'map' ? 'btn-primary' : 'btn-secondary'}
                        style={{ flex: 1, padding: '6px', fontSize: '0.75rem', border: 'none', boxShadow: 'none' }}
                      >
                        <Compass size={12} /> Targets List
                      </button>
                      <button 
                        onClick={() => setActiveTab('import')}
                        className={activeTab === 'import' ? 'btn-primary' : 'btn-secondary'}
                        style={{ flex: 1, padding: '6px', fontSize: '0.75rem', border: 'none', boxShadow: 'none' }}
                      >
                        <Upload size={12} /> Load Points
                      </button>
                    </div>

                    {activeTab === 'map' ? (
                      <>
                        {/* Filters Panel */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          
                          {/* Search bar */}
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                            <Search size={14} style={{ position: 'absolute', left: '10px', color: '#4b5563' }} />
                            <input
                              type="text"
                              className="form-input"
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              placeholder="Search targets..."
                              style={{ width: '100%', paddingLeft: '30px', fontSize: '0.8rem' }}
                            />
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            
                            {/* VM Nr. Filter Select */}
                            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                              <Shield size={12} style={{ position: 'absolute', left: '8px', color: '#4b5563' }} />
                              <select
                                className="form-input"
                                value={filterVmNr}
                                onChange={(e) => setFilterVmNr(e.target.value)}
                                style={{ width: '100%', paddingLeft: '26px', fontSize: '0.75rem', appearance: 'none' }}
                              >
                                <option value="all">All VM Nr.</option>
                                {allVmNumbers.map(vm => (
                                  <option key={vm} value={vm.toString()}>VM {vm}</option>
                                ))}
                              </select>
                            </div>

                            {/* Investigated Area select */}
                            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                              <MapPin size={12} style={{ position: 'absolute', left: '8px', color: '#4b5563' }} />
                              <select
                                className="form-input"
                                style={{ width: '100%', paddingLeft: '26px', fontSize: '0.75rem', appearance: 'none' }}
                              >
                                <option value="wilhelmshaven">Wilhelmshaven</option>
                              </select>
                            </div>

                          </div>
                        </div>

                        {/* List coordinates */}
                        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#64748b' }}>SURVEY TARGETS ({filteredPoints.length})</span>
                            <select
                              className="form-input"
                              value={filterStatus}
                              onChange={(e) => setFilterStatus(e.target.value)}
                              style={{ width: '130px', fontSize: '0.7rem', height: '24px', padding: '0 4px', background: 'rgba(17, 24, 39, 0.4)' }}
                            >
                              <option value="all">All Targets</option>
                              <option value="investigated">Investigated</option>
                              <option value="pending">Pending</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', flexGrow: 1 }}>
                            {filteredPoints.map((point) => {
                              const status = point.local_status || 'unvisited';
                              let color = '#64748b';
                              if (status === 'clear') color = '#10b981';
                              else if (status === 'scrap') color = '#f59e0b';
                              else if (status === 'uxo') color = '#ef4444';
                              else if (status === 'false_alarm') color = '#8b5cf6';

                              return (
                                <div
                                  key={point.id}
                                  className="glass-card"
                                  onClick={() => setSelectedPoint(point)}
                                  style={{
                                    padding: '10px 12px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    borderLeft: `4px solid ${color}`
                                  }}
                                >
                                  <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <span style={{ fontWeight: 700, fontSize: '0.8rem', color: '#fff' }}>VM {point.vm_nr}</span>
                                    </div>
                                    <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '2px' }}>
                                      X: {point.easting} | Est: {point.calculated_depth}m
                                    </div>
                                  </div>
                                  <ChevronRight size={14} color="#475569" />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    ) : (
                      <ImportExport
                        onImportSuccess={handleImportPoints}
                        onSeedRequest={handleSeedRequest}
                        isOnline={isOnline}
                      />
                    )}
                  </div>
                )}
              </section>

              {/* Collector map widget */}
              <section className="glass-panel map-container-section" style={{ flexGrow: 1, padding: '6px', overflow: 'hidden' }}>
                <FieldMap
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
            
            // ROLE B: END USER / DASHBOARD VIEW
            <main className="dashboard-main" style={{ display: 'flex', flexGrow: 1, padding: '10px', gap: '10px', height: 'calc(100vh - 74px)', overflow: 'hidden' }}>
              
              {/* Left Column Dashboard Widgets & List */}
              <section className="glass-panel dashboard-sidebar" style={{ width: '440px', display: 'flex', flexDirection: 'column', flexShrink: 0, padding: '16px', overflow: 'hidden' }}>
                
                <Dashboard 
                  points={points}
                  filteredPoints={filteredPoints}
                  selectedPoint={selectedPoint}
                  onSelectPoint={(point) => setSelectedPoint(point)}
                  isOnline={isOnline}
                  onSeedRequest={handleSeedRequest}
                  addDataOpen={addDataOpen}
                  setAddDataOpen={setAddDataOpen}
                  filterStatus={filterStatus}
                  setFilterStatus={setFilterStatus}
                />
              </section>

              {/* Right Column Dashboard Map Widget */}
              <section className="glass-panel map-container-section" style={{ flexGrow: 1, padding: '6px', overflow: 'hidden' }}>
                <FieldMap
                  points={filteredPoints}
                  selectedPoint={selectedPoint}
                  onSelectPoint={(point) => setSelectedPoint(point)}
                  viewMode="dashboard"
                  onAddDataClick={() => setAddDataOpen(true)}
                  isEditLocationMode={false}
                />
              </section>

            </main>

          )}

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
      `}</style>

    </div>
  );
}
