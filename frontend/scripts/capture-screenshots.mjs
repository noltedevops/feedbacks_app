// Captures every screenshot the landing page and the docs use, from the built app in
// static/ with the API mocked in the browser. Fake demo data only: no account, no
// database, no real project, site or person appears in any image.
//
//   npm run build                       (the screenshots show what static/ holds)
//   npm run screenshots                 (everything)
//   npm run screenshots -- landing      (only the 8 landing images)
//   npm run screenshots -- docs         (only the 3 docs images)
//   npm run build                       (again, so static/landing gets the new images)
//
// Needs a network connection for the basemap tiles, and Chromium for Playwright:
// `npx playwright install chromium` once per machine.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = path.resolve(FRONTEND, '../static');
const LANDING_OUT = path.join(FRONTEND, 'public/landing');
const DOCS_OUT = path.resolve(FRONTEND, '../docs');

// ---------------------------------------------------------------- demo data
// One fictitious survey along a stretch of North Sea dyke that is not a client site.
// Project id, name, VM numbers, coordinates and crew are all invented.
const PROJECT = { project_id: '10-00-0001', project_name: 'Demo Site North' };
const CREW = { full_name: 'Demo Crew', username: 'demo' };
const SITE = { lat: 54.466, lon: 9.0105 };                // start of the target line
const OBSERVER = { latitude: 54.4775, longitude: 9.0165 }; // for the popup's distance/bearing

const FINDS = ['Eisenteil', 'Eisenseil', 'ohne Fund', 'Eisennägel', 'Eisendraht',
  'Sonstige', 'Steine', 'Eisenteil', 'ohne Fund', 'Eisenteil'];

function demoPoints() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r1 = (x) => Math.round(x * 10) / 10;
  const points = [];
  for (let i = 0; i < 180; i++) {
    const t = i / 180;
    const latitude = SITE.lat + t * 0.030 + Math.sin(t * 9) * 0.0010 + (rnd() - 0.5) * 0.0005;
    const longitude = SITE.lon + t * 0.006 + Math.cos(t * 7) * 0.0012 + (rnd() - 0.5) * 0.0005;
    const evaluated = r1(0.3 + rnd() * 1.4);
    const dug = i % 3 === 0;
    const fund = FINDS[i % FINDS.length];
    const instrument = i % 7 === 0 ? 'georadar' : 'magnetic';
    const laenge = r1(0.6 + rnd() * 1.4);
    const breite = r1(0.5 + rnd() * 1.0);
    const actual = r1(Math.max(0.2, evaluated + (rnd() - 0.5) * 0.5));
    const easting = Math.round((500260 + i * 1.5 + rnd()) * 1000) / 1000;
    const northing = Math.round((6035600 + i * 15.5 + rnd()) * 1000) / 1000;
    const target_id = `${PROJECT.project_id}-${easting.toFixed(3)}-${northing.toFixed(3)}`;
    points.push({
      id: `demo-${i}`, project_id: PROJECT.project_id, target_id, vm_nr: `0001-${1000 + i}`,
      easting, northing, latitude, longitude, evaluated_depth: evaluated,
      opening_length: null, opening_width: null, opening_depth: null, opening_volume: null,
      find_description: null, image_id: null, remarks: null, created_at: null,
      instrument, layer: instrument === 'magnetic' ? 'Magnetik Nord' : 'Georadar Nord',
      category: ['Kat-1', 'Kat-2', 'Kat-2', 'Kat-3'][i % 4],
      feedback: dug ? {
        id: `fb-${i}`, visited: true, status: 'investigated', actual_depth: actual, photos: [],
        notes: null, investigator: CREW.full_name, investigator_username: CREW.username,
        logged_at: `2026-09-${String(2 + (i % 12)).padStart(2, '0')}T10:00:00Z`, target_id,
        sohle_status: i % 9 === 0 ? 'Nicht Frei' : 'Frei', bilder_n: 0,
        other: fund === 'Sonstige' ? 'Holzbalken' : null, fundstueck: fund, laenge, breite,
        m_cube: Math.round(laenge * breite * actual * 100) / 100, teams_tools: null,
      } : null,
    });
  }
  return points;
}

const POINTS = demoPoints();

// Real projects and people that must never appear in a published image. The data above
// is invented, so a match means something real leaked in (a cached session, a changed
// mock): shoot() refuses to save the image. Extend this when a project or user is added.
const FORBIDDEN = [/Wilhe?lmshaven/i, /Seedeich/i, /R(ü|ue)stersiel/i, /K(ö|oe)ln/i, /Deutzerfeld/i,
  /11-24-2736/, /11-26-5151/, /2736-\d/, /5151-\d/, /musonera/i];
const USER = {
  status: 'success', id: 'usr-demo', username: CREW.username, full_name: CREW.full_name,
  email: null, role: 'collector', can_field: true, can_dashboard: true, is_admin: false,
  must_change_password: false, token: 'demo-token',
};

// ---------------------------------------------------------------- static server
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // The landing images come from public/, so docs shots of the landing show the
    // images just captured rather than the copies from the last build.
    const candidates = urlPath.startsWith('/landing/')
      ? [path.join(FRONTEND, 'public', urlPath)]
      : [path.join(STATIC, urlPath)];
    let file = candidates.find((f) => f.startsWith(path.dirname(STATIC)) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) file = path.join(STATIC, 'index.html');   // SPA fallback
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------- browser helpers
async function newPage(browser, base, { theme, lang, width, height }) {
  const context = await browser.newContext({
    viewport: { width, height }, serviceWorkers: 'block',
    geolocation: OBSERVER, permissions: ['geolocation'],
  });
  await context.addInitScript(([th, lg]) => {
    try { localStorage.setItem('theme', th); localStorage.setItem('nolte_lang', lg); } catch { /* ok */ }
  }, [theme, lang]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/auth/login' || p === '/api/auth/me') return json(USER);
    if (p === '/api/projects') return json([PROJECT]);
    if (p === '/api/points') return json(POINTS);
    if (p === '/api/sync') return json({ status: 'success', points: POINTS });
    if (p.startsWith('/api/permissions/requests') || p.startsWith('/api/admin/users')) return json([]);
    return json({ detail: 'not mocked' }, 404);
  });
  page.errors = errors;
  await page.goto(base + '/');
  return page;
}

async function signIn(page) {
  await page.locator('button.landing-auth.btn-secondary:visible, button.landing-cta-btn.btn-secondary:visible').first().click();
  await page.locator('input[autocomplete="username"]').fill(CREW.username);
  await page.locator('input[autocomplete="current-password"]').fill('demo');
  await page.locator('input[autocomplete="current-password"]').press('Enter');
  await page.locator('button.sidebar-item').first().waitFor({ timeout: 15000 });
  // The welcome toast is transient; wait it out rather than capture it.
  await page.getByText(/Welcome back|Willkommen zurück/).first()
    .waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

/** Every requested basemap tile has loaded, and the fade-in has finished. */
async function tilesSettled(page) {
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll('.leaflet-tile')];
    return tiles.length > 0 && tiles.every((t) => t.classList.contains('leaflet-tile-loaded'));
  }, null, { timeout: 30000 }).catch(async () => {
    const info = await page.evaluate(() => {
      const t = [...document.querySelectorAll('.leaflet-tile')];
      return { n: t.length, loaded: t.filter((x) => x.classList.contains('leaflet-tile-loaded')).length, src: t.slice(0, 2).map((x) => x.src) };
    });
    console.warn('  tiles did not all load', JSON.stringify(info));
  });
  await page.waitForTimeout(800);
}

async function openField(page) {
  await page.locator('button.sidebar-item').nth(0).click();
  await page.locator('.collector-title').waitFor();
  // Name the demo project in the heading rather than "All Projects".
  await page.locator('.collector-field button:visible, .collector-field select:visible').first().click();
  await page.locator('[role="option"]').filter({ hasText: PROJECT.project_id }).first().click();
  await tilesSettled(page);
}

async function openDashboard(page) {
  await page.locator('button.sidebar-item').nth(1).click();
  await page.locator('button.dash-control--project').first().waitFor();
  await page.locator('button.dash-control--project').first().click();
  await page.locator('[role="option"]').filter({ hasText: PROJECT.project_id }).first().click();
  await tilesSettled(page);
}

/**
 * Opens the map popup of an investigated target, as a crew member would: by clicking
 * its marker. The markers are painted on one canvas, so there is no element to click;
 * this finds a green (investigated) marker pixel below the middle of the map, leaving
 * the popup room above it. Selecting a target also opens its form, as in the app.
 */
async function openPopup(page) {
  // Selecting a target zooms in to the basemap's last level of detail: z19 on the
  // satellite imagery, against z16 on the grey canvas. The imagery shows the ground the
  // crew is standing on. Switch first: switching basemap closes an open popup.
  await page.getByRole('button', { name: /^(Basemap switcher|Kartenhintergrund wechseln)$/ }).first().click();
  await page.getByRole('button', { name: /Satellite Map/ }).first().click();
  // At the project's own zoom the markers overlap; two steps in spreads them apart.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: /^(Zoom In|Vergrößern)$/ }).first().click();
    await page.waitForTimeout(400);
  }
  await tilesSettled(page);
  const hit = await page.evaluate(() => {
    const canvas = document.querySelector('.leaflet-overlay-pane canvas');
    if (!canvas) return null;
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / width;
    const mapRect = document.querySelector('.leaflet-container').getBoundingClientRect();
    const want = { x: mapRect.x + mapRect.width * 0.55, y: mapRect.y + mapRect.height * 0.7 };
    const green = [], red = [];
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const k = (y * width + x) * 4;
        const [r, g, b, a] = [data[k], data[k + 1], data[k + 2], data[k + 3]];
        if (a < 200) continue;
        const px = rect.x + x * scale, py = rect.y + y * scale;
        if (px < mapRect.x + 20 || px > mapRect.right - 20 || py < mapRect.y + 20 || py > mapRect.bottom - 20) continue;
        if (g > 120 && g > r * 1.4 && g > b * 1.1) green.push([px, py]);
        else if (r > 150 && r > g * 1.4) red.push([px, py]);
      }
    }
    // A green marker with no pending marker within the click tolerance, so the click
    // cannot land on a neighbour; of those, the one nearest the wanted spot.
    let best = null;
    for (const [x, y] of green) {
      if (red.some(([rx, ry]) => (rx - x) ** 2 + (ry - y) ** 2 < 16 ** 2)) continue;
      const d = (x - want.x) ** 2 + (y - want.y) ** 2;
      if (!best || d < best.d) best = { x, y, d };
    }
    return best;
  });
  if (!hit) throw new Error('no investigated marker found on the map canvas');
  await page.mouse.click(hit.x, hit.y);
  await page.locator('.leaflet-popup').first().waitFor({ timeout: 5000 });
  if (!(await page.locator('.leaflet-popup').innerText()).match(/Field Log|Feld-Protokoll/i)) {
    throw new Error('the popup opened on a target without feedback');
  }
  await tilesSettled(page);
}

// ---------------------------------------------------------------- the shots
async function landingShots(browser, base) {
  for (const theme of ['light', 'dark']) {
    for (const lang of ['EN', 'DE']) {
      const suffix = `${theme}-${lang.toLowerCase()}`;
      const page = await newPage(browser, base, { theme, lang, width: 1440, height: 900 });
      await signIn(page);
      await openField(page);
      await shoot(page, path.join(LANDING_OUT, `collector-${suffix}.jpg`), { type: 'jpeg', quality: 82 });
      await openDashboard(page);
      await shoot(page, path.join(LANDING_OUT, `decision-${suffix}.jpg`), { type: 'jpeg', quality: 82 });
      report(page, `landing ${suffix}`);
      await page.context().close();
    }
  }
}

async function docsShots(browser, base) {
  // The landing page as a visitor first sees it.
  let page = await newPage(browser, base, { theme: 'dark', lang: 'EN', width: 1440, height: 900 });
  await page.locator('.landing-root h1').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  // Wait out the entrance animations rather than guessing how long they take.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'
    || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await shoot(page, path.join(DOCS_OUT, 'app_main.png'));
  report(page, 'docs app_main');
  await page.context().close();

  // The two surfaces. 1440x900 like every other shot: the selected marker is centred,
  // so a target's popup needs half the map's height, and 748 px (the old size) cut it off.
  page = await newPage(browser, base, { theme: 'dark', lang: 'EN', width: 1440, height: 900 });
  await signIn(page);
  // Dashboard first: opening a popup selects a target, and the dashboard would follow it.
  await openDashboard(page);
  await shoot(page, path.join(DOCS_OUT, 'shot_dashboard.png'));
  await openField(page);
  await openPopup(page);
  await shoot(page, path.join(DOCS_OUT, 'shot_fieldapp.png'));
  report(page, 'docs field + dashboard');
  await page.context().close();
}

/** Screenshot, after checking the page shows no real project or person. */
async function shoot(page, file, options = {}) {
  const text = await page.evaluate(() => document.body.innerText);
  const hit = FORBIDDEN.find((re) => re.test(text));
  if (hit) throw new Error(`${path.basename(file)}: page text matches ${hit}; not saved`);
  await page.screenshot({ path: file, ...options });
}

function report(page, label) {
  if (page.errors.length) throw new Error(`${label}: page errors: ${page.errors.join(' | ')}`);
  console.log('captured', label);
}

const which = process.argv[2] || 'all';
if (!fs.existsSync(path.join(STATIC, 'index.html'))) throw new Error('static/ is empty: run npm run build first');
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  if (which === 'all' || which === 'landing') await landingShots(browser, base);
  if (which === 'all' || which === 'docs') await docsShots(browser, base);
} finally {
  await browser.close();
  server.close();
}
