import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type LocalPoint, getResolvedStatus } from '../db/indexedDb';
import { Layers, FolderPlus, Home, ChevronLeft, ChevronRight, Download, X, Check } from 'lucide-react';
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

/* Marker and legend fills.
 *
 * These deliberately do NOT follow the app theme, unlike the .status-chip text in
 * index.css. A chip is a word on a white card and has to darken to stay readable; a
 * marker is a dot on the basemap, and the basemap is chosen independently of the theme -
 * dark canvas is the default in light mode too. Darkening these would put a dark dot on
 * a dark map. They keep the bright hue and their white stroke, which reads on canvas,
 * streets and satellite alike, and the legend matches the markers it explains. */
const STATUS_FILL = { found: '#10b981', pending: '#ef4444' } as const;


/* The popup's status pill sits inside .map-container-section, which is a .glass-panel,
 * so the light-theme text override flattened it the same way it flattened the target
 * list chips. It carries .status-chip to opt out of that and to take its colour from
 * the same tokens - the popup is where a target's status is read most closely. */
const STATUS_CHIP: Record<string, string> = {
  clear: 'found',
  uxo: 'pending',
  scrap: 'scrap',
  false_alarm: 'alarm'
};

/* Popup shown when a target marker is clicked.
 *
 * Photos are base64 strings already held in IndexedDB, so both the carousel and
 * the download work entirely client-side - nothing here calls the API, and the
 * download needs no endpoint. Only one image is mounted at a time; the previous
 * version rendered every attachment as a thumbnail, which on a target with a
 * dozen field photos meant decoding all of them to show a strip 46px tall.
 *
 * Colours come from the theme tokens rather than the literals this popup used
 * before, so it is legible in light and dark alike. */
const TargetPopup: React.FC<{ point: LocalPoint; t: Translator }> = ({ point, t }) => {
  const photos = useMemo<string[]>(
    () => (Array.isArray(point.feedback?.photos) ? point.feedback.photos : []),
    [point.feedback?.photos]
  );
  const [index, setIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);

  // A different target can be selected while this stays mounted; without the
  // reset the carousel would open on the previous point's photo number.
  useEffect(() => { setIndex(0); }, [point.id]);

  const status = getResolvedStatus(point);
  const chipStatus = STATUS_CHIP[status] ?? 'empty';
  const feedback = point.feedback;

  const step = (delta: number) => {
    if (photos.length === 0) return;
    setIndex((i) => (i + delta + photos.length) % photos.length);
  };

  const downloadCurrent = () => {
    const src = photos[index];
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `VM_${point.vm_nr}_photo_${index + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // `stack` drops the value onto its own full-width line. Free text - notes, long
  // names - has nothing useful to align against in a narrow value column, and
  // squeezing it there is what forced it to wrap a character at a time.
  const Row: React.FC<{ label: string; value: React.ReactNode; stack?: boolean }> = ({ label, value, stack }) => (
    <div className={stack ? 'tp-row tp-row--stack' : 'tp-row'}>
      <span className="tp-row-label">{label}</span>
      <span className="tp-row-value">{value}</span>
    </div>
  );

  return (
    <div className="tp">
      <header className="tp-head">
        <span className="tp-vm">VM {point.vm_nr}</span>
        <span className="tp-status status-chip" data-status={chipStatus}>
          {t(status).toUpperCase()}
        </span>
      </header>

      <section className="tp-section">
        <div className="tp-section-title">{t('UTM coords')}</div>
        <div className="tp-row">
          <span className="tp-row-label">X</span>
          <span className="tp-row-value tp-num">{point.easting ?? '--'}</span>
        </div>
        <div className="tp-row">
          <span className="tp-row-label">Y</span>
          <span className="tp-row-value tp-num">{point.northing ?? '--'}</span>
        </div>
      </section>

      <section className="tp-section">
        <div className="tp-section-title">{t('Survey Layer')}</div>
        <Row label={t('Project ID')} value={point.project_id || '--'} />
        <Row label={t('Target ID')} value={point.target_id || t('N/A')} />
        <Row label={t('Survey Layer')} value={point.layer || t('N/A')} />
        <Row label={t('Evaluated Depth')} value={point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')} />
      </section>

      {feedback?.visited && (
        <section className="tp-section tp-feedback">
          <div className="tp-section-title tp-feedback-title">{t('Field Log Feedback')}</div>
          <Row label={t('Sohle Status')} value={feedback.sohle_status || t('N/A')} />
          <Row label="Fundstück" value={feedback.fundstueck || t('N/A')} />
          {feedback.m_cube !== null && feedback.m_cube !== undefined && (
            <Row label={t('Volumen')} value={`${feedback.m_cube} m³`} />
          )}
          <Row label={t('Actual Depth')} value={feedback.actual_depth ? `${feedback.actual_depth} m` : t('N/A')} />
          <Row label={t('Investigator')} value={feedback.investigator || t('N/A')} stack />
          {feedback.notes && <Row label={t('Notes')} value={feedback.notes} stack />}
          {feedback.logged_at && (
            <div className="tp-logged">{t('Logged')}: {new Date(feedback.logged_at).toLocaleString()}</div>
          )}
        </section>
      )}

      {photos.length > 0 && (
        <section className="tp-photos">
          <div className="tp-photos-head">
            <span>{t('Submitted Pictures')}</span>
            {photos.length > 1 && <span className="tp-count">{index + 1} / {photos.length}</span>}
          </div>

          <div className="tp-stage">
            <img
              src={photos[index]}
              alt={`${t('Submitted Pictures')} ${index + 1}`}
              className="tp-img"
              onClick={() => setLightbox(true)}
            />

            {photos.length > 1 && (
              <>
                <button type="button" className="tp-nav tp-nav-prev" onClick={() => step(-1)} aria-label={t('Previous')}>
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className="tp-nav tp-nav-next" onClick={() => step(1)} aria-label={t('Next')}>
                  <ChevronRight size={16} />
                </button>
              </>
            )}
          </div>

          <button type="button" className="tp-download" onClick={downloadCurrent}>
            <Download size={13} />
            {photos.length > 1 ? t('Download this photo') : t('Download photo')}
          </button>
        </section>
      )}

      {lightbox && photos[index] && (
        <div className="tp-lightbox" onClick={() => setLightbox(false)} role="dialog" aria-modal="true">
          <button type="button" className="tp-lightbox-close" aria-label={t('Close')}>
            <X size={18} />
          </button>
          <img src={photos[index]} alt={`${t('Submitted Pictures')} ${index + 1}`} />
        </div>
      )}
    </div>
  );
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

// Order the switcher lists them in. Separate from BASEMAPS so the tile configuration
// above stays about tiles, and so the labels sit next to each other for translation.
const BASEMAP_OPTIONS: { key: BasemapKey; label: string }[] = [
  { key: 'dark', label: 'Dark Canvas' },
  { key: 'streets', label: 'OSM Streets' },
  { key: 'satellite', label: 'Satellite Map' }
];

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
      
      {/* Basemap switcher options popout.
       *
       * Three near-identical inline-styled buttons before this, on a card that only
       * looked right in dark theme: the labels were a hardcoded #fff, and the active
       * option was distinguished by an orange tint that the light theme's blanket text
       * override flattened along with its orange label. Styling lives in index.css now
       * and reads the overlay tokens, so both themes come from the same source, and the
       * active option is marked by a tick as well as by colour. */}
      <div style={{ position: 'relative' }}>
        {basemapOpen && (
          <div className="basemap-menu" role="group" aria-label={t('Basemap')}>
            <div className="basemap-menu-caption">{t('Basemap')}</div>
            {BASEMAP_OPTIONS.map(({ key, label }) => {
              const isActive = activeBasemap === key;
              return (
                <button
                  key={key}
                  type="button"
                  className="basemap-option"
                  aria-pressed={isActive}
                  onClick={() => { setActiveBasemap(key); setBasemapOpen(false); }}
                >
                  <span className="basemap-option-label">{t(label)}</span>
                  {isActive && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Vertical control widgets stack */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--overlay)',
        border: '1px solid var(--overlay-border)',
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
            borderBottom: '1px solid var(--overlay-border)',
            color: 'var(--overlay-text)',
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
            borderBottom: '1px solid var(--overlay-border)',
            color: 'var(--overlay-text)',
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
            borderBottom: '1px solid var(--overlay-border)',
            color: 'var(--overlay-text)',
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
            color: 'var(--overlay-text)',
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
        border: '1px solid var(--surface-border)',
        boxShadow: 'var(--shadow-lg)',
        maxWidth: '100%',
        flexWrap: 'wrap'
      }}>
        {/* The "MAP LEGEND" caption is the first thing to go on a 380px screen - the two
            colour chips next to it already say what it says. */}
        {!isMobile && (
          <span style={{ fontWeight: 800, color: 'var(--surface-text)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderRight: '1px solid var(--surface-border)', paddingRight: '10px' }}>
            {t('Map Legend')}
          </span>
        )}
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.7rem', color: 'var(--surface-text-muted)', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: STATUS_FILL.found, border: '0.75px solid white' }}></div>
            <span>{t('Investigated')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: STATUS_FILL.pending, border: '0.75px solid white' }}></div>
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
  // An open popup is a *request*, not a mirror of the selection.
  //
  // Mirroring is what broke clicking a marker: closing the popup leaves the target
  // selected, so clicking that same marker again is not a change in `selectedPoint`
  // and an effect keyed on it never fires. The list looked fine only because
  // dismissing its form clears the selection first, so re-picking the target is a
  // real transition. The counter makes every request distinct, which is what lets
  // the same target be re-opened.
  const [popupRequest, setPopupRequest] = useState<{ id: string; seq: number } | null>(null);
  const popupSeq = useRef(0);

  // Re-keys the Popup, so react-leaflet builds a fresh Leaflet popup and opens it
  // even when Leaflet closed the previous one behind React's back - which is exactly
  // what the map's own close-popup-on-click does on the way into this handler.
  const openPopupFor = useCallback((id: string) => {
    popupSeq.current += 1;
    setPopupRequest({ id, seq: popupSeq.current });
  }, []);

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

  // Selecting from the target list only ever arrives as a change of `selectedPoint`,
  // so that still has to open the popup. Holding the request steady when it already
  // points at this target keeps a marker click - which has asked for the popup itself,
  // below - from re-keying it a second time and remounting for nothing.
  useEffect(() => {
    if (!selectedPoint) {
      setPopupRequest(null);
      return;
    }
    setPopupRequest((current) => {
      if (current && current.id === selectedPoint.id) return current;
      popupSeq.current += 1;
      return { id: selectedPoint.id, seq: popupSeq.current };
    });
  }, [selectedPoint]);

  // react-leaflet reopens the popup whenever `position` changes identity, so a fresh
  // array literal would tear it down and rebuild it on every unrelated render of this
  // component. Pinned to the coordinates, it moves only when the target actually does -
  // which it still needs to do while a location is being dragged.
  const selectedLat = selectedPoint?.latitude;
  const selectedLng = selectedPoint?.longitude;
  const popupPosition = useMemo<[number, number] | null>(
    () => (selectedLat === undefined || selectedLng === undefined ? null : [selectedLat, selectedLng]),
    [selectedLat, selectedLng]
  );

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
      const color = isInvestigated ? STATUS_FILL.found : STATUS_FILL.pending;

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
            // Both halves matter: the selection drives the side panel and the map
            // camera, the popup request drives the popup. Leaving the popup to the
            // selection alone is what made a marker unclickable once its popup had
            // been closed.
            click: () => {
              onSelectPoint(point);
              openPopupFor(point.id);
            }
          }}
        />
      );
    })
  ), [points, selectedPoint, isEditLocationMode, onSelectPoint, openPopupFor, onPointPositionChange, renderer, isMobile, t]);

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

        {/* Keyed on the request rather than on the target: a repeat request for the
            target already showing has to remount, because that is the only thing
            react-leaflet acts on - it opens the popup when the element mounts and
            when `position` changes identity, and neither happens on a re-render that
            renders the same popup for the same place.

            No `remove` handler. It fired for React's own teardown as readily as for
            a user closing the popup, so it could not tell the two apart, and every
            teardown clearing the request is what left the map holding a selection it
            could no longer show. Leaflet closing the popup on its own is fine now:
            the next request re-keys and mounts a new one. */}
        {selectedPoint && popupRequest?.id === selectedPoint.id && (
          <Popup
            key={popupRequest.seq}
            position={popupPosition!}
            maxWidth={340}
            minWidth={286}
            autoPan={true}
            className="target-popup"
          >
            <TargetPopup point={selectedPoint} t={t} />
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
            color: 'var(--surface-text)',
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
