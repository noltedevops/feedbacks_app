import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type LocalPoint, getResolvedStatus } from '../db/indexedDb';
import { Layers, FolderPlus, Home, ChevronLeft, ChevronRight, Download, X, Check, Plus, Minus } from 'lucide-react';
import { makeT, type AppLang, type Translator } from '../i18n';
import { useTheme } from '../useTheme';
import { useTokenColors } from '../useTokenColors';
import { haversineMetres, forwardAzimuth, formatDistance } from '../geo';
import { useUserPosition } from '../useUserPosition';

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

/* Marker fills, from the status tokens.
 *
 * The canvas basemap now follows the theme - light grey under the light theme, dark
 * under the dark - so the markers follow it too: the darkened status hues on the light
 * canvas, the bright ones on the dark. The bright green the markers used to keep in
 * both themes was about 2:1 on the light canvas, under the 3:1 a marker needs.
 *
 * Leaflet paints CircleMarkers on a canvas, and a canvas fill cannot read var(), so
 * the tokens are resolved here, once per theme. The stroke is the surface colour, which
 * separates a dot from its neighbours on every basemap. The legend reads the same
 * tokens in CSS, so it always matches the markers it explains. */
function useStatusFill() {
  const theme = useTheme();
  const c = useTokenColors(['--status-found-rgb', '--status-pending-rgb', '--surface'] as const);
  return useMemo(() => ({
    found: c['--status-found-rgb'],
    pending: c['--status-pending-rgb'],
    stroke: c['--surface'],
    theme
  }), [c, theme]);
}


/* Maps a target's resolved status to the .status-chip vocabulary, so the popup's pill
 * takes the same status tokens as the target lists - the popup is where a target's
 * status is read most closely. */
const STATUS_CHIP: Record<string, string> = {
  clear: 'found',
  uxo: 'pending',
  scrap: 'scrap',
  false_alarm: 'alarm'
};

/* Static bearing arrow on a compass rose.
 *
 * Deliberately not a live device compass. Reading one means deviceorientation plus a
 * magnetometer calibration the crew has to perform, and the absolute heading it
 * reports is unreliable across devices and browsers - iOS exposes it under a
 * different, permission-gated event, Android varies by handset, and a phone near
 * excavated ferrous metal is exactly where a magnetometer is least trustworthy.
 *
 * So north is fixed to the screen, matching the north-up map underneath, and the
 * needle is a bearing drawn against it. That is a number computed from two positions:
 * it does not drift, does not need calibrating, and is the same on every device.
 *
 * The degrees are printed beside the rose as well. The arrow is the quick read; the
 * number is what survives being looked at on a small screen in daylight, and it means
 * the direction is not carried by the graphic alone. */
const CompassRose: React.FC<{ bearing: number; label: string }> = ({ bearing, label }) => (
  <svg className="tp-rose" viewBox="0 0 48 48" role="img" aria-label={label}>
    <circle className="tp-rose-ring" cx="24" cy="24" r="16" />
    {/* E, S and W as plain ticks; north is the letter above, so the needle can never
        be mistaken for the north mark whatever the bearing. */}
    <path className="tp-rose-tick" d="M40 24 h-3 M24 40 v-3 M8 24 h3" />
    <text className="tp-rose-n" x="24" y="7.5" textAnchor="middle">N</text>
    <g transform={`rotate(${bearing} 24 24)`}>
      <path className="tp-rose-needle" d="M24 11 L27.5 25.5 L24 22.8 L20.5 25.5 Z" />
    </g>
    <circle className="tp-rose-hub" cx="24" cy="24" r="1.6" />
  </svg>
);

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

  // Where the crew is, if the device will say. Null covers every failure - denied, no
  // hardware, timed out, insecure context - and the section below is simply not
  // rendered, rather than showing an error on every target opened.
  //
  // The target's own position is read straight off the point: the server writes
  // latitude/longitude alongside the UTM easting/northing, so no conversion happens
  // here and none is added.
  const userPosition = useUserPosition();
  const relative = useMemo(() => {
    if (!userPosition) return null;
    const target = { latitude: point.latitude, longitude: point.longitude };
    return {
      distance: formatDistance(haversineMetres(userPosition, target)),
      bearing: forwardAzimuth(userPosition, target),
    };
  }, [userPosition, point.latitude, point.longitude]);

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

      {relative && (
        <section className="tp-here">
          <CompassRose
            bearing={relative.bearing}
            label={`${t('Bearing')} ${Math.round(relative.bearing)}°`}
          />
          <div className="tp-here-text">
            <span className="tp-here-dist">{relative.distance} {t('away')}</span>
            <span className="tp-here-bearing">
              {t('Bearing')} {Math.round(relative.bearing)}°
            </span>
          </div>
        </section>
      )}

      {/* No section title: the header directly above already says which target these
          belong to, and with the list this short another rule across the card is
          chrome rather than structure. */}
      <section className="tp-section">
        <Row
          label={t('Coordinate')}
          value={
            <span className="tp-coord">
              <span className="tp-num">E {point.easting ?? '--'}</span>
              <span className="tp-num">N {point.northing ?? '--'}</span>
            </span>
          }
          stack
        />
        <Row label={t('Project ID')} value={point.project_id || '--'} />
        <Row label={t('Evaluated Depth')} value={point.evaluated_depth ? `${point.evaluated_depth} m` : t('N/A')} />
      </section>

      {/* The remaining three only exist once a target has been opened, so they keep
          their own block - the green rule is what says these came from the field log
          rather than from the survey. */}
      {feedback?.visited && (
        <section className="tp-section tp-feedback">
          <div className="tp-section-title tp-feedback-title">{t('Field Log Feedback')}</div>
          <Row label={t('Actual Depth')} value={feedback.actual_depth ? `${feedback.actual_depth} m` : t('N/A')} />
          <Row
            label={t('Volumen')}
            value={feedback.m_cube !== null && feedback.m_cube !== undefined ? `${feedback.m_cube} m³` : t('N/A')}
          />
          <Row label={t('Investigator')} value={feedback.investigator || t('N/A')} stack />
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
// The replacement is Esri's Canvas rather than a vector basemap. Vector was tried first
// and lost: MapLibre needs a WebGL context plus a separately bundled web worker, and
// when that worker 404s the map still initialises, still paints its background, and
// renders nothing else - a black rectangle with no error thrown. On a field app that
// runs on whatever tablet a crew owns, a basemap that can fail silently and invisibly
// is worse than one that is merely coarse.
//
// The canvas follows the theme: Esri's Light Gray Canvas under the light theme, its
// Dark Gray Canvas under the dark one. Same keyless service family on the same host,
// so the theme switch adds no provider. Only this entry varies - streets and satellite
// are photographs of the world and look the same whatever the chrome around them.
const CANVAS_LIGHT = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  labelsUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  // Drawn for this canvas as-is, so no filter on either layer.
  className: undefined,
  labelsClassName: undefined
};

const BASEMAPS = {
  canvas: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    // Esri splits the canvas in two: geometry in the base service above, and every
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
  { key: 'canvas', label: 'Canvas' },
  { key: 'streets', label: 'OSM Streets' },
  { key: 'satellite', label: 'Satellite Map' }
];

const BasemapLayer: React.FC<{ basemap: BasemapKey }> = ({ basemap }) => {
  const theme = useTheme();
  const config = basemap === 'canvas' && theme === 'light'
    ? { ...BASEMAPS.canvas, ...CANVAS_LIGHT }
    : BASEMAPS[basemap];
  const labelsUrl = 'labelsUrl' in config ? config.labelsUrl : undefined;

  // Keyed by theme: Leaflet applies a tile layer's className once, at creation, so a
  // theme switch has to build the layers afresh to drop or add the dark filter.
  return (
    <>
      <TileLayer
        key={`base-${theme}`}
        attribution={config.attribution}
        url={config.url}
        maxZoom={22}
        maxNativeZoom={config.maxNativeZoom}
        className={'className' in config ? config.className : undefined}
      />
      {labelsUrl && (
        <TileLayer
          key={`labels-${theme}`}
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

  // Everything here is styled by the map-toolbar classes in field.css; the only thing
  // that varies by caller is which side of the dashboard column the stack clears.
  return (
    <div className={`map-toolbar${viewMode === 'dashboard' ? ' map-toolbar--dashboard' : ''}`}>

      {/* Basemap switcher popout. The active option is marked by a tick as well as by
          colour. */}
      <div className="map-toolbar-anchor">
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
                  {isActive && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="map-controls">
        <button type="button" className="map-control" onClick={handleZoomIn} title={t('Zoom In')} aria-label={t('Zoom In')}>
          <Plus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="map-control" onClick={handleZoomOut} title={t('Zoom Out')} aria-label={t('Zoom Out')}>
          <Minus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="map-control" onClick={handleHome} title={t('Fit bounds')} aria-label={t('Fit bounds')}>
          <Home size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="map-control"
          onClick={() => setBasemapOpen(!basemapOpen)}
          aria-expanded={basemapOpen}
          title={t('Basemap switcher')}
          aria-label={t('Basemap switcher')}
        >
          <Layers size={16} aria-hidden="true" />
        </button>
        {viewMode === 'dashboard' && onAddDataClick && (
          <button type="button" className="map-control" onClick={onAddDataClick} title={t('Add Data Layer')} aria-label={t('Add Data Layer')}>
            <FolderPlus size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Legend. The caption is the first thing to go on a phone - the two swatches
          next to it already say what it says. */}
      <div className="map-legend">
        {!isMobile && <span className="map-legend-caption">{t('Map Legend')}</span>}
        <span className="map-legend-item">
          <span className="map-legend-dot" data-status="found" aria-hidden="true" />
          {t('Investigated')}
        </span>
        <span className="map-legend-item">
          <span className="map-legend-dot" data-status="pending" aria-hidden="true" />
          {t('Pending')}
        </span>
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
  const [activeBasemap, setActiveBasemap] = useState<BasemapKey>('canvas');
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
  //
  // `tolerance` widens the hit area without touching the drawing. Leaflet reads it only
  // in Path._clickTolerance(), which only _containsPoint() calls, so the marker is
  // painted at exactly the radius below and merely answers to clicks further out. On
  // desktop that takes the target from 2.7px (radius 2.5 + half the 0.4 stroke) to
  // 8.7px - a marker you can hit without pixel-hunting.
  const renderer = useMemo(() => L.canvas({ padding: 0.5, tolerance: 6 }), []);

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
  const statusFill = useStatusFill();

  const markers = useMemo(() => (
    points.map((point) => {
      const isSelected = selectedPoint?.id === point.id;
      const isInvestigated = point.local_status === 'investigated';
      const color = isInvestigated ? statusFill.found : statusFill.pending;

      if (isSelected && isEditLocationMode) {
        // A draggable marker for editing the location. Styled by .marker-edit in
        // field.css from the same status tokens, so it needs no colour of its own here.
        return (
          <Marker
            key={point.id}
            position={[point.latitude, point.longitude]}
            draggable={true}
            icon={L.divIcon({
              className: 'custom-leaflet-marker',
              html: `<div class="map-marker-pin marker-selected marker-edit" data-status="${isInvestigated ? 'found' : 'pending'}"><span></span></div>`,
              iconSize: [16, 16],
              iconAnchor: [8, 8]
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
            <Popup className="target-popup">
              <div className="tp tp--compact">
                <span className="tp-vm num">VM Nr. {point.vm_nr}</span>
                <span className="tp-section-title">{t('DRAG TO RE-POSITION')}</span>
              </div>
            </Popup>
          </Marker>
        );
      }

      // Otherwise, render a high-performance CircleMarker (small point size), drawn
      // into the shared canvas renderer rather than as its own SVG path. Touch
      // targets get a bigger radius - 2.5px is unhittable with a finger.
      // Keyed by theme as well as target: react-leaflet applies a CircleMarker's colour
      // props when it creates the layer and not on later renders, so a theme switch has
      // to build the markers afresh to repaint them.
      return (
        <CircleMarker
          key={`${point.id}-${statusFill.theme}`}
          center={[point.latitude, point.longitude]}
          renderer={renderer}
          radius={isSelected ? 6 : (isMobile ? 4 : 2.5)}
          fillColor={color}
          color={statusFill.stroke}
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
  ), [points, selectedPoint, isEditLocationMode, onSelectPoint, openPopupFor, onPointPositionChange, renderer, isMobile, t, statusFill]);

  return (
    <div className="field-map">
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
          className="map-shield"
          onClick={() => setTouchActivated(true)}
          aria-label={t('Tap to activate map')}
        >
          <span className="map-shield-hint">{t('Tap to activate map')}</span>
        </button>
      )}
    </div>
  );
};

// Memoized: the dashboard and the field app both re-render on filter changes, language
// switches and selection changes, and without this every one of those rebuilds the
// whole marker layer.
export const FieldMap = React.memo(FieldMapImpl);
