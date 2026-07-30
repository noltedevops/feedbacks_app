import React, { useState } from 'react';
import { Upload, Database, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { makeT, type AppLang } from '../i18n';

interface ImportExportProps {
  lang: AppLang;
  onImportSuccess: (points: any[]) => void;
  onSeedRequest: () => Promise<void>;
  isOnline: boolean;
}

// Frontend UTM Zone 32N to Lat/Lng mathematical converter (allows offline parsing)
export function utm32nToLatLonJS(easting: number, northing: number): [number, number] {
  const a = 6378137.0;
  const f = 1.0 / 298.257223563;
  const b = a * (1.0 - f);
  
  const e2 = (a**2 - b**2) / a**2;
  const ep2 = (a**2 - b**2) / b**2;
  
  const k0 = 0.9996;
  const lon0 = 9.0 * Math.PI / 180.0; // Zone 32 central meridian
  
  const x = easting - 500000.0;
  const y = northing;
  
  const M = y / k0;
  const mu = M / (a * (1.0 - e2/4.0 - 3.0*Math.pow(e2, 2)/64.0 - 5.0*Math.pow(e2, 3)/256.0));
  const e1 = (1.0 - Math.sqrt(1.0 - e2)) / (1.0 + Math.sqrt(1.0 - e2));
  
  const foot_lat = (mu + (3.0*e1/2.0 - 27.0*Math.pow(e1, 3)/32.0)*Math.sin(2.0*mu)
              + (21.0*Math.pow(e1, 2)/16.0 - 55.0*Math.pow(e1, 4)/32.0)*Math.sin(4.0*mu)
              + (151.0*Math.pow(e1, 3)/96.0)*Math.sin(6.0*mu)
              + (1097.0*Math.pow(e1, 4)/512.0)*Math.sin(8.0*mu));
  
  const sin_foot = Math.sin(foot_lat);
  const cos_foot = Math.cos(foot_lat);
  const tan_foot = Math.tan(foot_lat);
  
  const N1 = a / Math.sqrt(1.0 - e2 * Math.pow(sin_foot, 2));
  const R1 = a * (1.0 - e2) / Math.pow(1.0 - e2 * Math.pow(sin_foot, 2), 1.5);
  const D_val = x / (N1 * k0);
  
  const lat = (foot_lat - (N1 * tan_foot / R1) * (Math.pow(D_val, 2)/2.0 
         - (5.0 + 3.0*Math.pow(tan_foot, 2) + 10.0*ep2*Math.pow(cos_foot, 2) - 4.0*Math.pow(ep2*Math.pow(cos_foot, 2), 2) - 9.0*ep2)*Math.pow(D_val, 4)/24.0
         + (61.0 + 90.0*Math.pow(tan_foot, 2) + 298.0*ep2*Math.pow(cos_foot, 2) + 45.0*Math.pow(tan_foot, 4) - 252.0*ep2 - 3.0*Math.pow(ep2*Math.pow(cos_foot, 2), 2))*Math.pow(D_val, 6)/720.0));
         
  const lon = (lon0 + (D_val - (1.0 + 2.0*Math.pow(tan_foot, 2) + ep2*Math.pow(cos_foot, 2))*Math.pow(D_val, 3)/6.0
         + (5.0 - 2.0*ep2*Math.pow(cos_foot, 2) + 28.0*Math.pow(tan_foot, 2) - 3.0*Math.pow(ep2*Math.pow(cos_foot, 2), 2) + 8.0*ep2 + 24.0*Math.pow(tan_foot, 4))*Math.pow(D_val, 5)/120.0) / cos_foot);
         
  return [lat * 180.0 / Math.PI, lon * 180.0 / Math.PI];
}

export const ImportExport: React.FC<ImportExportProps> = ({ lang, onImportSuccess, onSeedRequest, isOnline }) => {
  const t = makeT(lang);
  const [csvText, setCsvText] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Parse GPR CSV coordinate file
  const parseCSV = (text: string) => {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length < 2) throw new Error('CSV must contain a header row and at least one data row.');

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    
    // Find column matches for GPR columns
    const eastIdx = headers.findIndex(h => h.includes('x') || h.includes('east'));
    const northIdx = headers.findIndex(h => h.includes('y') || h.includes('north'));
    const depthIdx = headers.findIndex(h => h.includes('depth') || h.includes('tiefe'));
    const findIdx = headers.findIndex(h => h.includes('find') || h.includes('fund'));
    const remarksIdx = headers.findIndex(h => h.includes('remark') || h.includes('bemerkung'));

    if (eastIdx === -1 || northIdx === -1) {
      throw new Error('Could not find Easting(X) or Northing(Y) columns. Ensure headers contain "x" / "easting" and "y" / "northing".');
    }

    const points = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      
      let easting = parseFloat(cols[eastIdx]);
      let northing = parseFloat(cols[northIdx]);
      
      if (isNaN(easting) || isNaN(northing)) continue;

      // Correct coordinate offset for any points missing the leading 4 in Easting
      if (easting > 0 && easting < 100000) {
        easting += 397000.0;
        northing -= 21000.0;
      }

      const vm_nr_val = `2736-${i + 1}`;
      const evaluated_depth = depthIdx !== -1 && cols[depthIdx] ? parseFloat(cols[depthIdx]) : null;
      const find_description = findIdx !== -1 && cols[findIdx] ? cols[findIdx] : 'Imported Item';
      const remarks = remarksIdx !== -1 && cols[remarksIdx] ? cols[remarksIdx] : '---';

      // Convert coordinates via JS converter on-the-fly!
      const [latitude, longitude] = utm32nToLatLonJS(easting, northing);
      const target_id_val = `11-24-2736-${easting.toFixed(3)}-${northing.toFixed(3)}`;

      points.push({
        project_id: '11-24-2736',
        target_id: target_id_val,
        vm_nr: vm_nr_val,
        easting,
        northing,
        latitude,
        longitude,
        evaluated_depth: isNaN(evaluated_depth as any) ? null : evaluated_depth,
        opening_length: 1.0,  // default values
        opening_width: 1.0,
        opening_depth: 0.5,
        opening_volume: 0.5,
        find_description,
        image_id: i,
        remarks,
        grid_id: 'Wilhelmshaven Seedeich' // default investigated area
      });
    }

    return points;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsedPoints = parseCSV(text);
        onImportSuccess(parsedPoints);
        setMessage({ type: 'success', text: `Successfully parsed ${parsedPoints.length} targets! Push sync to upload to server.` });
      } catch (err: any) {
        setMessage({ type: 'error', text: err.message || 'Error parsing CSV.' });
      }
    };
    reader.readAsText(file);
  };

  const handleTextImport = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const parsedPoints = parseCSV(csvText);
      onImportSuccess(parsedPoints);
      setCsvText('');
      setMessage({ type: 'success', text: `Successfully parsed ${parsedPoints.length} targets!` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Error parsing CSV.' });
    }
  };

  const handleSeed = async () => {
    if (!isOnline) {
      alert('Must be online to connect to PostgreSQL database.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await onSeedRequest();
      setMessage({ type: 'success', text: 'Seeded Wilhelmshaven grid (29 targets) successfully!' });
    } catch (err: any) {
      setMessage({ type: 'error', text: 'Error seeding database.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      
      {/* Seeding Section */}
      <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <h3 style={{ fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database size={16} color="hsl(var(--primary))" /> {t('Seedeich Seeding (Wilhelmshaven)')}
        </h3>
        <p style={{ fontSize: '0.75rem', color: '#64748b', lineHeight: '1.4' }}>
          {t('Load the exact 29 survey target points transcribed from the Wilhelmshaven Excel table. Converts Germany UTM coordinates to coordinates mapped on the Seedeich dyke.')}
        </p>
        <button
          onClick={handleSeed}
          className="btn-primary"
          style={{ width: '100%', marginTop: '6px' }}
          disabled={loading || !isOnline}
        >
          {loading ? <RefreshCw className="animate-spin" size={16} /> : <Database size={16} />}
          {isOnline ? t('Seed Wilhelmshaven Targets') : t('Seed Targets (Requires Online)')}
        </button>
      </div>

      {/* CSV upload */}
      <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <h3 style={{ fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Upload size={16} color="hsl(var(--primary))" /> {t('Upload GPR Coordinate File')}
        </h3>
        <p style={{ fontSize: '0.75rem', color: '#64748b' }}>
          {t('Choose a CSV file with coordinate columns X and Y (Germany UTM).')}
        </p>
        <label className="btn-secondary" style={{ width: '100%', cursor: 'pointer', gap: '8px', justifyContent: 'center' }}>
          <Upload size={16} />
          {t('Choose CSV File')}
          <input
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      {/* Manual Paste */}
      <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <h3 style={{ fontSize: '0.9rem', color: '#cbd5e1', fontWeight: 600 }}>{t('Paste CSV Coordinates')}</h3>
        <form onSubmit={handleTextImport} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <textarea
            rows={4}
            className="form-input"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder="vm_nr,x,y,depth,find,remark&#10;161,442972.981,5937097.795,1.2,Eisenstange,Kunstoffleitung&#10;1518,442973.039,5937094.115,1.1,ohne Fund,Kunstoffleitung"
            style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
          />
          <button type="submit" className="btn-primary" style={{ width: '100%' }}>
            {t('Parse and Load Points')}
          </button>
        </form>
      </div>

      {/* Status Message */}
      {message && (
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          padding: '12px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: message.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          border: `1px solid ${message.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
          fontSize: '0.8rem',
          color: message.type === 'success' ? '#10b981' : '#f87171'
        }}>
          {message.type === 'success' ? <Check size={18} style={{ flexShrink: 0 }} /> : <AlertCircle size={18} style={{ flexShrink: 0 }} />}
          <div>{message.text}</div>
        </div>
      )}

    </div>
  );
};
