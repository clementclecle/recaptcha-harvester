const { STEALTH_SCRIPT } = require("./stealth");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORT = { width: 1920, height: 1080 };

function cubicBezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Bezier with two random control points, walked with easeOutQuad so the pointer
// slows into its target. Same idea as Vinyzu/Cursory, minus the trajectory DB.
async function humanMouseMove(page, from, to) {
  const steps = 15 + Math.floor(Math.random() * 20);
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  const cp1 = {
    x: from.x + dx * 0.25 + (Math.random() - 0.5) * 80,
    y: from.y + dy * 0.25 + (Math.random() - 0.5) * 80,
  };
  const cp2 = {
    x: from.x + dx * 0.75 + (Math.random() - 0.5) * 80,
    y: from.y + dy * 0.75 + (Math.random() - 0.5) * 80,
  };

  for (let i = 0; i <= steps; i++) {
    const raw = i / steps;
    const t = raw * (2 - raw);
    await page.mouse.move(
      cubicBezier(t, from.x, cp1.x, cp2.x, to.x),
      cubicBezier(t, from.y, cp1.y, cp2.y, to.y),
    );
    await sleep(5 + Math.random() * 15); // ~60-100 Hz
  }
}

async function simulateHuman(page, { width, height } = VIEWPORT) {
  let pos = {
    x: width * 0.3 + Math.random() * width * 0.4,
    y: height * 0.3 + Math.random() * height * 0.4,
  };
  await page.mouse.move(pos.x, pos.y);
  await sleep(200 + Math.random() * 300);

  const moves = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < moves; i++) {
    const target = {
      x: 100 + Math.random() * (width - 200),
      y: 100 + Math.random() * (height - 200),
    };
    await humanMouseMove(page, pos, target);
    pos = target;
    await sleep(100 + Math.random() * 400);
  }

  if (Math.random() > 0.4) {
    await page.mouse.wheel(0, 80 + Math.random() * 200);
    await sleep(200 + Math.random() * 300);
  }
}

// Cheap version for warm-page re-mints.
async function simulateHumanLight(page, { width, height } = VIEWPORT) {
  const to = {
    x: 100 + Math.random() * (width - 200),
    y: 100 + Math.random() * (height - 200),
  };
  await humanMouseMove(page, { x: to.x - 120, y: to.y - 80 }, to);
  await sleep(150 + Math.random() * 250);
}

// Accepts ip:port, ip:port:user:pass, or http://user:pass@ip:port.
function parseProxy(str) {
  if (!str) return null;

  if (str.includes("@")) {
    try {
      const url = new URL(str.startsWith("http") ? str : `http://${str}`);
      const proxy = { server: `${url.protocol}//${url.hostname}:${url.port}` };
      if (url.username) {
        proxy.username = decodeURIComponent(url.username);
        proxy.password = decodeURIComponent(url.password);
      }
      return proxy;
    } catch {
      return null;
    }
  }

  const parts = str.split(":");
  if (parts.length < 2) return null;
  const proxy = { server: `http://${parts[0]}:${parts[1]}` };
  if (parts.length >= 4) {
    proxy.username = parts[2];
    proxy.password = parts.slice(3).join(":"); // passwords can contain colons
  }
  return proxy;
}

// Use this anywhere a proxy gets logged. Credentials must not hit stdout.
function proxyLabel(str) {
  if (!str) return "direct";
  const parsed = parseProxy(str);
  return parsed ? parsed.server.replace(/^https?:\/\//, "") : "invalid";
}

// Enterprise and plain v3 differ only in which script they load and which
// namespace holds ready/execute. Everything else about solving them is the same.
const SCRIPT_URL = {
  enterprise: "https://www.google.com/recaptcha/enterprise.js",
  v3: "https://www.google.com/recaptcha/api.js",
};

/**
 * Build a page that's ready to mint. Does the expensive one-time work: context
 * (which pins the proxy for its lifetime), stealth, origin navigation, the
 * reCAPTCHA script, and the ready() handshake. After this, minting is just
 * execute().
 *
 * enterprise: true for reCAPTCHA Enterprise, false for plain v3.
 */
async function setupSolverPage(
  browser,
  { websiteURL, websiteKey, proxy, userAgent, enterprise = true, timeout = 15000 },
) {
  const proxyConfig = parseProxy(proxy);
  if (proxy && !proxyConfig) throw new Error(`Malformed proxy: ${proxyLabel(proxy)}`);

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-US",
    ...(proxyConfig && { proxy: proxyConfig }),
    ...(userAgent && { userAgent }),
  });

  try {
    await context.addInitScript(STEALTH_SCRIPT);
    const page = await context.newPage();

    // Only the origin matters to reCAPTCHA, so serve a stub instead of pulling
    // down the real page.
    const origin = new URL(websiteURL).origin;
    await page.route(`${origin}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><head></head><body></body></html>",
      }),
    );
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout });

    await simulateHuman(page);

    const variant = enterprise ? "enterprise" : "v3";

    const alreadyLoaded = await page.evaluate((ent) => {
      if (typeof grecaptcha === "undefined") return false;
      const api = ent ? grecaptcha.enterprise : grecaptcha;
      return !!api && typeof api.execute === "function";
    }, enterprise);

    if (!alreadyLoaded) {
      const src = `${SCRIPT_URL[variant]}?render=${websiteKey}`;
      await page.evaluate(
        ({ url, name }) =>
          new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load recaptcha script (${name})`));
            document.head.appendChild(s);
          }),
        { url: src, name: variant },
      );
    }

    await page.waitForFunction(
      (ent) => {
        if (typeof grecaptcha === "undefined") return false;
        const api = ent ? grecaptcha.enterprise : grecaptcha;
        return !!api && typeof api.execute === "function";
      },
      enterprise,
      { timeout: 10000 },
    );

    await page.evaluate(
      (ent) =>
        new Promise((resolve) => (ent ? grecaptcha.enterprise : grecaptcha).ready(resolve)),
      enterprise,
    );

    return { context, page, origin };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

/** humanize: none | light | full. `enterprise` must match setupSolverPage. */
async function mintToken(
  page,
  { websiteKey, pageAction, humanize = "none", enterprise = true },
) {
  if (humanize === "full") await simulateHuman(page);
  else if (humanize === "light") await simulateHumanLight(page);

  await sleep(300 + Math.random() * 500);

  const token = await page.evaluate(
    ({ siteKey, action, ent }) =>
      (ent ? grecaptcha.enterprise : grecaptcha).execute(siteKey, { action }),
    { siteKey: websiteKey, action: pageAction, ent: enterprise },
  );

  if (!token) throw new Error("Empty token received");
  return token;
}

/** One-shot solve on a pooled browser. Always tears the context down. */
async function solve(browser, params) {
  const { context, page } = await setupSolverPage(browser, params);
  try {
    const token = await mintToken(page, {
      websiteKey: params.websiteKey,
      pageAction: params.pageAction,
      enterprise: params.enterprise !== false,
    });
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return { token, userAgent };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  solve,
  setupSolverPage,
  mintToken,
  parseProxy,
  proxyLabel,
  simulateHuman,
  simulateHumanLight,
  humanMouseMove,
  VIEWPORT,
};
