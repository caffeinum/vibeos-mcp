/**
 * Drive a real vibeos.sh/app tab for a live e2e, when no Chrome extension is
 * around. Needs a headless Chrome with remote debugging:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
 *     --remote-debugging-port=9333 --user-data-dir=/tmp/vibeos-e2e-profile about:blank &
 *   npm i --no-save puppeteer-core
 *   node live-tab.mjs shot.png "<js evaluated in the page; may await>"
 *
 * Flow that pairs a token: click "Continue without AI features" (under Other
 * options), the ⚙ button, "Capabilities", "Pair an agent"; the pane text then
 * carries `--token <64 hex>`. Feed that to `mcpt tools npx -y vibeos-mcp --token …`.
 * Verified 2026-09-04: tools, list_apps and vm_exec round-trip; the pane counts
 * the calls and names the relay instance.
 */
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: { width: 1400, height: 900 } });
const pages = await browser.pages();
let page = pages.find((p) => p.url().startsWith("https://vibeos.sh/app"));
if (!page) { page = pages[0] ?? await browser.newPage(); await page.goto("https://vibeos.sh/app", { waitUntil: "networkidle2", timeout: 60000 }); await new Promise((r) => setTimeout(r, 4000)); }
if (process.argv[3]) {
  const out = await page.evaluate(process.argv[3]);
  console.log("eval:", typeof out === "string" ? out : JSON.stringify(out, null, 1)?.slice(0, 3000));
  await new Promise((r) => setTimeout(r, 1500));
}
await page.screenshot({ path: process.argv[2] });
browser.disconnect();
