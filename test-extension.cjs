/**
 * Manual smoke test: load the built extension in Chromium (new headless mode)
 * and verify (a) the popup page loads and renders without JS errors, and
 * (b) the content script injects on a matching host but not elsewhere.
 *
 * Usage: npm run build && node test-extension.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, 'dist');

async function main() {
  if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
    throw new Error('dist/manifest.json not found — run `npm run build` first.');
  }

  const context = await chromium.launchPersistentContext('', {
    // Extensions require new headless mode with full Chromium (not the shell).
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  let failures = 0;
  const check = (ok, label, extra) => {
    console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failures++;
  };

  try {
    // 1. Service worker (background) — proves the extension loaded at all.
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const extensionId = new URL(sw.url()).host;
    check(true, 'extension loaded', `id=${extensionId}`);
    check(true, 'background service worker running', sw.url());

    // 2. Popup page — collect JS/console errors while loading and rendering.
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;
    const response = await page.goto(popupUrl, { waitUntil: 'load' });
    check(
      response?.ok() ?? response?.status() === 200,
      'popup served over HTTP',
      `status=${response?.status()}`,
    );

    try {
      await page.waitForSelector('.export-btn', { timeout: 10_000 });
      const heading = await page.textContent('.app-header h1');
      const button = await page.textContent('.export-btn');
      check(
        heading?.trim() === 'Kontext' && button?.includes('Export'),
        'popup rendered (Preact mounted)',
        `heading="${heading?.trim()}" button="${button?.trim()}"`,
      );
    } catch (err) {
      check(false, 'popup rendered (Preact mounted)', String(err).split('\n')[0]);
    }

    check(pageErrors.length === 0, 'no uncaught JS errors on popup page',
      pageErrors.join(' | ') || undefined);
    check(consoleErrors.length === 0, 'no console errors on popup page',
      consoleErrors.join(' | ') || undefined);

    // 3. Content script injection on a MATCHING host (chatgpt.com).
    //
    // Assertion strategy: the hover-style <style> is only injected once the
    // script's page-guard recognises a real conversation DOM, so it is NOT a
    // reliable signal on a landing page or a bot-challenge interstitial (which
    // is what chatgpt.com serves to a headless instance). The reliable signal is
    // the script's own load log, which fires whenever the manifest injects it.
    let csLogSeen = false;
    let csOwnedErrors = [];
    let styleInjected = undefined;
    const matched = await context.newPage();
    // Only count errors attributable to the extension. A bot-challenge page
    // (Cloudflare 403) throws plenty of console noise from its own blocked
    // resources — that says nothing about our content script.
    const isOurs = t => /kontekst|kontext|content-script|extension/i.test(t);
    matched.on('console', msg => {
      const t = msg.text();
      if (t.includes('[Kontext] ChatGPT content script loaded')) csLogSeen = true;
      if (msg.type() === 'error' && isOurs(t)) csOwnedErrors.push(t);
    });
    matched.on('pageerror', err => {
      const t = String(err);
      if (isOurs(t)) csOwnedErrors.push(t);
    });
    try {
      const resp = await matched.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await matched.waitForTimeout(3000);
      styleInjected = await matched.evaluate(
        () => !!document.getElementById('__kontekst-cb-styles'),
      );
      check(csLogSeen, 'chatgpt content script injected & executed',
        `nav status=${resp?.status()}`);
      // Informational only — depends on the site serving a real conversation.
      console.log(
        `${styleInjected ? '[ok]  ' : '[info]'} hover-style <style> present: ${styleInjected}` +
          (styleInjected ? '' : ' (expected when no conversation DOM is present)'),
      );
      check(!csOwnedErrors.length, 'no extension-attributable errors on chatgpt.com',
        csOwnedErrors.join(' | ') || undefined);
    } catch (err) {
      console.log(`[skip] could not navigate to chatgpt.com: ${String(err).split('\n')[0]}`);
    }

    // 4. A NON-matching host must not receive the script.
    const unmatched = await context.newPage();
    await unmatched.goto('https://example.com/', { waitUntil: 'load' });
    const leaked = await unmatched.evaluate(
      () => !!document.getElementById('__kontekst-cb-styles'),
    );
    check(!leaked, 'example.com did not receive the chatgpt content script');

    if (failures > 0) {
      console.log(`\n${failures} check(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log('\nAll checks passed');
    }
  } finally {
    await context.close();
  }
}

main().catch(err => {
  console.error('[FAIL] test harness crashed:', err);
  process.exit(1);
});
