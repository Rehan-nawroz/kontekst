/**
 * Regression test for the duplicate-checkbox flood.
 *
 * Loads the BUILT bundle (dist/src/content-scripts/deepseek.js) into a real
 * page with a chrome stub and fake DeepSeek turn DOM, then hammers the
 * MutationObserver with rapid DOM churn and asserts each turn keeps exactly
 * ONE checkbox. Before the selector fix (bare tag-name query instead of a
 * dotted class query), every refresh appended another checkbox.
 *
 * Usage: npm run build && node test-deepseek-selection.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, 'dist/src/content-scripts/deepseek.js');

async function main() {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', String(e)));

  // Blank page; we only need a DOM to inject into.
  await page.goto('https://example.com/', { waitUntil: 'load' });

  // Stub the chrome API the bundle touches, before it runs.
  await page.addInitScript(() => {
    window.chrome = { runtime: { onMessage: { addListener: () => {} } } };
  });
  await page.reload({ waitUntil: 'load' });

  let failures = 0;
  const check = (ok, label, extra) => {
    console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failures++;
  };

  // Fake DeepSeek turn DOM: 3 turns, each with a numeric data-message-id.
  await page.evaluate(() => {
    document.body.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const turn = document.createElement('div');
      turn.setAttribute('data-message-id', String(1000 + i));
      turn.textContent = `turn ${i}`;
      document.body.appendChild(turn);
    }
  });

  // Inject the real built bundle.
  await page.evaluate(code => {
    const s = document.createElement('script');
    s.textContent = code;
    document.head.appendChild(s);
  }, code);

  await page.waitForTimeout(600);

  const countCheckboxes = () =>
    page.evaluate(() => {
      const turns = [...document.querySelectorAll('[data-message-id]')];
      return turns.map(t => t.querySelectorAll('input.kontekst-cb').length);
    });

  const before = await countCheckboxes();
  check(
    before.every(c => c === 1),
    'initial mount injects exactly 1 checkbox per turn',
    JSON.stringify(before),
  );

  // Stress the MutationObserver: rapid attribute + childList churn on body.
  await page.evaluate(async () => {
    for (let i = 0; i < 25; i++) {
      // childList mutation
      const n = document.createElement('div');
      n.className = 'noise';
      n.textContent = String(i);
      document.body.appendChild(n);
      n.remove();
      // attribute mutation on a watched attr
      document.querySelector('[data-message-id]')?.setAttribute('data-message-id', '1000');
      await new Promise(r => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(800);

  const after = await countCheckboxes();
  check(
    after.every(c => c === 1),
    'after 25 observer-triggering mutations, still exactly 1 checkbox per turn',
    JSON.stringify(after),
  );

  // And the boxes must be visible (enabled=true from auto-mount).
  const visible = await page.evaluate(() => {
    const box = document.querySelector('input.kontekst-cb');
    return box ? getComputedStyle(box).display !== 'none' : null;
  });
  check(visible === true, 'checkbox is visible after auto-mount', `display-block=${visible}`);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  await browser.close();
  if (failures) process.exit(1);
}

main().catch(e => {
  console.error('[FAIL] harness crashed:', e);
  process.exit(1);
});
