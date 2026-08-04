import { useSyncExternalStore } from 'react';

// Single source of truth for the mobile breakpoint. The CSS overrides in index.css
// key off the same 768px, so a layout can never be half-switched: JS and CSS flip
// together.
export const MOBILE_BREAKPOINT = 768;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

// One MediaQueryList for the whole app - every caller subscribes to the same object,
// so there is a single listener regardless of how many components ask.
const mql = typeof window !== 'undefined' ? window.matchMedia(QUERY) : null;

function subscribe(onChange: () => void): () => void {
  if (!mql) return () => {};
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const getSnapshot = () => (mql ? mql.matches : false);

// The dashboard's desktop layout floats absolutely-positioned panels over a
// full-bleed map, so the map is not a sibling in the flow and no media query can
// reorder it into a single reading column. That reflow has to happen in JS, which
// is the only reason this hook exists - everything a media query can handle stays
// in index.css.
//
// useSyncExternalStore rather than useState+useEffect: matchMedia is an external
// store, and reading it through this hook means the very first render already sees
// the correct breakpoint instead of painting the desktop layout and correcting it.
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
