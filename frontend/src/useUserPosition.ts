import { useEffect, useState } from 'react';
import { type LatLng } from './geo';

/**
 * The device's current position, or null when there isn't one.
 *
 * One value for every way this can fail - permission denied, no hardware, a timeout,
 * a browser without the API, a page not served from a secure context - because the
 * caller treats them identically: it hides the section. A crew that declined the
 * prompt does not need an error telling them so on every target they open, and a
 * distance the app cannot compute is not a fault to report.
 *
 * Called from the popup rather than at app start, so the permission prompt appears
 * when a target is opened and the answer is about to be used, not on a cold load.
 *
 * A single fix, not watchPosition: the bearing this feeds is static by design, and
 * maximumAge lets the browser answer repeat opens from a recent fix rather than
 * waking the GPS for each one.
 *
 * Note for deployment: browsers only expose geolocation in a secure context. It works
 * on localhost as it stands, but over plain http on a hostname the API is absent and
 * the section will stay hidden - HTTPS is already on the open-items list.
 */
export function useUserPosition(): LatLng | null {
  const [position, setPosition] = useState<LatLng | null>(null);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    // The callbacks can land after the popup has closed; without this they would set
    // state on an unmounted component.
    let live = true;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!live) return;
        setPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      },
      () => {
        // Denied, unavailable or timed out - all the same to the caller.
        if (live) setPosition(null);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );

    return () => { live = false; };
  }, []);

  return position;
}
