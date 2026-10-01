// WGS84 lat/lng -> UTM zone 32N (EPSG:32632), for a target moved on the map. The only
// coordinate conversion in the frontend; see geo.ts for distance and bearing.
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
