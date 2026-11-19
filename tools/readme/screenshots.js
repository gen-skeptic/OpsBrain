// Screenshots of the web UI for the README, taken from a server running on demo data
// (see tools/readme/demo-data.ts). Never point this at a real OpsBrain.
// Usage: OPSBRAIN_DEMO_URL=http://127.0.0.1:8790 OPSBRAIN_DEMO_KEY=obk_... node tools/readme/screenshots.js
const path = require("path");
const { chromium } = require("playwright");
const base = process.env.OPSBRAIN_DEMO_URL ?? "http://127.0.0.1:8790";
const key = process.env.OPSBRAIN_DEMO_KEY;
if (!key) throw new Error("Set OPSBRAIN_DEMO_KEY to the key printed by demo-data.ts");
const out = path.resolve(__dirname, "..", "..", "docs", "assets", "opsbrain");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/login`);
  await page.fill("#f-key", key);
  await page.click("button:has-text('Sign in')");
  await page.waitForURL(/\/crm$/);
  const shot = async (name, height = 820, width = 1280) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, `${name}.png`), clip: { x: 0, y: 0, width, height } });
    console.log(`Wrote docs/assets/opsbrain/${name}.png`);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await shot("ui-pipeline", 900, 1440);
  await page.click("a:has-text('Patient intake automation')");
  await shot("ui-deal", 900);
  await page.goto(`${base}/approvals`);
  await shot("ui-approvals", 640);
  await page.goto(`${base}/crm/companies`);
  await page.click("a:has-text('Acme Dental')");
  await shot("ui-company", 900);
  await browser.close();
})();
