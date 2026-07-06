import React, { useState, useEffect } from 'react';
import { type LocalPoint } from '../db/indexedDb';
import { Camera, Upload, Send, X, Move } from 'lucide-react';

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
  }) => void;
  onCancel: () => void;
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({ 
  point, 
  currentUser, 
  currentUserUsername, 
  isEditLocationMode,
  setIsEditLocationMode,
  onSave, 
  onCancel 
}) => {
  const [status, setStatus] = useState<string>('clear');
  const [otherStatusText, setOtherStatusText] = useState<string>('');
  const [actualDepth, setActualDepth] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [compressing, setCompressing] = useState(false);

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
      const s = point.feedback.status;
      if (['clear', 'scrap', 'uxo', 'false_alarm'].includes(s)) {
        setStatus(s);
        setOtherStatusText('');
      } else if (s && s !== 'unvisited') {
        setStatus('other');
        setOtherStatusText(s);
      } else {
        setStatus('clear');
        setOtherStatusText('');
      }
      setActualDepth(point.feedback.actual_depth !== null ? String(point.feedback.actual_depth) : '');
      setNotes(point.feedback.notes || '');
      setPhotos(point.feedback.photos || []);
    } else {
      setStatus('clear');
      setOtherStatusText('');
      setActualDepth(point.calculated_depth !== null ? String(point.calculated_depth) : '');
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
          
          // Append to photos list (supports multiple uploads!)
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
    const finalStatus = status === 'other' 
      ? (otherStatusText.toLowerCase().trim() || 'other') 
      : status;

    onSave({
      status: finalStatus,
      actual_depth: actualDepth !== '' ? parseFloat(actualDepth) : null,
      photos,
      notes: notes.trim() || null,
      investigator: currentUser,
      investigator_username: currentUserUsername,
      easting,
      northing,
      latitude,
      longitude
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflowY: 'auto', paddingRight: '4px' }}>
      
      {/* Header Title without Logo */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '10px', flexShrink: 0 }}>
        <div>
          <h2 style={{ fontSize: '1.15rem', color: '#f1f5f9', fontWeight: 700, margin: 0 }}>Field Application Form</h2>
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
            <strong>Location Edit Mode Active:</strong> Drag the target marker on the map to its exact location. Coordinates will update in real-time. Click "Submit" to save.
          </div>
        </div>
      )}

      {/* Target Details Grid */}
      <div className="glass-card" style={{ padding: '12px', fontSize: '0.8rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
        <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '6px', fontWeight: 'bold', color: 'hsl(var(--primary))' }}>
          TARGET: VM Nr. {point.vm_nr}
        </div>
        <div>
          <span style={{ color: '#64748b' }}>GPR Est. Depth:</span>
          <div style={{ fontWeight: 600, color: '#e2e8f0', marginTop: '2px' }}>
            {point.calculated_depth ? `${point.calculated_depth} meters` : 'N/A'}
          </div>
        </div>
        <div>
          <span style={{ color: '#64748b' }}>Original GPR Find:</span>
          <div style={{ fontWeight: 600, color: '#e2e8f0', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={point.find_description || 'N/A'}>
            {point.find_description || 'N/A'}
          </div>
        </div>
        <div style={{ gridColumn: '1 / -1', paddingTop: '4px' }}>
          <span style={{ color: '#64748b' }}>Opening:</span>
          <div style={{ color: '#cbd5e1', marginTop: '2px' }}>
            {point.opening_length}m x {point.opening_width}m x {point.opening_depth}m (Vol: {point.opening_volume}m³)
          </div>
        </div>
        <div style={{ gridColumn: '1 / -1', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ color: '#64748b' }}>UTM Coordinates:</span>
            <div style={{ fontWeight: 600, color: '#e2e8f0', marginTop: '2px', fontSize: '0.72rem' }}>
              X: {easting.toFixed(3)} | Y: {northing.toFixed(3)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsEditLocationMode(!isEditLocationMode)}
            style={{
              backgroundColor: isEditLocationMode ? 'rgba(249, 115, 22, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${isEditLocationMode ? 'hsl(var(--primary))' : 'rgba(255, 255, 255, 0.1)'}`,
              color: isEditLocationMode ? '#f97316' : '#94a3b8',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '0.7rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              transition: 'all 0.2s',
              userSelect: 'none'
            }}
          >
            <Move size={12} />
            {isEditLocationMode ? 'Lock Loc' : 'Edit Loc'}
          </button>
        </div>
      </div>

      {/* Feedback Form Fields */}
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        
        {/* User - Auto-populated & Read-only */}
        <div className="form-group">
          <label className="form-label" htmlFor="user">Active Investigator</label>
          <input
            id="user"
            type="text"
            className="form-input"
            value={currentUser}
            disabled
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)', color: '#94a3b8', cursor: 'not-allowed', border: '1px solid rgba(255, 255, 255, 0.05)' }}
          />
        </div>

        {/* Findings Status Questionnaire */}
        <div className="form-group">
          <label className="form-label">Excavation Findings Status *</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            <div 
              style={{
                border: `1px solid ${status === 'clear' ? '#10b981' : 'rgba(255, 255, 255, 0.06)'}`,
                background: status === 'clear' ? 'rgba(16, 185, 129, 0.06)' : 'rgba(17, 24, 39, 0.2)',
                padding: '8px 4px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'center',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: status === 'clear' ? '#10b981' : '#94a3b8'
              }}
              onClick={() => setStatus('clear')}
            >
              Cleared (Empty)
            </div>
            <div 
              style={{
                border: `1px solid ${status === 'scrap' ? '#f59e0b' : 'rgba(255, 255, 255, 0.06)'}`,
                background: status === 'scrap' ? 'rgba(245, 158, 11, 0.06)' : 'rgba(17, 24, 39, 0.2)',
                padding: '8px 4px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'center',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: status === 'scrap' ? '#f59e0b' : '#94a3b8'
              }}
              onClick={() => setStatus('scrap')}
            >
              Scrap Metal
            </div>
            <div 
              style={{
                border: `1px solid ${status === 'uxo' ? '#ef4444' : 'rgba(255, 255, 255, 0.06)'}`,
                background: status === 'uxo' ? 'rgba(239, 68, 68, 0.06)' : 'rgba(17, 24, 39, 0.2)',
                padding: '8px 4px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'center',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: status === 'uxo' ? '#ef4444' : '#94a3b8'
              }}
              onClick={() => setStatus('uxo')}
            >
              UXO / Landmine
            </div>
            <div 
              style={{
                border: `1px solid ${status === 'false_alarm' ? '#8b5cf6' : 'rgba(255, 255, 255, 0.06)'}`,
                background: status === 'false_alarm' ? 'rgba(139, 92, 246, 0.06)' : 'rgba(17, 24, 39, 0.2)',
                padding: '8px 4px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'center',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: status === 'false_alarm' ? '#a78bfa' : '#94a3b8'
              }}
              onClick={() => setStatus('false_alarm')}
            >
              False Alarm
            </div>
            <div 
              style={{
                border: `1px solid ${status === 'other' ? '#3b82f6' : 'rgba(255, 255, 255, 0.06)'}`,
                background: status === 'other' ? 'rgba(59, 130, 246, 0.06)' : 'rgba(17, 24, 39, 0.2)',
                padding: '8px 4px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'center',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: status === 'other' ? '#3b82f6' : '#94a3b8',
                gridColumn: '1 / -1'
              }}
              onClick={() => setStatus('other')}
            >
              Other / Custom Finding
            </div>
          </div>

          {status === 'other' && (
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label className="form-label" htmlFor="specify-status-input" style={{ fontSize: '0.7rem' }}>Specify Status *</label>
              <input
                id="specify-status-input"
                type="text"
                className="form-input"
                style={{ fontSize: '0.8rem', padding: '6px 10px' }}
                value={otherStatusText}
                onChange={(e) => setOtherStatusText(e.target.value)}
                placeholder="e.g., Cable, Pipe, Concrete Block..."
                required
              />
            </div>
          )}
        </div>

        {/* Actual dug depth */}
        <div className="form-group">
          <label className="form-label" htmlFor="actual-depth">Actual Dug Depth (meters)</label>
          <input
            id="actual-depth"
            type="number"
            step="0.01"
            className="form-input"
            value={actualDepth}
            onChange={(e) => setActualDepth(e.target.value)}
            placeholder="e.g. 1.05"
          />
        </div>

        {/* Comments/Notes */}
        <div className="form-group">
          <label className="form-label" htmlFor="form-notes">Investigation Notes</label>
          <textarea
            id="form-notes"
            rows={3}
            className="form-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional comments regarding safety, excavation details, utility lines..."
            style={{ fontSize: '0.8rem', resize: 'vertical' }}
          />
        </div>

        {/* Multiple Photo Uploads */}
        <div className="form-group">
          <label className="form-label">Attached Photos (Multiple Allowed)</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {/* Take Photo button (Camera) */}
              <label className="btn-secondary" style={{ cursor: 'pointer', gap: '6px', justifyContent: 'center', padding: '8px 4px', fontSize: '0.75rem' }}>
                <Camera size={14} />
                {compressing ? 'Saving...' : 'Take Photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoUpload}
                  style={{ display: 'none' }}
                  disabled={compressing}
                />
              </label>

              {/* Upload Image button (Gallery) */}
              <label className="btn-secondary" style={{ cursor: 'pointer', gap: '6px', justifyContent: 'center', padding: '8px 4px', fontSize: '0.75rem' }}>
                <Upload size={14} />
                {compressing ? 'Saving...' : 'Upload Image'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoUpload}
                  style={{ display: 'none' }}
                  disabled={compressing}
                />
              </label>
            </div>

            {/* Thumbnail Listing Grid */}
            {photos.length > 0 && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))',
                gap: '8px',
                maxHeight: '160px',
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

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexShrink: 0 }}>
          <button type="button" className="btn-secondary" onClick={onCancel} style={{ flex: 1, padding: '8px', fontSize: '0.8rem' }}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" style={{ flex: 1, padding: '8px', fontSize: '0.8rem' }} disabled={compressing}>
            <Send size={14} />
            Submit
          </button>
        </div>

      </form>
    </div>
  );
};
