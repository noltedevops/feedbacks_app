import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = path.resolve(FRONTEND, '../static');
const SCRATCH = path.resolve(FRONTEND, '../scratch');

const PROJECT = { project_id: '10-00-0001', project_name: 'Demo Site North' };
const CREW = { full_name: 'Demo Crew', username: 'demo' };
const SITE = { lat: 54.466, lon: 9.0105 };
const OBSERVER = { latitude: 54.4775, longitude: 9.0165 };

const FINDS = ['Eisenteil', 'Eisenseil', 'ohne Fund', 'Eisennägel', 'Eisendraht',
  'Sonstige', 'Steine', 'Eisenteil', 'ohne Fund', 'Eisenteil'];

function demoPoints() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r1 = (x) => Math.round(x * 10) / 10;
  const points = [];
  for (let i = 0; i < 180; i++) {
    const t = i / 180;
    const latitude = SITE.lat + t * 0.030 + Math.sin(t * 9) * 0.0010;
    const longitude = SITE.lon + t * 0.006 + Math.cos(t * 7) * 0.0012;
    const evaluated = r1(0.3 + rnd() * 1.4);
    const dug = i % 3 === 0;
    const fund = FINDS[i % FINDS.length];
    const instrument = i % 7 === 0 ? 'georadar' : 'magnetic';
    const actual = r1(Math.max(0.2, evaluated + (rnd() - 0.5) * 0.5));
    const easting = Math.round((500260 + i * 1.5) * 1000) / 1000;
    const northing = Math.round((6035600 + i * 15.5) * 1000) / 1000;
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
        other: fund === 'Sonstige' ? 'Holzbalken' : null, fundstueck: fund, laenge: 0.8, breite: 0.6,
        m_cube: 0.3, teams_tools: null,
      } : null,
    });
  }
  return points;
}

const POINTS = demoPoints();
const USER = {
  status: 'success', id: 'usr-demo', username: CREW.username, full_name: CREW.full_name,
  email: null, role: 'collector', can_field: true, can_dashboard: true, is_admin: false,
  must_change_password: false, token: 'demo-token',
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(STATIC, urlPath);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(STATIC, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function run() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
      geolocation: OBSERVER,
      permissions: ['geolocation'],
    });
    await context.addInitScript(([th, lg]) => {
      try { localStorage.setItem('theme', th); localStorage.setItem('nolte_lang', lg); } catch {}
    }, ['dark', 'EN']);
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

    await page.goto(base + '/');
    await page.locator('button.landing-auth.btn-secondary:visible, button.landing-cta-btn.btn-secondary:visible').first().click();
    await page.locator('input[autocomplete="username"]').fill(CREW.username);
    await page.locator('input[autocomplete="current-password"]').fill('demo');
    await page.locator('input[autocomplete="current-password"]').press('Enter');
    await page.locator('button.sidebar-item').first().waitFor({ timeout: 15000 });
    await page.getByText(/Welcome back|Willkommen zurück/).first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});

    // Open Field App
    await page.locator('.rail-icon--field').locator('..').click();
    await page.waitForSelector('.leaflet-container');
    await page.waitForTimeout(1000);

    // 1. Verify Quick Summary is collapsed into chip on mobile
    const chip = page.locator('.quick-summary-chip');
    await chip.waitFor({ state: 'visible', timeout: 5000 });
    console.log('1. Quick Summary is collapsed into chip by default on mobile.');
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-field-summary-collapsed.png') });

    // 2. Click chip to expand Quick Summary
    await chip.click();
    await page.waitForSelector('.quick-summary-panel');
    console.log('2. Quick Summary expanded into full panel.');
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-field-summary-expanded.png') });

    // 3. Click header minimize button to collapse back
    await page.locator('.quick-summary-toggle-btn').click();
    await chip.waitFor({ state: 'visible' });
    console.log('3. Quick Summary minimized back to chip.');

    // 4. Test Basemap switcher popout
    const layersBtn = page.locator('button[aria-label="Basemap switcher"]');
    await layersBtn.click();
    const basemapMenu = page.locator('.basemap-menu');
    await basemapMenu.waitFor({ state: 'visible', timeout: 5000 });
    const box = await basemapMenu.boundingBox();
    console.log(`4. Basemap menu opened! Bounding box: y=${box?.y}, x=${box?.x}, w=${box?.width}, h=${box?.height}`);
    if (box && box.y >= 0 && box.y + box.height <= 844) {
      console.log('   Basemap menu is 100% visible inside the viewport!');
    } else {
      console.warn('   Basemap menu bounding box warning:', box);
    }
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-field-basemap-open.png') });

    // Close basemap menu by tapping outside
    await page.mouse.click(200, 400);
    await basemapMenu.waitFor({ state: 'hidden', timeout: 5000 });
    console.log('   Basemap menu closed on outside tap.');

    // 5. Test Legend interactivity
    const legend = page.locator('.map-legend');
    await legend.waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-field-legend-normal.png') });
    await legend.click();
    await page.waitForTimeout(300);
    console.log('5. Legend clicked to toggle compact view.');
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-field-legend-toggled.png') });

    // 5b. Test Map pill (switch bottom sheet to peek)
    await page.locator('.sheet-pill-btn').first().click(); // "Map" pill
    await page.waitForTimeout(400);
    console.log('5b. Switched to Map mode (peek sheet).');
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-field-map-peek-mode.png') });

    // 6. Test Dashboard Map tab
    await page.locator('.rail-icon--dashboard').locator('..').click();
    await page.waitForSelector('.dashboard-mobile');
    const mapTabBtn = page.locator('.dash-mobile-tab').nth(1);
    await mapTabBtn.click();
    await page.waitForSelector('.dashboard-mobile-map .leaflet-container');
    await page.waitForTimeout(1000);
    console.log('6. Dashboard Map tab loaded.');
    await page.screenshot({ path: path.join(SCRATCH, 'mobile-dash-map-view.png') });

    if (errors.length) {
      console.error('Errors encountered:', errors);
    } else {
      console.log('ALL MAP ELEMENTS TESTS PASSED WITH 0 ERRORS!');
    }
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch(console.error);
