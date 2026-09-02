import React, { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type LocalPoint, getResolvedStatus } from '../db/indexedDb';
import { Layers, FolderPlus, Home, FileSpreadsheet, FileText } from 'lucide-react';
import { makeT, type AppLang, type Translator } from '../i18n';

interface FieldMapProps {
  lang: AppLang;
  points: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
  viewMode: 'collector' | 'dashboard';
  onAddDataClick?: () => void;
  isEditLocationMode?: boolean;
  onPointPositionChange?: (lat: number, lng: number) => void;
  // Narrow-screen layout: shrinks the floating map chrome and gates touch panning
  // behind a tap so the map does not eat the page's vertical scroll.
  isMobile?: boolean;
}

// CSV Exporter for single point report
const downloadSingleCSV = (selectedPoint: LocalPoint) => {
  const feedback = selectedPoint.feedback;
  
  const headers = [
    'Project ID', 'Target ID', 'VM Nr.', 'Easting (X)', 'Northing (Y)', 'Evaluated Depth (m)', 
    'Instrument', 'Layer', 'Sohle Status', 'Fundstück', 'Other', 'Actual Depth (m)', 
    'Investigator', 'Logged At', 'Bilder Number', 'Notes'
  ];
  
  const rows = [
    [
      selectedPoint.project_id || '11-24-2736',
      selectedPoint.target_id || '',
      selectedPoint.vm_nr,
      selectedPoint.easting,
      selectedPoint.northing,
      selectedPoint.evaluated_depth || 'N/A',
      selectedPoint.instrument || 'georadar',
      selectedPoint.layer || '',
      feedback?.sohle_status || 'N/A',
      feedback?.fundstueck || 'N/A',
      feedback?.other || '',
      feedback?.actual_depth || 'N/A',
      feedback?.investigator || 'N/A',
      feedback?.logged_at || 'N/A',
      feedback?.bilder_n || 0,
      feedback?.notes || ''
    ]
  ];
  
  const csvContent = "data:text/csv;charset=utf-8," 
    + [headers.join(','), ...rows.map(e => e.map(val => `"${val}"`).join(","))].join("\n");
    
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Target_VM_${selectedPoint.vm_nr}_Report.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// HTML Print / PDF Exporter
const downloadSinglePDF = (selectedPoint: LocalPoint) => {
  const feedback = selectedPoint.feedback;

  const printWindow = window.open('', '_blank');
  if (!printWindow) return;

  printWindow.document.write(`
    <html>
      <head>
        <title>Nolte Geoservices Platforms - Target Report VM-${selectedPoint.vm_nr}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #f97316; padding-bottom: 20px; margin-bottom: 30px; }
          .title { font-size: 24px; font-weight: bold; color: #1e293b; }
          .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; }
          .meta-item { border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; }
          .meta-label { font-size: 11px; color: #64748b; font-weight: bold; text-transform: uppercase; }
          .meta-value { font-size: 16px; margin-top: 4px; font-weight: bold; color: #0f172a; }
          .photos-section { margin-top: 30px; }
          .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
          .photo-card { border: 1px solid #e2e8f0; padding: 6px; border-radius: 6px; }
          .photo-card img { width: 100%; height: 150px; object-fit: cover; border-radius: 4px; }
          .footer { border-top: 1px solid #e2e8f0; margin-top: 50px; padding-top: 15px; font-size: 12px; color: #94a3b8; text-align: center; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="title">TARGET TRACKER FEEDBACK</div>
            <div style="font-size: 14px; color: #64748b; margin-top: 4px;">Nolte Geoservices Platforms GmbH | Field Operations</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 18px; font-weight: bold; color: #f97316;">VM Nr. ${selectedPoint.vm_nr}</div>
            <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Date Exported: ${new Date().toLocaleDateString()}</div>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-item">
            <div class="meta-label">Project ID</div>
            <div class="meta-value">${selectedPoint.project_id || '11-24-2736'}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Target ID</div>
            <div class="meta-value">${selectedPoint.target_id || ''}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">UTM Coordinates</div>
            <div class="meta-value">X: ${selectedPoint.easting} | Y: ${selectedPoint.northing}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Evaluated Depth (m)</div>
            <div class="meta-value">${selectedPoint.evaluated_depth ? `${selectedPoint.evaluated_depth} m` : 'N/A'}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Instrument / Layer</div>
            <div class="meta-value" style="font-size: 11px;">${(selectedPoint.instrument || 'georadar').toUpperCase()} / ${selectedPoint.layer || ''}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Clearance / Sohle Status</div>
            <div class="meta-value">${feedback?.sohle_status || 'N/A'}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Fundstück</div>
            <div class="meta-value">${feedback?.fundstueck || 'N/A'} ${feedback?.other ? `(${feedback.other})` : ''}</div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Investigator Name</div>
            <div class="meta-value">${feedback?.investigator || 'N/A'}</div>
          </div>
          <div class="meta-item" style="grid-column: 1 / -1; border-top: 1px dashed #e2e8f0; padding-top: 8px;">
            <div class="meta-label" style="font-weight: bold; color: #fa5f1c;">Öffnungsmessungen (Excavation Measurements)</div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 4px;">
              <div>
                <span style="font-size: 11px; color: #64748b;">Länge:</span>
                <span style="font-size: 13px; font-weight: bold;">${feedback?.laenge !== null && feedback?.laenge !== undefined ? `${feedback.laenge} m` : 'N/A'}</span>
              </div>
              <div>
                <span style="font-size: 11px; color: #64748b;">Breite:</span>
                <span style="font-size: 13px; font-weight: bold;">${feedback?.breite !== null && feedback?.breite !== undefined ? `${feedback.breite} m` : 'N/A'}</span>
              </div>
              <div>
                <span style="font-size: 11px; color: #64748b;">Tiefe:</span>
                <span style="font-size: 13px; font-weight: bold;">${feedback?.actual_depth !== null && feedback?.actual_depth !== undefined ? `${feedback.actual_depth} m` : 'N/A'}</span>
              </div>
              <div>
                <span style="font-size: 11px; color: #64748b;">Volumen:</span>
                <span style="font-size: 13px; font-weight: bold; color: #38bdf8;">${feedback?.m_cube !== null && feedback?.m_cube !== undefined ? `${feedback.m_cube} m³` : 'N/A'}</span>
              </div>
            </div>
          </div>
          <div class="meta-item" style="grid-column: 1 / -1; border-top: 1px dashed #e2e8f0; padding-top: 8px;">
            <div class="meta-label">Additional Comments / Bemerkung</div>
            <div class="meta-value" style="font-weight: normal; font-size: 13px; color: #334155;">
              ${feedback?.notes || selectedPoint.remarks || 'No notes reported.'}
            </div>
          </div>
        </div>

        ${feedback?.photos && feedback.photos.length > 0 ? `
          <div class="photos-section">
            <div class="meta-label" style="font-weight: bold; color: #38bdf8;">Submitted Pictures (Bilder Number: ${feedback.bilder_n})</div>
            <div class="photo-grid">
              ${feedback.photos.map((img: string, idx: number) => `
                <div class="photo-card">
                  <img src="${img}" alt="Attachment ${idx + 1}" style="max-height: 140px; object-fit: contain;" />
                  <div style="font-size: 11px; color: #94a3b8; text-align: center; margin-top: 4px;">Photo ${idx + 1}</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="footer">
          Confidential Geophysics Survey Document - Nolte Geoservices Platforms GmbH &copy; ${new Date().getFullYear()}
        </div>

        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
};

const MapController: React.FC<{ 
  points: LocalPoint[]; 
  selectedPoint: LocalPoint | null; 
}> = ({ points, selectedPoint }) => {
  const map = useMap();

  // Track serialized points IDs to trigger bounds fitting only when the point set changes.
  // Memoized on the array identity: with ~1500 targets this join runs on every render
  // otherwise, including renders that have nothing to do with the map.
  const pointsKey = useMemo(() => points.map(p => p.id).join(','), [points]);

  useEffect(() => {
    if (points.length > 0) {
      const bounds = L.latLngBounds(points.map(p => [p.latitude, p.longitude]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 22 });
    }
  }, [pointsKey, map]);

  useEffect(() => {
    if (selectedPoint) {
      map.setView([selectedPoint.latitude, selectedPoint.longitude], 21);
    }
  }, [selectedPoint, map]);
  
  return null;
}

// MapContainer only reads its options once, at mount, so toggling `dragging` as a prop
// would never reach Leaflet. The handlers have to be enabled imperatively.
const MapInteractivity: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const map = useMap();

  useEffect(() => {
    const handlers = [map.dragging, map.touchZoom, map.doubleClickZoom, map.scrollWheelZoom];
    handlers.forEach(h => (enabled ? h.enable() : h.disable()));
  }, [enabled, map]);

  return null;
};

// Leaflet measures its container once, when the map is created, and never notices
// it changing afterwards. Tiles for the area that was outside the old box are never
// requested, which is exactly what the grey panels are - the map is not broken, it
// simply does not know it grew. Every layout change has to say so.
//
// Leaflet's own trackResize already covers a window resize. What it cannot see is
// the container changing while the window does not: the phone reflow moving the map
// between layers, a drawer opening beside it, a panel stacking below it. A
// ResizeObserver on the container catches all of those. orientationchange is kept
// separately because on a phone it can land before the box has settled.
const MapResizeHandler: React.FC = () => {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    // Coalesce bursts into one call per frame: a rotation fires repeatedly and
    // invalidateSize forces a synchronous re-layout every time it is called.
    let frame = 0;
    const invalidate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    };

    const observer = new ResizeObserver(invalidate);
    observer.observe(container);
    window.addEventListener('orientationchange', invalidate);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('orientationchange', invalidate);
    };
  }, [map]);

  return null;
};

// Available basemaps.
//
// All three are keyless raster. CARTO began stamping an "API KEY REQUIRED" watermark
// into every dark_all tile - served as a normal HTTP 200, so nothing here errored and
// only the pixels showed it - and has said the raster service is being retired in
// favour of vector tiles, so a key would only have bought time.
//
// The replacement is Esri's Dark Gray Canvas rather than a vector basemap. Vector was
// tried first and lost: MapLibre needs a WebGL context plus a separately bundled web
// worker, and when that worker 404s the map still initialises, still paints its
// background, and renders nothing else - a black rectangle with no error thrown. On a
// field app that runs on whatever tablet a crew owns, a basemap that can fail silently
// and invisibly is worse than one that is merely coarse.
const BASEMAPS = {
  dark: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    // Esri splits the dark canvas in two: geometry in the base service above, and every
    // place and street name in this separate transparent overlay. dark_all carried its
    // labels inline, so without this second layer the map loses every name on it.
    labelsUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    // Esri labels every town it knows about, so zoomed out to a regional or country
    // view the overlay turns into a wall of place names that buries the target markers
    // underneath it - at z8 the label tile comes back larger than the basemap tile it
    // covers. Below survey-area zoom the names identify nothing the surveyor is looking
    // for, so the layer is simply not drawn there.
    labelsMinZoom: 12,
    // Held back from full strength so names read as context behind the markers rather
    // than as competition with them.
    labelsOpacity: 0.7,
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS user community',
    // Real data stops at z16 worldwide - z17 and beyond serve an identical 2.5KB blank
    // tile, checked over both the survey area and dense urban centres. Capping the
    // native zoom here makes Leaflet upscale the z16 tile instead of laying blank ones
    // over the map at exactly the zoom a surveyor works at.
    maxNativeZoom: 16,
    className: 'basemap-dark-base',
    labelsClassName: 'basemap-dark-labels'
  },
  streets: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
    maxNativeZoom: 19
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxNativeZoom: 19
  }
} as const;

type BasemapKey = keyof typeof BASEMAPS;

const BasemapLayer: React.FC<{ basemap: BasemapKey }> = ({ basemap }) => {
  const config = BASEMAPS[basemap];
  const labelsUrl = 'labelsUrl' in config ? config.labelsUrl : undefined;

  return (
    <>
      <TileLayer
        attribution={config.attribution}
        url={config.url}
        maxZoom={22}
        maxNativeZoom={config.maxNativeZoom}
        className={'className' in config ? config.className : undefined}
      />
      {labelsUrl && (
        <TileLayer
          url={labelsUrl}
          maxZoom={22}
          maxNativeZoom={config.maxNativeZoom}
          minZoom={'labelsMinZoom' in config ? config.labelsMinZoom : undefined}
          opacity={'labelsOpacity' in config ? config.labelsOpacity : 1}
          className={'labelsClassName' in config ? config.labelsClassName : undefined}
        />
      )}
    </>
  );
};

const MapToolbar: React.FC<{
  viewMode: 'collector' | 'dashboard';
  onAddDataClick?: () => void;
  activeBasemap: BasemapKey;
  setActiveBasemap: (val: BasemapKey) => void;
  basemapOpen: boolean;
  setBasemapOpen: (val: boolean) => void;
  points: LocalPoint[];
  isMobile: boolean;
  t: Translator;
}> = ({
  viewMode,
  onAddDataClick,
  activeBasemap,
  setActiveBasemap,
  basemapOpen,
  setBasemapOpen,
  points,
  isMobile,
  t
}) => {
  const map = useMap();

  const handleZoomIn = () => map.zoomIn();
  const handleZoomOut = () => map.zoomOut();
  const handleHome = () => {
    if (points.length > 0) {
      const bounds = L.latLngBounds(points.map(p => [p.latitude, p.longitude]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 22 });
    }
  };

  return (
    <div style={{
      position: 'absolute',
      bottom: isMobile ? '10px' : '16px',
      // On desktop the dashboard's 360px left column sits over the map, so the toolbar
      // clears it. On mobile the map is a block in the flow with nothing over it, and
      // that offset would push the whole stack off a 380px screen.
      left: !isMobile && viewMode === 'dashboard' ? '444px' : (isMobile ? '10px' : '16px'),
      right: isMobile ? '10px' : undefined,
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '10px',
      pointerEvents: 'auto',
      transition: 'left 0.2s ease-in-out'
    }}>
      
      {/* Basemap switcher options popout */}
      <div style={{ position: 'relative' }}>
        {basemapOpen && (
          <div style={{
            position: 'absolute',
            left: '46px',
            bottom: '0px',
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '8px',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            minWidth: '120px',
            zIndex: 1001
          }}>
            <button
              onClick={() => { setActiveBasemap('dark'); setBasemapOpen(false); }}
              style={{
                background: activeBasemap === 'dark' ? 'rgba(249, 115, 22, 0.15)' : 'none',
                border: 'none',
                color: activeBasemap === 'dark' ? '#f97316' : '#fff',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                textAlign: 'left',
                fontSize: '0.75rem',
                cursor: 'pointer',
                fontWeight: activeBasemap === 'dark' ? 'bold' : 'normal'
              }}
            >
              {t('Dark Canvas')}
            </button>
            <button
              onClick={() => { setActiveBasemap('streets'); setBasemapOpen(false); }}
              style={{
                background: activeBasemap === 'streets' ? 'rgba(249, 115, 22, 0.15)' : 'none',
                border: 'none',
                color: activeBasemap === 'streets' ? '#f97316' : '#fff',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                textAlign: 'left',
                fontSize: '0.75rem',
                cursor: 'pointer',
                fontWeight: activeBasemap === 'streets' ? 'bold' : 'normal'
              }}
            >
              {t('OSM Streets')}
            </button>
            <button
              onClick={() => { setActiveBasemap('satellite'); setBasemapOpen(false); }}
              style={{
                background: activeBasemap === 'satellite' ? 'rgba(249, 115, 22, 0.15)' : 'none',
                border: 'none',
                color: activeBasemap === 'satellite' ? '#f97316' : '#fff',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                textAlign: 'left',
                fontSize: '0.75rem',
                cursor: 'pointer',
                fontWeight: activeBasemap === 'satellite' ? 'bold' : 'normal'
              }}
            >
              {t('Satellite Map')}
            </button>
          </div>
        )}
      </div>

      {/* Vertical control widgets stack */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgba(17, 24, 39, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '10px',
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
        zIndex: 1000
      }}>
        {/* Zoom In */}
        <button
          onClick={handleZoomIn}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            color: '#fff',
            width: '36px',
            height: '36px',
            fontSize: '1.2rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.2s'
          }}
          title={t('Zoom In')}
        >
          +
        </button>
        {/* Zoom Out */}
        <button
          onClick={handleZoomOut}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            color: '#fff',
            width: '36px',
            height: '36px',
            fontSize: '1.2rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.2s'
          }}
          title={t('Zoom Out')}
        >
          &minus;
        </button>
        {/* Home */}
        <button
          onClick={handleHome}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            color: '#fff',
            width: '36px',
            height: '36px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.2s'
          }}
          title={t('Fit bounds')}
        >
          <Home size={16} />
        </button>
        {/* Basemap Switcher */}
        <button
          onClick={() => setBasemapOpen(!basemapOpen)}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: viewMode === 'dashboard' && onAddDataClick ? '1px solid rgba(255, 255, 255, 0.08)' : 'none',
            color: '#fff',
            width: '36px',
            height: '36px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.2s'
          }}
          title={t('Basemap switcher')}
        >
          <Layers size={16} />
        </button>
        {/* Add Data Button */}
        {viewMode === 'dashboard' && onAddDataClick && (
          <button
            onClick={onAddDataClick}
            style={{
              background: 'none',
              border: 'none',
              color: '#38bdf8',
              width: '36px',
              height: '36px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background-color 0.2s'
            }}
            title={t('Add Data Layer')}
          >
            <FolderPlus size={16} />
          </button>
        )}
      </div>

      {/* Horizontal Map Legend Bar (Screenshot Match) */}
      <div className="glass-panel" style={{
        display: 'flex',
        alignItems: 'center',
        gap: isMobile ? '8px' : '12px',
        padding: isMobile ? '5px 10px' : '6px 14px',
        borderRadius: '9999px',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: 'var(--shadow-lg)',
        maxWidth: '100%',
        flexWrap: 'wrap'
      }}>
        {/* The "MAP LEGEND" caption is the first thing to go on a 380px screen - the two
            colour chips next to it already say what it says. */}
        {!isMobile && (
          <span style={{ fontWeight: 800, color: '#fff', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderRight: '1px solid rgba(255,255,255,0.15)', paddingRight: '10px' }}>
            {t('Map Legend')}
          </span>
        )}
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.7rem', color: '#cbd5e1', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', border: '0.75px solid white' }}></div>
            <span>{t('Investigated')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#ef4444', border: '0.75px solid white' }}></div>
            <span>{t('Pending')}</span>
          </div>
        </div>
      </div>

    </div>
  );
};

const FieldMapImpl: React.FC<FieldMapProps> = ({
  lang,
  points,
  selectedPoint,
  onSelectPoint,
  viewMode,
  onAddDataClick,
  isEditLocationMode = false,
  onPointPositionChange,
  isMobile = false
}) => {
  const t = makeT(lang);
  const [activeBasemap, setActiveBasemap] = useState<BasemapKey>('dark');
  const [basemapOpen, setBasemapOpen] = useState(false);
  const [popupPointId, setPopupPointId] = useState<string | null>(null);

  // On mobile the map is a block inside a scrolling page, so Leaflet's touch drag
  // would swallow every vertical swipe that starts on it and trap the scroll. The
  // map stays inert until the user taps it, which is also what makes the 55vh block
  // scrollable past.
  const [touchActivated, setTouchActivated] = useState(false);
  const mapInteractive = !isMobile || touchActivated;

  // Going back to a narrow viewport re-arms the shield. Adjusted during render rather
  // than in an effect, so it costs no extra render pass.
  const [lastIsMobile, setLastIsMobile] = useState(isMobile);
  if (lastIsMobile !== isMobile) {
    setLastIsMobile(isMobile);
    if (!isMobile) setTouchActivated(false);
  }

  // One canvas renderer for the whole layer. Leaflet's default is SVG, which emits a
  // separate <path> per CircleMarker - at ~1500 targets that is 1500 DOM nodes in one
  // overlay, and the browser repaints all of them whenever the page scrolls. On canvas
  // they collapse to a single element the compositor can leave alone. This is the main
  // cause of the scroll stutter.
  const renderer = useMemo(() => L.canvas({ padding: 0.5 }), []);

  useEffect(() => {
    if (selectedPoint) {
      setPopupPointId(selectedPoint.id);
    } else {
      setPopupPointId(null);
    }
  }, [selectedPoint]);

  // Center on Wilhelmshaven coordinates. MapContainer only reads `center` on mount,
  // so this only needs to be right once - but it walks every point, and recomputing it
  // on unrelated renders is pure waste at 1500 targets.
  const center = useMemo((): [number, number] => {
    if (selectedPoint) {
      return [selectedPoint.latitude, selectedPoint.longitude];
    }
    if (points.length > 0) {
      const avgLat = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
      const avgLng = points.reduce((sum, p) => sum + p.longitude, 0) / points.length;
      return [avgLat, avgLng];
    }
    // Default Wilhelmshaven Seedeich center
    return [53.5583, 8.1391];
  }, [points, selectedPoint]);

  // Markers are rebuilt only when the filtered dataset, the selection or the drag mode
  // actually changes - not on every parent render. Without this, any unrelated state
  // update in App re-creates ~1500 elements and react-leaflet re-applies styles to
  // every one of them.
  const markers = useMemo(() => (
    points.map((point) => {
      const isSelected = selectedPoint?.id === point.id;
      const isInvestigated = point.local_status === 'investigated';
      const color = isInvestigated ? '#10b981' : '#ef4444';

      if (isSelected && isEditLocationMode) {
        // Render a draggable standard Marker for editing location
        return (
          <Marker
            key={point.id}
            position={[point.latitude, point.longitude]}
            draggable={true}
            icon={L.divIcon({
              className: 'custom-leaflet-marker',
              html: `
                <div class="map-marker-pin marker-selected"
                     style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 10px #fa5f1c;">
                  <div style="width: 4px; height: 4px; background-color: white; border-radius: 50%;"></div>
                </div>
              `,
              iconSize: [14, 14],
              iconAnchor: [7, 7]
            })}
            eventHandlers={{
              dragend: (e) => {
                const marker = e.target;
                const position = marker.getLatLng();
                if (onPointPositionChange) {
                  onPointPositionChange(position.lat, position.lng);
                }
              }
            }}
          >
            <Popup>
              <div style={{ color: '#0f172a', fontFamily: 'var(--font-body)', fontSize: '0.8rem', minWidth: '150px' }}>
                <h4 style={{ fontWeight: 700, color: '#f97316', marginBottom: '4px' }}>VM Nr. {point.vm_nr}</h4>
                <p style={{ margin: '2px 0', fontSize: '0.75rem', fontWeight: 600, color: '#64748b' }}>{t('DRAG TO RE-POSITION')}</p>
              </div>
            </Popup>
          </Marker>
        );
      }

      // Otherwise, render a high-performance CircleMarker (small point size), drawn
      // into the shared canvas renderer rather than as its own SVG path. Touch
      // targets get a bigger radius - 2.5px is unhittable with a finger.
      return (
        <CircleMarker
          key={point.id}
          center={[point.latitude, point.longitude]}
          renderer={renderer}
          radius={isSelected ? 6 : (isMobile ? 4 : 2.5)}
          fillColor={color}
          color="#ffffff"
          weight={isSelected ? 1.5 : 0.4}
          fillOpacity={0.9}
          eventHandlers={{
            click: () => onSelectPoint(point)
          }}
        />
      );
    })
  ), [points, selectedPoint, isEditLocationMode, onSelectPoint, onPointPositionChange, renderer, isMobile, t]);

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <MapContainer
        center={center}
        zoom={18}
        maxZoom={22}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        // Canvas is also the default for anything Leaflet draws internally here.
        preferCanvas={true}
        dragging={mapInteractive}
        touchZoom={mapInteractive}
        doubleClickZoom={mapInteractive}
        scrollWheelZoom={mapInteractive}
      >
        <BasemapLayer key={activeBasemap} basemap={activeBasemap} />

        {markers}

        <MapInteractivity enabled={mapInteractive} />
        <MapController points={points} selectedPoint={selectedPoint} />
        <MapResizeHandler />

        {selectedPoint && popupPointId === selectedPoint.id && (
          <Popup
            position={[selectedPoint.latitude, selectedPoint.longitude]}
            eventHandlers={{ remove: () => setPopupPointId(null) }}
            maxWidth={320}
            minWidth={285}
            autoPan={true}
          >
            <div style={{ 
              color: '#0f172a', 
              fontFamily: 'var(--font-body)', 
              fontSize: '0.78rem', 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '8px', 
              padding: '4px',
              maxWidth: '300px'
            }}>
              
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1.5px solid #fa5f1c', paddingBottom: '4px', marginBottom: '2px' }}>
                <span style={{ fontWeight: 800, color: '#fa5f1c', fontSize: '0.85rem' }}>VM Nr. {selectedPoint.vm_nr}</span>
                <span style={{
                  fontSize: '0.58rem',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: '9999px',
                  backgroundColor: 'rgba(0,0,0,0.05)',
                  color: getResolvedStatus(selectedPoint) === 'clear' ? '#10b981' : getResolvedStatus(selectedPoint) === 'uxo' ? '#ef4444' : getResolvedStatus(selectedPoint) === 'scrap' ? '#f59e0b' : getResolvedStatus(selectedPoint) === 'false_alarm' ? '#8b5cf6' : '#64748b',
                }}>
                  {t(getResolvedStatus(selectedPoint)).toUpperCase()}
                </span>
              </div>

              {/* UTM Coordinates & GPR Meta */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'rgba(0,0,0,0.02)', padding: '6px 8px', borderRadius: '8px' }}>
                <div><strong style={{ color: '#475569' }}>{t('Project ID')}:</strong> {selectedPoint.project_id || '11-24-2736'}</div>
                <div><strong style={{ color: '#475569' }}>{t('Target ID')}:</strong> {selectedPoint.target_id || t('N/A')}</div>
                <div><strong style={{ color: '#475569' }}>{t('UTM coords')}:</strong> X: {selectedPoint.easting} | Y: {selectedPoint.northing}</div>
                <div><strong style={{ color: '#475569' }}>{t('Survey Layer')}:</strong> {selectedPoint.layer || t('N/A')}</div>
                <div><strong style={{ color: '#475569' }}>{t('Evaluated Depth')}:</strong> {selectedPoint.evaluated_depth ? `${selectedPoint.evaluated_depth} m` : t('N/A')}</div>
              </div>

              {/* Feedback Log (if visited) */}
              {selectedPoint.feedback && selectedPoint.feedback.visited && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'rgba(16, 185, 129, 0.05)', borderLeft: '3.5px solid #10b981', padding: '6px 8px', borderRadius: '4px' }}>
                  <div style={{ fontWeight: 800, color: '#10b981', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '2px' }}>{t('Field Log Feedback')}</div>
                  <div><strong style={{ color: '#475569' }}>{t('Sohle Status')}:</strong> {selectedPoint.feedback?.sohle_status || t('N/A')}</div>
                  <div><strong style={{ color: '#475569' }}>Fundstück:</strong> {selectedPoint.feedback?.fundstueck || t('N/A')}</div>
                  {selectedPoint.feedback?.m_cube !== null && <div><strong style={{ color: '#475569' }}>{t('Volumen')}:</strong> {selectedPoint.feedback.m_cube} m³</div>}
                  <div><strong style={{ color: '#475569' }}>{t('Actual Depth')}:</strong> {selectedPoint.feedback?.actual_depth ? `${selectedPoint.feedback.actual_depth} m` : t('N/A')}</div>
                  <div><strong style={{ color: '#475569' }}>{t('Investigator')}:</strong> {selectedPoint.feedback?.investigator || t('N/A')}</div>
                  {selectedPoint.feedback?.notes && <div><strong style={{ color: '#475569' }}>{t('Notes')}:</strong> {selectedPoint.feedback.notes}</div>}
                  {selectedPoint.feedback?.logged_at && (
                    <div style={{ fontSize: '0.62rem', color: '#64748b', marginTop: '2px' }}>
                      {t('Logged')}: {new Date(selectedPoint.feedback.logged_at).toLocaleString()}
                    </div>
                  )}
                </div>
              )}

              {/* Photos Row (if present) */}
              {selectedPoint.feedback?.photos && JSON.parse(JSON.stringify(selectedPoint.feedback.photos)).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                  <div style={{ fontWeight: 800, color: '#475569', fontSize: '0.7rem' }}>{t('Submitted Pictures')} ({JSON.parse(JSON.stringify(selectedPoint.feedback.photos)).length})</div>
                  <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px' }}>
                    {JSON.parse(JSON.stringify(selectedPoint.feedback.photos)).map((img: string, i: number) => (
                      <img
                        key={i}
                        src={img}
                        alt={`Attachment ${i+1}`}
                        style={{
                          width: '64px',
                          height: '46px',
                          objectFit: 'cover',
                          borderRadius: '4px',
                          border: '1px solid rgba(0,0,0,0.1)',
                          cursor: 'pointer',
                          flexShrink: 0
                        }}
                        onClick={() => window.open(img, '_blank')}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Actions Footer Links */}
              <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: '6px', marginTop: '4px' }}>
                <button
                  onClick={() => downloadSingleCSV(selectedPoint)}
                  style={{
                    flex: 1,
                    backgroundColor: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    padding: '4px 6px',
                    fontSize: '0.68rem',
                    color: '#334155',
                    cursor: 'pointer',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px'
                  }}
                >
                  <FileSpreadsheet size={12} /> CSV
                </button>
                <button
                  onClick={() => downloadSinglePDF(selectedPoint)}
                  style={{
                    flex: 1,
                    backgroundColor: '#f8fafc',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    padding: '4px 6px',
                    fontSize: '0.68rem',
                    color: '#334155',
                    cursor: 'pointer',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px'
                  }}
                >
                  <FileText size={12} /> {t('Print PDF')}
                </button>
              </div>

            </div>
          </Popup>
        )}
        
        <MapToolbar
          t={t}
          viewMode={viewMode}
          onAddDataClick={onAddDataClick}
          activeBasemap={activeBasemap}
          setActiveBasemap={setActiveBasemap}
          basemapOpen={basemapOpen}
          setBasemapOpen={setBasemapOpen}
          points={points}
          isMobile={isMobile}
        />
      </MapContainer>

      {/* Tap-to-activate shield. Until it is dismissed a vertical swipe over the map
          scrolls the page instead of panning the map, so a 55vh map block cannot trap
          the user mid-page. Desktop never sees it. */}
      {isMobile && !touchActivated && (
        <button
          type="button"
          onClick={() => setTouchActivated(true)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 900,
            border: 'none',
            background: 'transparent',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '10px',
            cursor: 'pointer',
            // Let the browser handle the swipe as a page scroll rather than Leaflet.
            touchAction: 'pan-y'
          }}
          aria-label={t('Tap to activate map')}
        >
          <span className="glass-panel" style={{
            padding: '5px 12px',
            borderRadius: '9999px',
            fontSize: '0.65rem',
            fontWeight: 800,
            color: '#fff',
            letterSpacing: '0.02em',
            pointerEvents: 'none'
          }}>
            {t('Tap to activate map')}
          </span>
        </button>
      )}
    </div>
  );
};

// Memoized: the dashboard and the field app both re-render on filter changes, language
// switches and selection changes, and without this every one of those rebuilds the
// whole marker layer.
export const FieldMap = React.memo(FieldMapImpl);
