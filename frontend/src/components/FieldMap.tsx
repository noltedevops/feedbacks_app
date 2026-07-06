import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type LocalPoint } from '../db/indexedDb';
import { Layers, FolderPlus, Home } from 'lucide-react';

interface FieldMapProps {
  points: LocalPoint[];
  selectedPoint: LocalPoint | null;
  onSelectPoint: (point: LocalPoint | null) => void;
  viewMode: 'collector' | 'dashboard';
  onAddDataClick?: () => void;
  isEditLocationMode?: boolean;
  onPointPositionChange?: (lat: number, lng: number) => void;
}

const MapController: React.FC<{ 
  points: LocalPoint[]; 
  selectedPoint: LocalPoint | null; 
  resetBoundsTrigger: number;
}> = ({ points, selectedPoint, resetBoundsTrigger }) => {
  const map = useMap();
  
  // Track serialized points IDs to trigger bounds fitting only when the point set changes
  const pointsKey = points.map(p => p.id).join(',');

  useEffect(() => {
    if (points.length > 0) {
      const bounds = L.latLngBounds(points.map(p => [p.latitude, p.longitude]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    }
  }, [pointsKey, resetBoundsTrigger, map]);

  useEffect(() => {
    if (selectedPoint) {
      map.setView([selectedPoint.latitude, selectedPoint.longitude], 19);
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
  const [resetBoundsTrigger, setResetBoundsTrigger] = useState(0);

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

  // Custom marker pin creator
  const createCustomIcon = (point: LocalPoint) => {
    const status = point.local_status || 'unvisited';
    const isSelected = selectedPoint?.id === point.id;
    const isInvestigated = status !== 'unvisited';
    
    let color = '#64748b'; // default slate grey for unvisited
    
    if (viewMode === 'dashboard') {
      // Dashboard mode: Green for investigated, Red for pending
      color = isInvestigated ? '#10b981' : '#ef4444';
    } else {
      // Collector mode: Detailed status colors
      if (status === 'clear') color = '#10b981'; // Green
      else if (status === 'scrap') color = '#f59e0b'; // Gold
      else if (status === 'uxo') color = '#ef4444'; // Red
      else if (status === 'false_alarm') color = '#8b5cf6'; // Violet
      else if (status !== 'unvisited') color = '#3b82f6'; // Custom status (Blue)
    }

    return L.divIcon({
      className: 'custom-leaflet-marker',
      html: `
        <div class="map-marker-pin ${isSelected ? 'marker-selected' : ''}" 
             style="background-color: ${color}; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid white; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 5px rgba(0,0,0,0.5);">
          <div style="width: 4px; height: 4px; background-color: white; border-radius: 50%;"></div>
        </div>
      `,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  };

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <MapContainer
        center={center}
        zoom={18}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <TileLayer
          attribution={BASEMAPS[activeBasemap].attribution}
          url={BASEMAPS[activeBasemap].url}
        />
        
        {points.map((point) => {
          const isSelected = selectedPoint?.id === point.id;
          return (
            <Marker
              key={point.id}
              position={[point.latitude, point.longitude]}
              icon={createCustomIcon(point)}
              draggable={isSelected && isEditLocationMode}
              eventHandlers={{
                click: () => onSelectPoint(point),
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
                  <p style={{ margin: '2px 0' }}>Calculated Depth: {point.calculated_depth ? `${point.calculated_depth}m` : 'N/A'}</p>
                  <p style={{ margin: '2px 0' }}>Find: {point.find_description || 'N/A'}</p>
                  <p style={{ margin: '2px 0', fontWeight: 'bold' }}>
                    Status: <span style={{ 
                      color: 
                        point.local_status === 'clear' ? '#10b981' :
                        point.local_status === 'scrap' ? '#f59e0b' :
                        point.local_status === 'uxo' ? '#ef4444' :
                        point.local_status === 'false_alarm' ? '#8b5cf6' :
                        point.local_status && point.local_status !== 'unvisited' ? '#3b82f6' : '#64748b'
                    }}>{(point.local_status || 'pending').toUpperCase()}</span>
                  </p>
                </div>
              </Popup>
            </Marker>
          );
        })}

        <MapController points={points} selectedPoint={selectedPoint} resetBoundsTrigger={resetBoundsTrigger} />
      </MapContainer>
      
      {/* Custom Basemap & Add Data Widget Toolbar (Top Right Stack) */}
      <div style={{
        position: 'absolute',
        top: '12px',
        right: '12px',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '8px'
      }}>
        
        {/* Basemap Switcher Wrapper with Absolute Popout Options */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          {basemapOpen && (
            <div style={{
              position: 'absolute',
              right: '46px',
              top: '0px',
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
          
          <button
            onClick={() => setBasemapOpen(!basemapOpen)}
            style={{
              backgroundColor: 'rgba(17, 24, 39, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '50%',
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              cursor: 'pointer',
              boxShadow: 'var(--shadow-md)',
              transition: 'background-color 0.2s'
            }}
            title="Switch Basemap"
          >
            <Layers size={18} />
          </button>
        </div>

        {/* Home Reset Extent Button */}
        <button
          onClick={() => setResetBoundsTrigger(prev => prev + 1)}
          style={{
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            cursor: 'pointer',
            boxShadow: 'var(--shadow-md)',
            transition: 'background-color 0.2s, transform 0.15s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#1e293b';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(17, 24, 39, 0.95)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          title="Zoom to Fit All Points"
        >
          <Home size={18} />
        </button>

        {/* Add Data Widget Button */}
        {viewMode === 'dashboard' && onAddDataClick && (
          <button
            onClick={onAddDataClick}
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '50%',
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#38bdf8',
              cursor: 'pointer',
              boxShadow: 'var(--shadow-md)',
              transition: 'background-color 0.2s, transform 0.15s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#334155';
              e.currentTarget.style.transform = 'scale(1.05)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#1e293b';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            title="Add Data Layer"
          >
            <FolderPlus size={18} />
          </button>
        )}
      </div>

      {/* Floating Legend */}
      <div style={{
        position: 'absolute',
        bottom: '12px',
        right: '12px',
        zIndex: 1000,
        backgroundColor: 'rgba(17, 24, 39, 0.95)',
        padding: '10px 14px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        fontSize: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }}>
        <div style={{ fontWeight: 'bold', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '4px', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {viewMode === 'dashboard' ? 'Clearance Status' : 'Target Legend'}
        </div>
        
        {viewMode === 'dashboard' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#10b981', border: '1px solid white' }}></div>
              <span>Investigated (Visited)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ef4444', border: '1px solid white' }}></div>
              <span>Pending (Unvisited)</span>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#64748b', border: '1px solid white' }}></div>
              <span>Unvisited / Pending</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#10b981', border: '1px solid white' }}></div>
              <span>Cleared (Empty)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ef4444', border: '1px solid white' }}></div>
              <span>UXO / Mine Found</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#f59e0b', border: '1px solid white' }}></div>
              <span>Scrap Metal Dug</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#8b5cf6', border: '1px solid white' }}></div>
              <span>False Alarm</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#3b82f6', border: '1px solid white' }}></div>
              <span>Other Custom Finding</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
