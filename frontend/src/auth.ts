/**
 * Session token and per-surface access, shared by every API call site.
 *
 * The token is what the server trusts. The flags mirrored here only decide what
 * the UI offers - the server re-checks them on every request, so a flag flipped
 * in devtools buys nothing.
 */
export type Surface = 'field' | 'dashboard';

export interface Access {
  can_field: boolean;
  can_dashboard: boolean;
  is_admin: boolean;
}

const TOKEN_KEY = 'nolte_token';
const ACCESS_KEY = 'nolte_access';

export const NO_ACCESS: Access = { can_field: false, can_dashboard: false, is_admin: false };

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string | null, access: Access) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ACCESS_KEY, JSON.stringify(access));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCESS_KEY);
}

/**
 * Accounts the server has actually authenticated on this device.
 *
 * Deliberately outlives clearSession(): it records what this *device* has
 * learned, not who is signed in now. Signing out must not turn the device back
 * into one that will accept an unknown name offline.
 */
const KNOWN_KEY = 'nolte_known_users';

type KnownUsers = Record<string, Access>;

function readKnown(): KnownUsers {
  try {
    const raw = localStorage.getItem(KNOWN_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as KnownUsers : {};
  } catch {
    return {};
  }
}

/** Record a login the server checked, so this account may later work offline. */
export function rememberOnlineLogin(username: string, access: Access) {
  const known = readKnown();
  known[username] = access;
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
  } catch {
    // A full quota only costs this account its offline privilege; not fatal.
  }
}

/**
 * What to grant when the backend cannot be reached, or null to refuse.
 *
 * Offline nobody checks the password, so this is gated on the server having
 * accepted this exact account here before. It grants the field app only: the
 * dashboard and the admin screens are server-backed, and handing them out on an
 * unverified password would show data this person may no longer be allowed.
 */
export function offlineAccessFor(username: string): Access | null {
  const remembered = readKnown()[username];
  if (!remembered || !remembered.can_field) return null;
  return { can_field: true, can_dashboard: false, is_admin: false };
}

export function getAccess(): Access {
  try {
    const raw = localStorage.getItem(ACCESS_KEY);
    if (!raw) return NO_ACCESS;
    const parsed = JSON.parse(raw);
    return {
      can_field: !!parsed.can_field,
      can_dashboard: !!parsed.can_dashboard,
      is_admin: !!parsed.is_admin,
    };
  } catch {
    return NO_ACCESS;
  }
}

/** fetch() with the bearer token attached. */
export function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** The surface a 403 was about, so the caller can offer to request it. */
export async function deniedSurface(res: Response): Promise<Surface | null> {
  if (res.status !== 403) return null;
  try {
    const body = await res.clone().json();
    const surface = body?.detail?.surface;
    return surface === 'field' || surface === 'dashboard' ? surface : null;
  } catch {
    return null;
  }
}
