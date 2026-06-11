// One-off: capture the Salon prototype's Talk screen as the fidelity
// reference. Serve docs/prototypes on :8123 first
// (python3 -m http.server 8123), then: node playwright/capture-prototype-talk.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
});
await page.addInitScript(() => {
  const raw = window.localStorage.getItem('clawtalk.salon.v2');
  const state = raw ? JSON.parse(raw) : {};
  state.__route = 'talk';
  window.localStorage.setItem('clawtalk.salon.v2', JSON.stringify(state));
});
await page.goto('http://localhost:8123/ClawTalk%20Salon.html');
await page.addStyleTag({ content: '.twk-panel { display: none !important; }' });
await page.waitForTimeout(3500);
await page.screenshot({
  path: 'playwright/__screens__/prototype-talk-1280.png',
  fullPage: false,
});
await browser.close();
console.log('captured playwright/__screens__/prototype-talk-1280.png');
