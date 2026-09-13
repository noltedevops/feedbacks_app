import React, { useState, useEffect } from 'react';
import { type LocalPoint, type TeamsTools } from '../db/indexedDb';
import { Camera, Upload, Send, X, Move, Users } from 'lucide-react';
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
  // Most recent teams & tools recorded for this project, used to auto-populate
  // the section when the crew answers "No" to Need update?
  lastTeamsTools: TeamsTools | null;
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
    teams_tools: TeamsTools;
  }) => void;
  onCancel: () => void;
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({
  lang,
  point,
  currentUser,
  currentUserUsername,
  lastTeamsTools,
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

  // Teams & Tools states. Truppführer always mirrors the logged-in user.
  const [needUpdate, setNeedUpdate] = useState<boolean>(true);
  const [maschinenfuehrer, setMaschinenfuehrer] = useState<string>('');
  const [bezSuchfeld, setBezSuchfeld] = useState<string>('');
  const [messgeraet, setMessgeraet] = useState<string>('');
  const [sondierer, setSondierer] = useState<string>('');

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

    // Prefer what this target already recorded, else carry over the last crew/kit
    // used on the project. Only ask the crew to type it in when neither exists.
    const source = point.feedback?.teams_tools || lastTeamsTools;
    setNeedUpdate(!source);
    setMaschinenfuehrer(source?.maschinenfuehrer || '');
    setBezSuchfeld(source?.bez_suchfeld || '');
    setMessgeraet(source?.messgeraet || '');
    setSondierer(source?.sondierer || '');
  }, [point, lastTeamsTools]);

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
      m_cube: mCube,
      teams_tools: {
        need_update: needUpdate,
        truppfuehrer: currentUser || null,
        maschinenfuehrer: maschinenfuehrer.trim() || null,
        bez_suchfeld: bezSuchfeld.trim() || null,
        messgeraet: messgeraet.trim() || null,
        sondierer: sondierer.trim() || null
      }
    });
  };

  // Helper values for volume calculation
  const lVal = parseFloat(laenge) || 0;
  const bVal = parseFloat(breite) || 0;
  const tVal = parseFloat(tiefe) || 0;
  const computedVolume = (lVal * bVal * tVal).toFixed(3);

  return (
    <div className="feedback-form-root ff" data-tour="field.form">

      <div className="ff-head">
        <h2 className="ff-title">{t('Field Application Form')}</h2>
        <button type="button" className="ff-close" onClick={onCancel} aria-label={t('Cancel')} title={t('Cancel')}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Edit Location Info Banner */}
      {isEditLocationMode && (
        <div className="ff-banner" role="status">
          <Move size={16} aria-hidden="true" />
          <div>
            <strong>{t('Location Edit Mode Active:')}</strong> {t('Drag the target marker on the map to its exact location. Coordinates will update in real-time. Click "Submit" to save.')}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="ff-form">

        {/* Section 1: the survey's assessment of this target. Read-only - these are the
            facts the crew digs against, so they sit in a well rather than in inputs. */}
        <section className="ff-section">
          <h3 className="ff-section-title">Bewertungsergebnis</h3>
          <dl className="ff-facts">
            <div>
              <dt>{t('Project ID')}</dt>
              <dd className="num">{point.project_id || '11-24-2736'}</dd>
            </div>
            <div>
              <dt>{t('Instrument')}</dt>
              <dd className="ff-upper">{point.instrument || 'georadar'}</dd>
            </div>
            <div className="ff-facts-wide">
              <dt>{t('Bewertete Tiefe (m)')}</dt>
              <dd className="num">{point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')}</dd>
            </div>
            <div className="ff-facts-wide">
              <dt>{t('Coordinate (X; Y)')}</dt>
              <dd className="num">X: {easting.toFixed(3)} | Y: {northing.toFixed(3)}</dd>
            </div>
          </dl>
        </section>

        {/* Section 1b: Teams and Tools */}
        <section className="ff-section">
          <h3 className="ff-section-title">
            <Users size={14} aria-hidden="true" />
            {t('Teams and Tools')}
          </h3>

          {/* Need update? - when No, the fields below stay as last recorded for this project */}
          <fieldset className="form-group ff-fieldset">
            <legend className="form-label">{t('Need update?')} *</legend>
            <div className="ff-choices">
              <label className={`ff-choice${needUpdate ? ' is-checked' : ''}`}>
                <input
                  type="radio"
                  name="teams_need_update"
                  checked={needUpdate}
                  onChange={() => setNeedUpdate(true)}
                />
                {t('Yes')}
              </label>
              <label className={`ff-choice${!needUpdate ? ' is-checked' : ''}`}>
                <input
                  type="radio"
                  name="teams_need_update"
                  checked={!needUpdate}
                  onChange={() => {
                    setNeedUpdate(false);
                    const source = point.feedback?.teams_tools || lastTeamsTools;
                    setMaschinenfuehrer(source?.maschinenfuehrer || '');
                    setBezSuchfeld(source?.bez_suchfeld || '');
                    setMessgeraet(source?.messgeraet || '');
                    setSondierer(source?.sondierer || '');
                  }}
                  disabled={!point.feedback?.teams_tools && !lastTeamsTools}
                />
                {t('No')}
              </label>
            </div>
            {!point.feedback?.teams_tools && !lastTeamsTools && (
              <span className="ff-hint">
                {t('No previous entry for this project yet - please fill the fields below.')}
              </span>
            )}
          </fieldset>

          {/* Truppführer - always mirrors the signed-in user */}
          <div className="form-group">
            <label className="form-label" htmlFor="ff-truppfuehrer">Truppführer</label>
            <input id="ff-truppfuehrer" type="text" className="form-input" value={currentUser} disabled />
          </div>

          <div className="form-grid-2">
            {([
              ['Maschinenführer', maschinenfuehrer, setMaschinenfuehrer],
              ['Bez.Suchfeld', bezSuchfeld, setBezSuchfeld],
              ['Messgerät', messgeraet, setMessgeraet],
              ['Sondierer', sondierer, setSondierer]
            ] as const).map(([label, value, setter]) => (
              <label className="form-group" key={label}>
                <span className="form-label">{label} *</span>
                <input
                  type="text"
                  className="form-input"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  disabled={!needUpdate}
                  required
                />
              </label>
            ))}
          </div>
        </section>

        {/* Section 2: Eröffnungsmaßnahmen - the excavation itself */}
        <section className="ff-section">
          <h3 className="ff-section-title">Eröffnungsmaßnahmen</h3>

          <div className="form-group">
            <label className="form-label" htmlFor="ff-investigator">{t('Investigator')}</label>
            <input id="ff-investigator" type="text" className="form-input" value={currentUser} disabled />
          </div>

          {/* Öffnungsmessungen */}
          <div className="ff-group">
            <span className="ff-subtitle">Öffnungsmessungen</span>
            <div className="form-grid-3">
              <label className="form-group">
                <span className="form-label">Länge (m)</span>
                <input
                  type="number"
                  step="0.01"
                  className="form-input num"
                  value={laenge}
                  onChange={(e) => setLaenge(e.target.value)}
                  placeholder={lang === 'DE' ? 'z. B. 1.20' : 'e.g. 1.20'}
                />
              </label>
              <label className="form-group">
                <span className="form-label">Breite (m)</span>
                <input
                  type="number"
                  step="0.01"
                  className="form-input num"
                  value={breite}
                  onChange={(e) => setBreite(e.target.value)}
                  placeholder={lang === 'DE' ? 'z. B. 1.00' : 'e.g. 1.00'}
                />
              </label>
              <label className="form-group">
                <span className="form-label">Tiefe (m)</span>
                <input
                  type="number"
                  step="0.01"
                  className="form-input num"
                  value={tiefe}
                  onChange={(e) => setTiefe(e.target.value)}
                  placeholder={lang === 'DE' ? 'z. B. 0.90' : 'e.g. 0.90'}
                />
              </label>
            </div>

            {/* Volume, computed from the three above */}
            <div className="ff-readout">
              <span>{t('Meter Cube Volume (m³)')}</span>
              <strong className="num">{computedVolume} m³</strong>
            </div>
          </div>

          {/* Fundstück */}
          <div className="form-group">
            <label className="form-label" htmlFor="ff-fundstueck">Fundstück *</label>
            <select
              id="ff-fundstueck"
              className="form-input"
              value={fundstueck}
              onChange={(e) => setFundstueck(e.target.value)}
              required
            >
              <option value="ohne Fund">ohne Fund</option>
              <option value="Eisenteil">Eisenteil</option>
              <option value="Eisenstange / Eisenstab">Eisenstange / Eisenstab</option>
              <option value="Eisendraht">Eisendraht</option>
              <option value="Eisenseil">Eisenseil</option>
              <option value="Eisennägel">Eisennägel</option>
              <option value="Steine">Steine</option>
              <option value="Sonstige">Sonstige</option>
            </select>
          </div>

          {/* Specify - only when Sonstige is chosen */}
          {fundstueck === 'Sonstige' && (
            <div className="form-group ff-reveal">
              <label className="form-label" htmlFor="ff-other">{t('Schreibe (Specify) *')}</label>
              <input
                id="ff-other"
                type="text"
                className="form-input"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder={t('Describe finding...')}
                required
              />
            </div>
          )}

          {/* Sohle status */}
          <fieldset className="form-group ff-fieldset">
            <legend className="form-label">Sohle Status *</legend>
            <div className="ff-choices">
              <label className={`ff-choice${sohleStatus === 'Frei' ? ' is-checked' : ''}`}>
                <input
                  type="radio"
                  name="sohle_status"
                  value="Frei"
                  checked={sohleStatus === 'Frei'}
                  onChange={() => setSohleStatus('Frei')}
                />
                {t('Frei (Clear)')}
              </label>
              <label className={`ff-choice${sohleStatus === 'Nicht Frei' ? ' is-checked' : ''}`}>
                <input
                  type="radio"
                  name="sohle_status"
                  value="Nicht Frei"
                  checked={sohleStatus === 'Nicht Frei'}
                  onChange={() => setSohleStatus('Nicht Frei')}
                />
                {t('Nicht Frei (Not Clear)')}
              </label>
            </div>
          </fieldset>

          {/* Bemerkung */}
          <div className="form-group">
            <label className="form-label" htmlFor="ff-notes">{t('Bemerkung (Remarks)')}</label>
            <textarea
              id="ff-notes"
              rows={3}
              className="form-input ff-textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('Write any additional remarks...')}
            />
          </div>

          {/* Attached Photos */}
          <div className="form-group">
            <div className="ff-photos-head">
              <span className="form-label">{t('Attached Photos (Multiple)')}</span>
              <span className="ff-count num">{t('Bilder Number')}: {photos.length}</span>
            </div>

            <div className="ff-group">
              <div className="form-grid-2 photo-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={startCamera}
                  disabled={compressing}
                >
                  <Camera size={16} aria-hidden="true" />
                  {compressing ? t('Saving...') : t('Take Photo')}
                </button>
                <input
                  id="hidden-camera-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoUpload}
                  hidden
                />

                <label className="btn-secondary">
                  <Upload size={16} aria-hidden="true" />
                  {compressing ? t('Saving...') : t('Upload Image')}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    hidden
                    disabled={compressing}
                  />
                </label>
              </div>

              {photos.length > 0 && (
                <div className="photo-thumb-grid">
                  {photos.map((base64Src, idx) => (
                    <div key={idx} className="ff-thumb">
                      <img src={base64Src} alt={`Attachment ${idx + 1}`} />
                      <button
                        type="button"
                        className="ff-thumb-remove"
                        onClick={() => removePhoto(idx)}
                        aria-label={`${t('Cancel')} ${idx + 1}`}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Sticky on a phone so Submit stays reachable without scrolling back down. */}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={compressing}>
            <Send size={16} aria-hidden="true" />
            {t('Submit')}
          </button>
        </div>

      </form>

      {/* Camera capture. A media viewer: dark in both themes, because it frames a
          live video, not app content. */}
      {showCameraModal && (
        <div className="ff-camera" role="dialog" aria-label={t('Camera Capture')}>
          <h3 className="ff-camera-title">{t('Camera Capture')}</h3>
          <div className="ff-camera-frame">
            <video ref={videoRef} autoPlay playsInline />
          </div>
          <div className="ff-camera-actions">
            <button type="button" className="btn-secondary" onClick={stopCamera}>
              {t('Cancel')}
            </button>
            <button type="button" className="btn-primary" onClick={capturePhoto}>
              {t('Capture')}
            </button>
          </div>
        </div>
      )}

    </div>
  );
};
