const { chromium } = require('playwright');
const path = require('path');
const EXT_PATH = path.resolve(__dirname, 'dist');

async function main() {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  let failures = 0;
  const check = (ok, label, extra) => {
    console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failures++;
  };
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(sw.url()).host;

    // Verify every icon the manifest declares actually resolves (200), and that
    // the notification code's iconUrl resolves too.
    const page = await context.newPage();
    for (const size of [16, 32, 48, 128]) {
      const url = `chrome-extension://${id}/icons/icon${size}.png`;
      const resp = await page.goto(url, { waitUntil: 'load' }).catch(() => null);
      check(resp?.status() === 200, `icon${size}.png resolves`, `status=${resp?.status()}`);
    }

    // The dash-variant the notification code used to reference must NOT exist.
    const bad = await page
      .goto(`chrome-extension://${id}/icons/icon-128.png`, { waitUntil: 'load' })
      .catch(() => null);
    check(bad?.status() !== 200, 'old dash-variant icons/icon-128.png is gone', `status=${bad?.status()}`);

    // Confirm the bundled background script really references the fixed path.
    // Use a FRESH page: the 404 probe above leaves `page` on chrome-error://,
    // so reusing it makes the next navigation die with an interrupted-nav error.
    const bgPage = await context.newPage();
    await bgPage.goto(`chrome-extension://${id}/src/popup/index.html`, { waitUntil: 'load' });
    const bg = await bgPage.evaluate(async extId => {
      const r = await fetch(`chrome-extension://${extId}/src/background/index.js`);
      const t = await r.text();
      return { hasFixed: t.includes('icon128.png'), hasBroken: t.includes('icon-128.png') };
    }, id);
    check(bg.hasFixed && !bg.hasBroken, 'background bundle references icons/icon128.png',
      JSON.stringify(bg));

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    if (failures) process.exitCode = 1;
  } finally {
    await context.close();
  }
}
main().catch(e => { console.error('[FAIL] harness crashed:', e); process.exit(1); });
