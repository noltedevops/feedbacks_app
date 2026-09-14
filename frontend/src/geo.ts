/**
 * Distance and bearing between two WGS84 positions.
 *
 * Pure functions, no React and no coordinate conversion. The targets already carry
 * `latitude`/`longitude` alongside their UTM easting/northing - the server writes both
 * - so anything working from a point's position reads those directly. Nothing here
 * needs a UTM -> lat/lng step, and none is added: the only conversion in the frontend
 * is latLonToUtm32nJS in FeedbackForm, which runs the other way.
 *
 * Spherical, not ellipsoidal. Over the few hundred metres between a crew and a target
 * the difference from Vincenty is well under a metre, and the numbers here are rounded
 * far coarser than that before they are shown.
 */

/** IUGG mean Earth radius, in metres. */
const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in metres. */
export function haversineMetres(from: LatLng, to: LatLng): number {
  const phi1 = toRad(from.latitude);
  const phi2 = toRad(to.latitude);
  const dPhi = toRad(to.latitude - from.latitude);
  const dLambda = toRad(to.longitude - from.longitude);

  const a = Math.sin(dPhi / 2) ** 2 +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Initial great-circle bearing (forward azimuth) in degrees clockwise from TRUE north,
 * normalised to [0, 360).
 *
 * True north, not magnetic: there is no declination correction here, and none is
 * wanted. The arrow this feeds is drawn against a rose whose north is fixed to the
 * screen, matching the north-up map beneath it - not against a device compass, which
 * is what magnetic north would be for.
 */
export function forwardAzimuth(from: LatLng, to: LatLng): number {
  const phi1 = toRad(from.latitude);
  const phi2 = toRad(to.latitude);
  const dLambda = toRad(to.longitude - from.longitude);

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Distance as the crew reads it.
 *
 * Metres below a kilometre, and whole metres at that - a GPS fix on a phone is good to
 * several metres, so a decimal would be inventing precision the number does not have.
 * Rounded to 10 m past 300 m for the same reason. Kilometres above that, to one
 * decimal, which is where a target belonging to another part of the site lands.
 */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '--';
  if (metres < 1) return '<1 m';
  if (metres < 300) return `${Math.round(metres)} m`;
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
