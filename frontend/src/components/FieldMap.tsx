import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type LocalPoint, getResolvedStatus } from '../db/indexedDb';
import { Layers, FolderPlus, Home, FileSpreadsheet, FileText } from 'lucide-react';

interface FieldMapProps {
  points: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
  viewMode: 'collector' | 'dashboard';
  onAddDataClick?: () => void;
  isEditLocationMode?: boolean;
  onPointPositionChange?: (lat: number, lng: number) => void;
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
  
  // Track serialized points IDs to trigger bounds fitting only when the point set changes
  const pointsKey = points.map(p => p.id).join(',');

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

// Available basemaps
const BASEMAPS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; CartoDB'
  },
  streets: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap'
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
  }
};

type BasemapKey = keyof typeof BASEMAPS;


const MapToolbar: React.FC<{
  viewMode: 'collector' | 'dashboard';
  onAddDataClick?: () => void;
  activeBasemap: BasemapKey;
  setActiveBasemap: (val: BasemapKey) => void;
  basemapOpen: boolean;
  setBasemapOpen: (val: boolean) => void;
  points: LocalPoint[];
}> = ({
  viewMode,
  onAddDataClick,
  activeBasemap,
  setActiveBasemap,
  basemapOpen,
  setBasemapOpen,
  points
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
      bottom: '16px',
      left: viewMode === 'dashboard' ? '444px' : '16px',
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
              Dark Canvas
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
              OSM Streets
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
              Satellite Map
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
          title="Zoom In"
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
          title="Zoom Out"
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
          title="Fit bounds"
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
          title="Basemap switcher"
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
            title="Add Data Layer"
          >
            <FolderPlus size={16} />
          </button>
        )}
      </div>

      {/* Horizontal Map Legend Bar (Screenshot Match) */}
      <div className="glass-panel" style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '6px 14px',
        borderRadius: '9999px',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: 'var(--shadow-lg)'
      }}>
        <span style={{ fontWeight: 800, color: '#fff', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderRight: '1px solid rgba(255,255,255,0.15)', paddingRight: '10px' }}>
          Map Legend
        </span>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.7rem', color: '#cbd5e1', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', border: '0.75px solid white' }}></div>
            <span>Investigated</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#ef4444', border: '0.75px solid white' }}></div>
            <span>Pending</span>
          </div>
        </div>
      </div>

    </div>
  );
};

export const FieldMap: React.FC<FieldMapProps> = ({ 
  points, 
  selectedPoint, 
  onSelectPoint, 
  viewMode, 
  onAddDataClick,
  isEditLocationMode = false,
  onPointPositionChange
}) => {
  const [activeBasemap, setActiveBasemap] = useState<BasemapKey>('dark');
  const [basemapOpen, setBasemapOpen] = useState(false);
  const [popupPointId, setPopupPointId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedPoint) {
      setPopupPointId(selectedPoint.id);
    } else {
      setPopupPointId(null);
    }
  }, [selectedPoint]);

  // Center on Wilhelmshaven coordinates
  const getMapCenter = (): [number, number] => {
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
  };

  const center = getMapCenter();

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <MapContainer
        center={center}
        zoom={18}
        maxZoom={22}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          attribution={BASEMAPS[activeBasemap].attribution}
          url={BASEMAPS[activeBasemap].url}
          maxZoom={22}
          maxNativeZoom={19}
        />
        
        {points.map((point) => {
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
                    <p style={{ margin: '2px 0', fontSize: '0.75rem', fontWeight: 600, color: '#64748b' }}>DRAG TO RE-POSITION</p>
                  </div>
                </Popup>
              </Marker>
            );
          }

          // Otherwise, render a high-performance CircleMarker (small point size)
          return (
            <CircleMarker
              key={point.id}
              center={[point.latitude, point.longitude]}
              radius={isSelected ? 6 : 2.5}
              fillColor={color}
              color="#ffffff"
              weight={isSelected ? 1.5 : 0.4}
              fillOpacity={0.9}
              eventHandlers={{
                click: () => onSelectPoint(point)
              }}
            />
          );
        })}

        <MapController points={points} selectedPoint={selectedPoint} />

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
                  {getResolvedStatus(selectedPoint).toUpperCase()}
                </span>
              </div>

              {/* UTM Coordinates & GPR Meta */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'rgba(0,0,0,0.02)', padding: '6px 8px', borderRadius: '8px' }}>
                <div><strong style={{ color: '#475569' }}>Project ID:</strong> {selectedPoint.project_id || '11-24-2736'}</div>
                <div><strong style={{ color: '#475569' }}>Target ID:</strong> {selectedPoint.target_id || 'N/A'}</div>
                <div><strong style={{ color: '#475569' }}>UTM coords:</strong> X: {selectedPoint.easting} | Y: {selectedPoint.northing}</div>
                <div><strong style={{ color: '#475569' }}>Survey Layer:</strong> {selectedPoint.layer || 'N/A'}</div>
                <div><strong style={{ color: '#475569' }}>Evaluated Depth:</strong> {selectedPoint.evaluated_depth ? `${selectedPoint.evaluated_depth} m` : 'N/A'}</div>
              </div>

              {/* Feedback Log (if visited) */}
              {selectedPoint.feedback && selectedPoint.feedback.visited && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'rgba(16, 185, 129, 0.05)', borderLeft: '3.5px solid #10b981', padding: '6px 8px', borderRadius: '4px' }}>
                  <div style={{ fontWeight: 800, color: '#10b981', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '2px' }}>Field Log Feedback</div>
                  <div><strong style={{ color: '#475569' }}>Sohle Status:</strong> {selectedPoint.feedback?.sohle_status || 'N/A'}</div>
                  <div><strong style={{ color: '#475569' }}>Fundstück:</strong> {selectedPoint.feedback?.fundstueck || 'N/A'}</div>
                  {selectedPoint.feedback?.m_cube !== null && <div><strong style={{ color: '#475569' }}>Volumen:</strong> {selectedPoint.feedback.m_cube} m³</div>}
                  <div><strong style={{ color: '#475569' }}>Actual Depth:</strong> {selectedPoint.feedback?.actual_depth ? `${selectedPoint.feedback.actual_depth} m` : 'N/A'}</div>
                  <div><strong style={{ color: '#475569' }}>Investigator:</strong> {selectedPoint.feedback?.investigator || 'N/A'}</div>
                  {selectedPoint.feedback?.notes && <div><strong style={{ color: '#475569' }}>Notes:</strong> {selectedPoint.feedback.notes}</div>}
                  {selectedPoint.feedback?.logged_at && (
                    <div style={{ fontSize: '0.62rem', color: '#64748b', marginTop: '2px' }}>
                      Logged: {new Date(selectedPoint.feedback.logged_at).toLocaleString()}
                    </div>
                  )}
                </div>
              )}

              {/* Photos Row (if present) */}
              {selectedPoint.feedback?.photos && JSON.parse(JSON.stringify(selectedPoint.feedback.photos)).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                  <div style={{ fontWeight: 800, color: '#475569', fontSize: '0.7rem' }}>Submitted Pictures ({JSON.parse(JSON.stringify(selectedPoint.feedback.photos)).length})</div>
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
                  <FileText size={12} /> Print PDF
                </button>
              </div>

            </div>
          </Popup>
        )}
        
        <MapToolbar
          viewMode={viewMode}
          onAddDataClick={onAddDataClick}
          activeBasemap={activeBasemap}
          setActiveBasemap={setActiveBasemap}
          basemapOpen={basemapOpen}
          setBasemapOpen={setBasemapOpen}
          points={points}
        />
      </MapContainer>
    </div>
  );
};
