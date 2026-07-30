import React, { useState, useEffect } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { Camera, Upload, Send, X, Move } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';

// High-precision coordinates converter from Lat/Lng to UTM Zone 32N (EPSG:32632)
export function latLonToUtm32nJS(lat: number, lon: number): [number, number] {
  const a = 6378137.0;
  const f = 1.0 / 298.257223563;
  const b = a * (1.0 - f);
  
  const e2 = (a**2 - b**2) / a**2;
  const ep2 = (a**2 - b**2) / b**2;
  
  const k0 = 0.9996;
  const lon0 = 9.0 * Math.PI / 180.0;
  
  const latRad = lat * Math.PI / 180.0;
  const lonRad = lon * Math.PI / 180.0;
  
  const N = a / Math.sqrt(1.0 - e2 * Math.pow(Math.sin(latRad), 2));
  const T = Math.pow(Math.tan(latRad), 2);
  const C = ep2 * Math.pow(Math.cos(latRad), 2);
  const A = (lonRad - lon0) * Math.cos(latRad);
  
  const M = a * (
    (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0) * latRad
    - (3.0*e2/8.0 + 3.0*e2**2/32.0 + 45.0*e2**3/1024.0) * Math.sin(2.0*latRad)
    + (15.0*e2**2/256.0 + 45.0*e2**3/1024.0) * Math.sin(4.0*latRad)
    - (35.0*e2**3/3072.0) * Math.sin(6.0*latRad)
  );
  
  const x = k0 * N * (
    A + (1.0 - T + C) * Math.pow(A, 3) / 6.0
    + (5.0 - 18.0*T + T**2 + 72.0*C - 58.0*ep2) * Math.pow(A, 5) / 120.0
  ) + 500000.0;
  
  const y = k0 * (
    M + N * Math.tan(latRad) * (
      Math.pow(A, 2) / 2.0
      + (5.0 - T + 9.0*C + 4.0*C**2) * Math.pow(A, 4) / 24.0
      + (61.0 - 58.0*T + T**2 + 600.0*C - 330.0*ep2) * Math.pow(A, 6) / 720.0
    )
  );
  
  return [x, y];
}

interface FeedbackFormProps {
  lang: AppLang;
  point: LocalPoint;
  currentUser: string; // Investigator Full Name
  currentUserUsername: string; // Investigator Username
  isEditLocationMode: boolean;
  setIsEditLocationMode: (mode: boolean) => void;
  onSave: (feedbackData: {
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
  }) => void;
  onCancel: () => void;
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({
  lang,
  point,
  currentUser, 
  currentUserUsername, 
  isEditLocationMode,
  setIsEditLocationMode: _setIsEditLocationMode,
  onSave, 
  onCancel
}) => {
  const t = makeT(lang);

  // Section 2 States
  const [laenge, setLaenge] = useState<string>('');
  const [breite, setBreite] = useState<string>('');
  const [tiefe, setTiefe] = useState<string>('');
  const [fundstueck, setFundstueck] = useState<string>('ohne Fund');
  const [other, setOther] = useState<string>('');
  const [sohleStatus, setSohleStatus] = useState<string>('Frei');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [compressing, setCompressing] = useState(false);

  // Camera Modal States
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  const startCamera = async () => {
    try {
      setShowCameraModal(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.warn("Direct camera access failed or denied. Falling back to file dialog.", err);
      setTimeout(() => {
        document.getElementById('hidden-camera-input')?.click();
      }, 100);
      setShowCameraModal(false);
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !cameraStream) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 600;
    canvas.height = video.videoHeight || 450;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL('image/jpeg', 0.6);
      setPhotos(prev => [...prev, base64]);
    }
    stopCamera();
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setShowCameraModal(false);
  };

  useEffect(() => {
    if (showCameraModal && cameraStream && videoRef.current) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [showCameraModal, cameraStream]);

  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraStream]);

  // High-precision coordinates states
  const [easting, setEasting] = useState<number>(point.easting);
  const [northing, setNorthing] = useState<number>(point.northing);
  const [latitude, setLatitude] = useState<number>(point.latitude);
  const [longitude, setLongitude] = useState<number>(point.longitude);

  // Load existing feedback if present, or clear form
  useEffect(() => {
    setEasting(point.easting);
    setNorthing(point.northing);
    setLatitude(point.latitude);
    setLongitude(point.longitude);

    if (point.feedback) {
      setLaenge(point.feedback.laenge !== null && point.feedback.laenge !== undefined ? String(point.feedback.laenge) : '');
      setBreite(point.feedback.breite !== null && point.feedback.breite !== undefined ? String(point.feedback.breite) : '');
      setTiefe(point.feedback.actual_depth !== null && point.feedback.actual_depth !== undefined ? String(point.feedback.actual_depth) : '');
      setFundstueck(point.feedback.fundstueck || 'ohne Fund');
      setOther(point.feedback.other || '');
      setSohleStatus(point.feedback.sohle_status || 'Frei');
      setNotes(point.feedback.notes || '');
      setPhotos(point.feedback.photos || []);
    } else {
      setLaenge('');
      setBreite('');
      setTiefe(point.evaluated_depth !== null && point.evaluated_depth !== undefined ? String(point.evaluated_depth) : '');
      setFundstueck('ohne Fund');
      setOther('');
      setSohleStatus('Frei');
      setNotes('');
      setPhotos([]);
    }
  }, [point]);

  // Listen for real-time marker dragging coordinates and convert them back to UTM
  useEffect(() => {
    if (point.latitude !== latitude || point.longitude !== longitude) {
      setLatitude(point.latitude);
      setLongitude(point.longitude);
      const [newEasting, newNorthing] = latLonToUtm32nJS(point.latitude, point.longitude);
      setEasting(Number(newEasting.toFixed(3)));
      setNorthing(Number(newNorthing.toFixed(3)));
    }
  }, [point.latitude, point.longitude]);

  // Compress photo and append to photo list
  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCompressing(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 600;
        const MAX_HEIGHT = 450;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const base64 = canvas.toDataURL('image/jpeg', 0.6);
          setPhotos(prev => [...prev, base64]);
        }
        setCompressing(false);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const removePhoto = (index: number) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const lVal = laenge !== '' ? parseFloat(laenge) : null;
    const bVal = breite !== '' ? parseFloat(breite) : null;
    const tVal = tiefe !== '' ? parseFloat(tiefe) : null;
    const mCube = (lVal !== null && bVal !== null && tVal !== null) ? Number((lVal * bVal * tVal).toFixed(3)) : null;

    onSave({
      status: 'investigated',
      actual_depth: tVal,
      photos,
      notes: notes.trim() || null,
      investigator: currentUser,
      investigator_username: currentUserUsername,
      easting,
      northing,
      latitude,
      longitude,
      
      // New fields
      target_id: point.target_id || `11-24-2736-${easting.toFixed(3)}-${northing.toFixed(3)}`,
      sohle_status: sohleStatus,
      bilder_n: photos.length,
      other: fundstueck === 'Sonstige' ? (other.trim() || null) : null,
      fundstueck,
      laenge: lVal,
      breite: bVal,
      m_cube: mCube
    });
  };

  // Helper values for volume calculation
  const lVal = parseFloat(laenge) || 0;
  const bVal = parseFloat(breite) || 0;
  const tVal = parseFloat(tiefe) || 0;
  const computedVolume = (lVal * bVal * tVal).toFixed(3);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflowY: 'auto', paddingRight: '4px' }}>
      
      {/* Header Title without Logo */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '10px', flexShrink: 0 }}>
        <div>
          <h2 style={{ fontSize: '1.15rem', color: '#f1f5f9', fontWeight: 700, margin: 0 }}>{t('Field Application Form')}</h2>
        </div>
        <button 
          onClick={onCancel}
          style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' }}
        >
          <X size={20} />
        </button>
      </div>

      {/* Edit Location Info Banner */}
      {isEditLocationMode && (
        <div style={{
          backgroundColor: 'rgba(249, 115, 22, 0.12)',
          border: '1px solid rgba(249, 115, 22, 0.3)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          fontSize: '0.72rem',
          color: '#f97316',
          lineHeight: '1.4',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          flexShrink: 0
        }}>
          <Move size={14} style={{ marginTop: '2px', flexShrink: 0 }} />
          <div>
            <strong>{t('Location Edit Mode Active:')}</strong> {t('Drag the target marker on the map to its exact location. Coordinates will update in real-time. Click "Submit" to save.')}
          </div>
        </div>
      )}

      {/* MAIN FORM */}
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        
        {/* Section 1: bewertungsergebnis */}
        <div className="glass-card" style={{ padding: '14px', borderLeft: '3px solid #10b981', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontWeight: 800, fontSize: '0.75rem', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            bewertungsergebnis
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.78rem' }}>
            <div>
              <span style={{ color: '#64748b', fontSize: '0.7rem', display: 'block' }}>{t('Project ID')}</span>
              <strong style={{ color: '#e2e8f0' }}>{point.project_id || '11-24-2736'}</strong>
            </div>
            <div>
              <span style={{ color: '#64748b', fontSize: '0.7rem', display: 'block' }}>{t('Instrument')}</span>
              <strong style={{ color: '#e2e8f0', textTransform: 'uppercase' }}>{point.instrument || 'georadar'}</strong>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={{ color: '#64748b', fontSize: '0.7rem', display: 'block' }}>{t('Bewertete Tiefe (m)')}</span>
              <strong style={{ color: '#e2e8f0' }}>{point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')}</strong>
            </div>
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
              <div>
                <span style={{ color: '#64748b', fontSize: '0.7rem', display: 'block' }}>{t('Coordinate (X; Y)')}</span>
                <strong style={{ color: '#e2e8f0' }}>X: {easting.toFixed(3)} | Y: {northing.toFixed(3)}</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Eroffnungsmassnahmen */}
        <div className="glass-card" style={{ padding: '14px', borderLeft: '3px solid #fa5f1c', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontWeight: 800, fontSize: '0.75rem', color: '#fa5f1c', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Eroffnungsmassnahmen
          </div>
          
          {/* Active Investigator (Read-only) */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: '0.7rem', color: '#64748b' }}>{t('Investigator')}</label>
            <input
              type="text"
              className="form-input"
              value={currentUser}
              disabled
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', color: '#94a3b8', cursor: 'not-allowed', border: '1px solid rgba(255, 255, 255, 0.05)', fontSize: '0.75rem', height: '30px' }}
            />
          </div>

          {/* Subsection 1: Öffnungsmessungen */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>Öffnungsmessungen</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <div className="form-group" style={{ margin: 0, minWidth: 0 }}>
                <label className="form-label" style={{ fontSize: '0.65rem' }}>Länge(m)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-input"
                  value={laenge}
                  onChange={(e) => setLaenge(e.target.value)}
                  placeholder={lang === 'DE' ? 'z. B. 1.20' : 'e.g. 1.20'}
                  style={{ height: '32px', fontSize: '0.75rem', width: '100%', minWidth: 0, padding: '4px 8px', boxSizing: 'border-box' }}
                />
              </div>
              <div className="form-group" style={{ margin: 0, minWidth: 0 }}>
                <label className="form-label" style={{ fontSize: '0.65rem' }}>Breite(m)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-input"
                  value={breite}
                  onChange={(e) => setBreite(e.target.value)}
                  placeholder={lang === 'DE' ? 'z. B. 1.00' : 'e.g. 1.00'}
                  style={{ height: '32px', fontSize: '0.75rem', width: '100%', minWidth: 0, padding: '4px 8px', boxSizing: 'border-box' }}
                />
              </div>
              <div className="form-group" style={{ margin: 0, minWidth: 0 }}>
                <label className="form-label" style={{ fontSize: '0.65rem' }}>Tiefe(m)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-input"
                  value={tiefe}
                  onChange={(e) => setTiefe(e.target.value)}
                  placeholder={lang === 'DE' ? 'z. B. 0.90' : 'e.g. 0.90'}
                  style={{ height: '32px', fontSize: '0.75rem', width: '100%', minWidth: 0, padding: '4px 8px', boxSizing: 'border-box' }}
                />
              </div>
            </div>
            
            {/* Meter Cube Autopopulated */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.02)', padding: '6px 10px', borderRadius: '6px', marginTop: '4px' }}>
              <span style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 600 }}>{t('Meter Cube Volume (m³)')}</span>
              <strong style={{ fontSize: '0.75rem', color: '#38bdf8' }}>{computedVolume} m³</strong>
            </div>
          </div>

          {/* Subsection 2: Fundstück */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: '0.72rem', color: '#f8fafc', fontWeight: 700 }}>Fundstück *</label>
            <select
              className="form-input"
              value={fundstueck}
              onChange={(e) => setFundstueck(e.target.value)}
              style={{
                fontSize: '0.75rem',
                height: '32px',
                padding: '0 8px',
                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                borderColor: 'rgba(255, 255, 255, 0.25)',
                color: '#ffffff',
                fontWeight: 600,
                width: '100%',
                cursor: 'pointer'
              }}
              required
            >
              <option value="ohne Fund" style={{ background: '#1e293b', color: '#fff' }}>ohne Fund</option>
              <option value="Eisenteil" style={{ background: '#1e293b', color: '#fff' }}>Eisenteil</option>
              <option value="Eisenstange / Eisenstab" style={{ background: '#1e293b', color: '#fff' }}>Eisenstange / Eisenstab</option>
              <option value="Eisendraht" style={{ background: '#1e293b', color: '#fff' }}>Eisendraht</option>
              <option value="Eisenseil" style={{ background: '#1e293b', color: '#fff' }}>Eisenseil</option>
              <option value="Eisennägel" style={{ background: '#1e293b', color: '#fff' }}>Eisennägel</option>
              <option value="Steine" style={{ background: '#1e293b', color: '#fff' }}>Steine</option>
              <option value="Sonstige" style={{ background: '#1e293b', color: '#fff' }}>Sonstige</option>
            </select>
          </div>

          {/* Conditional Field: Schreibe (open if Sonstige selected) */}
          {fundstueck === 'Sonstige' && (
            <div className="form-group" style={{ animation: 'fade-in 0.15s ease-out' }}>
              <label className="form-label" style={{ fontSize: '0.7rem' }}>{t('Schreibe (Specify) *')}</label>
              <input
                type="text"
                className="form-input"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder={t('Describe finding...')}
                style={{ fontSize: '0.75rem', height: '32px' }}
                required
              />
            </div>
          )}

          {/* Sohle status */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>Sohle Status *</label>
            <div style={{ display: 'flex', gap: '12px', marginTop: '2px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', cursor: 'pointer', color: sohleStatus === 'Frei' ? '#10b981' : '#64748b', fontWeight: 600 }}>
                <input
                  type="radio"
                  name="sohle_status"
                  value="Frei"
                  checked={sohleStatus === 'Frei'}
                  onChange={() => setSohleStatus('Frei')}
                  style={{ cursor: 'pointer' }}
                />
                {t('Frei (Clear)')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', cursor: 'pointer', color: sohleStatus === 'Nicht Frei' ? '#ef4444' : '#64748b', fontWeight: 600 }}>
                <input
                  type="radio"
                  name="sohle_status"
                  value="Nicht Frei"
                  checked={sohleStatus === 'Nicht Frei'}
                  onChange={() => setSohleStatus('Nicht Frei')}
                  style={{ cursor: 'pointer' }}
                />
                {t('Nicht Frei (Not Clear)')}
              </label>
            </div>
          </div>

          {/* Bemerkung */}
          <div className="form-group">
            <label className="form-label" style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700 }}>{t('Bemerkung (Remarks)')}</label>
            <textarea
              rows={3}
              className="form-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('Write any additional remarks...')}
              style={{ fontSize: '0.75rem', resize: 'vertical' }}
            />
          </div>

          {/* Attached Photos */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <label className="form-label" style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700, margin: 0 }}>{t('Attached Photos (Multiple)')}</label>
              <span style={{ fontSize: '0.68rem', color: '#38bdf8', fontWeight: 800 }}>{t('Bilder Number')}: {photos.length}</span>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={startCamera}
                  style={{ gap: '6px', justifyContent: 'center', padding: '8px 4px', fontSize: '0.72rem', cursor: 'pointer' }}
                  disabled={compressing}
                >
                  <Camera size={14} />
                  {compressing ? t('Saving...') : t('Take Photo')}
                </button>
                <input
                  id="hidden-camera-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoUpload}
                  style={{ display: 'none' }}
                />
                
                <label className="btn-secondary" style={{ cursor: 'pointer', gap: '6px', justifyContent: 'center', padding: '8px 4px', fontSize: '0.72rem' }}>
                  <Upload size={14} />
                  {compressing ? t('Saving...') : t('Upload Image')}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    style={{ display: 'none' }}
                    disabled={compressing}
                  />
                </label>
              </div>

              {/* Photos List Grid */}
              {photos.length > 0 && (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))',
                  gap: '8px',
                  maxHeight: '130px',
                  overflowY: 'auto',
                  padding: '6px',
                  backgroundColor: 'rgba(0,0,0,0.2)',
                  borderRadius: 'var(--radius-sm)'
                }}>
                  {photos.map((base64Src, idx) => (
                    <div key={idx} style={{ position: 'relative', width: '100%', height: '54px', borderRadius: '4px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                      <img src={base64Src} alt={`Attachment ${idx + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button
                        type="button"
                        onClick={() => removePhoto(idx)}
                        style={{
                          position: 'absolute',
                          top: '2px',
                          right: '2px',
                          backgroundColor: 'rgba(239, 68, 68, 0.95)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '50%',
                          width: '18px',
                          height: '18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer'
                        }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          <button type="button" className="btn-secondary" onClick={onCancel} style={{ flex: 1, padding: '10px', fontSize: '0.8rem' }}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn-primary" style={{ flex: 1, padding: '10px', fontSize: '0.8rem' }} disabled={compressing}>
            <Send size={14} />
            {t('Submit')}
          </button>
        </div>

      </form>

      {showCameraModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(0, 0, 0, 0.9)',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          padding: '20px',
          boxSizing: 'border-box'
        }}>
          <h3 style={{ color: '#fff', margin: 0, fontFamily: 'var(--font-heading)' }}>{t('Camera Capture')}</h3>
          <div style={{
            position: 'relative',
            width: '100%',
            maxWidth: '640px',
            borderRadius: '12px',
            overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.2)',
            backgroundColor: '#000'
          }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              style={{
                width: '100%',
                display: 'block'
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: '12px', width: '100%', maxWidth: '320px' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={stopCamera}
              style={{ flex: 1, padding: '10px', fontSize: '0.8rem', color: '#fff', borderColor: 'rgba(255,255,255,0.2)' }}
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={capturePhoto}
              style={{ flex: 1, padding: '10px', fontSize: '0.8rem' }}
            >
              {t('Capture')}
            </button>
          </div>
        </div>
      )}

    </div>
  );
};
