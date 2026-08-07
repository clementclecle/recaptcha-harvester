const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
const config = require("./config");
const { CONTEXTS_PER_BROWSER } = require("./constants");

chromium.use(stealth());

// Mostly Botright's flag set.
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",

  // Less per-tab overhead, and avoids some fingerprint mismatches between the
  // main frame and the reCAPTCHA iframe.
  "--disable-features=IsolateOrigins,site-per-process,TranslateUI",
  "--disable-site-isolation-trials",

  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--use-mock-keychain",

  // Claim a real mouse. Headless otherwise reports a coarse touch pointer on a
  // 1920x1080 desktop viewport, which is a giveaway.
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

const CHROME_PATH_HINTS = [
  '  Windows: "C:/Program Files/Google/Chrome/Application/chrome.exe"',
  '  macOS:   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
  '  Linux:   "/usr/bin/google-chrome"',
].join("\n");

async function launchBrowser(cfg = config) {
  try {
    return await chromium.launch({
      headless: cfg.headless !== false,
      args: LAUNCH_ARGS,
      ...(cfg.chromePath && { executablePath: cfg.chromePath }),
    });
  } catch (err) {
    if (err.message.includes("doesn't exist") || err.message.includes("not found")) {
      throw new Error(
        `Chrome not found at: ${cfg.chromePath || "(Playwright's bundled Chromium)"}\n` +
          `Run "npm run setup", or set chromePath in config.yaml:\n${CHROME_PATH_HINTS}`,
      );
    }
    throw err;
  }
}

// Read the UA off the real binary and pin it to every context, otherwise the UA
// says headless while the rest of the fingerprint says otherwise.
async function detectUserAgent(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    return ua.replace("HeadlessChrome", "Chrome");
  } finally {
    await context.close().catch(() => {});
  }
}

// Warm browsers handed out round-robin. Each solve gets its own context, so
// cookies and storage stay isolated while the process launch is paid once.
class BrowserPool {
  constructor(size = 2) {
    this.size = Math.max(1, size);
    this.browsers = [];
    this.userAgent = undefined;
    this._robin = 0;
  }

  async init() {
    this.browsers = await Promise.all(
      Array.from({ length: this.size }, () => launchBrowser(config)),
    );
    this.userAgent = await detectUserAgent(this.browsers[0]);
    console.log(`[pool] ${this.size} browser(s) ready`);
    console.log(`[pool] UA: ${this.userAgent}`);
  }

  async acquire() {
    if (this.browsers.length === 0) throw new Error("Browser pool is not initialised");

    const idx = this._robin;
    this._robin = (this._robin + 1) % this.browsers.length;

    if (!this.browsers[idx].isConnected()) {
      console.log(`[pool] browser ${idx} disconnected, replacing`);
      await this.browsers[idx].close().catch(() => {});
      this.browsers[idx] = await launchBrowser(config);
    }

    return this.browsers[idx];
  }

  async shutdown() {
    const browsers = this.browsers;
    this.browsers = [];
    await Promise.allSettled(browsers.map((b) => b.close()));
    console.log("[pool] shutdown complete");
  }
}

module.exports = { BrowserPool, launchBrowser, detectUserAgent, CONTEXTS_PER_BROWSER };
