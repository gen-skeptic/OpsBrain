// Render the README images from the Dautel Design System copy in server/ui/assets.
// Usage (from the repository root, needs Node and Playwright with Chromium):
//   node tools/readme/render.js
// Writes docs/assets/opsbrain/{banner,architecture,para}.png at 2x.
const fs = require("fs"), path = require("path"), os = require("os");
const { chromium } = require("playwright");
const repo = path.resolve(__dirname, "..", "..");
const assets = path.join(repo, "server", "ui", "assets");
const out = path.join(repo, "docs", "assets", "opsbrain");
const pages = [["banner", 1280, 420], ["architecture", 1280, 660], ["para", 1280, 500]];
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opsbrain-readme-"));
  fs.copyFileSync(path.join(__dirname, "_base.css"), path.join(tmp, "_base.css"));
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const [name, width, height] of pages) {
    const html = fs.readFileSync(path.join(__dirname, `${name}.html`), "utf8").replaceAll("{{ASSETS}}", "file://" + assets);
    fs.writeFileSync(path.join(tmp, `${name}.html`), html);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto("file://" + path.join(tmp, `${name}.html`));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, `${name}.png`), clip: { x: 0, y: 0, width, height } });
    await page.close();
    console.log(`Wrote docs/assets/opsbrain/${name}.png`);
  }
  await browser.close();
})();
