import React, { useState, useEffect } from 'react';
import { type LocalPoint, type TeamsTools } from '../db/indexedDb';
import { Camera, Upload, Send, X, Move, Users } from 'lucide-react';
import { Select } from './Select';

// The findings a crew can record, in the order they are offered.
const FUNDSTUECK_OPTIONS = ['ohne Fund', 'Eisenteil', 'Eisenstange / Eisenstab', 'Eisendraht', 'Eisenseil', 'Eisennägel', 'Steine', 'Sonstige'];
import { makeT, type AppLang } from '../i18n';
import { latLonToUtm32nJS } from '../utm';

const optionalNumber = (v: number | null | undefined) => (v !== null && v !== undefined ? String(v) : '');

// What the form opens with: the target's stored record, or - with none - an empty sheet
// with the calculated depth. Teams & tools: the target's own, else the last crew/kit used
// on the project; only when neither exists is the crew asked to type it in.
function initialValues(point: LocalPoint, lastTeamsTools: TeamsTools | null) {
  const fb = point.feedback;
  const source = fb?.teams_tools || lastTeamsTools;
  return {
    laenge: fb ? optionalNumber(fb.laenge) : '',
    breite: fb ? optionalNumber(fb.breite) : '',
    tiefe: fb ? optionalNumber(fb.actual_depth) : optionalNumber(point.evaluated_depth),
    fundstueck: fb?.fundstueck || 'ohne Fund',
    other: fb?.other || '',
    sohleStatus: fb?.sohle_status || 'Frei',
    notes: fb?.notes || '',
    photos: fb?.photos || [],
    needUpdate: !source,
    maschinenfuehrer: source?.maschinenfuehrer || '',
    bezSuchfeld: source?.bez_suchfeld || '',
    messgeraet: source?.messgeraet || '',
    sondierer: source?.sondierer || '',
  };
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
  onSave, 
  onCancel
}) => {
  const t = makeT(lang);

  // The form is filled once, from the target it opens on, and then belongs to the crew.
  // App remounts it (key) when a different target - or a blank sheet - is opened. It
  // used to refill from an effect on every new `point` object, and App makes one on each
  // marker drag and each sync, so a drag or a background sync wiped whatever the crew
  // had typed but not yet saved.
  const [initial] = useState(() => initialValues(point, lastTeamsTools));

  // Section 2 States
  const [laenge, setLaenge] = useState<string>(initial.laenge);
  const [breite, setBreite] = useState<string>(initial.breite);
  const [tiefe, setTiefe] = useState<string>(initial.tiefe);
  const [fundstueck, setFundstueck] = useState<string>(initial.fundstueck);
  const [other, setOther] = useState<string>(initial.other);
  const [sohleStatus, setSohleStatus] = useState<string>(initial.sohleStatus);
  const [notes, setNotes] = useState(initial.notes);
  const [photos, setPhotos] = useState<string[]>(initial.photos);
  const [compressing, setCompressing] = useState(false);

  // Teams & Tools states. Truppführer always mirrors the logged-in user.
  const [needUpdate, setNeedUpdate] = useState<boolean>(initial.needUpdate);
  const [maschinenfuehrer, setMaschinenfuehrer] = useState<string>(initial.maschinenfuehrer);
  const [bezSuchfeld, setBezSuchfeld] = useState<string>(initial.bezSuchfeld);
  const [messgeraet, setMessgeraet] = useState<string>(initial.messgeraet);
  const [sondierer, setSondierer] = useState<string>(initial.sondierer);

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

  // Coordinates follow the point. A marker drag changes only its latitude/longitude, so
  // once they differ from where the target was when the form opened, easting/northing
  // are computed from the new position; until then they are the stored values.
  const [openedAt] = useState(() => ({ latitude: point.latitude, longitude: point.longitude }));
  const { latitude, longitude } = point;
  const moved = latitude !== openedAt.latitude || longitude !== openedAt.longitude;
  const [easting, northing] = moved
    ? latLonToUtm32nJS(latitude, longitude).map((v) => Number(v.toFixed(3)))
    : [point.easting, point.northing];

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
          <h3 className="ff-section-title">{t('Survey result')}</h3>
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
              <dt>{t('Evaluated depth (m)')}</dt>
              <dd className="num">{point.evaluated_depth != null ? `${point.evaluated_depth} m` : t('N/A')}</dd>
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
          <h3 className="ff-section-title">{t('Excavation')}</h3>

          <div className="form-group">
            <label className="form-label" htmlFor="ff-investigator">{t('Investigator')}</label>
            <input id="ff-investigator" type="text" className="form-input" value={currentUser} disabled />
          </div>

          {/* Öffnungsmessungen */}
          <div className="ff-group">
            <span className="ff-subtitle">{t('Opening measurements')}</span>
            <div className="form-grid-3">
              <label className="form-group">
                <span className="form-label">{t('Length (m)')}</span>
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
                <span className="form-label">{t('Width (m)')}</span>
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
                <span className="form-label">{t('Depth (m)')}</span>
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
            <Select
              id="ff-fundstueck"
              value={fundstueck}
              onChange={setFundstueck}
              ariaLabel="Fundstück"
              options={FUNDSTUECK_OPTIONS.map(v => ({ value: v, label: v }))}
            />
          </div>

          {/* Specify - only when Sonstige is chosen */}
          {fundstueck === 'Sonstige' && (
            <div className="form-group ff-reveal">
              <label className="form-label" htmlFor="ff-other">{t('Specify *')}</label>
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
            <label className="form-label" htmlFor="ff-notes">{t('Remarks')}</label>
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
              <span className="ff-count num">{t('Photos')}: {photos.length}</span>
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
