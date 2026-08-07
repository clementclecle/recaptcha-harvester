const { timingSafeEqual } = require("crypto");
const express = require("express");

const config = require("./config");
const { BrowserPool } = require("./pool");
const { Semaphore } = require("./semaphore");
const { solve, proxyLabel } = require("./solver");
const { classifyError } = require("./errors");
const { version: VERSION } = require("../package.json");

let exiting = false;

// Packaged binaries get double-clicked, so hold the window open when there's a
// terminal to read the error on. Under Docker or systemd there isn't one, and
// exiting non-zero lets the supervisor restart us.
function fatal(err) {
  if (exiting) return;
  exiting = true;
  console.error(`\n[fatal] ${(err && err.stack) || err}`);

  if (!process.stdin.isTTY) process.exit(1);
  console.error("\nPress any key to exit...");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(1));
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

const stats = { total: 0, success: 0, fail: 0, totalTime: 0 };
const startedAt = Date.now();

const pool = new BrowserPool(config.poolSize);
const sem = new Semaphore(config.maxConcurrent);
let farm = null;

const app = express();
app.use(express.json({ limit: "64kb" }));

app.use((req, _res, next) => {
  let suffix = "";
  if (req.method === "POST" && req.body) {
    // Never log the body as-is, it carries proxy credentials.
    const { proxy, ...rest } = req.body;
    suffix = ` ${JSON.stringify({ ...rest, ...(proxy && { proxy: proxyLabel(proxy) }) })}`;
  }
  console.log(`[http] ${req.method} ${req.url}${suffix}`);
  next();
});

function matches(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  const header = req.get("authorization") || "";
  const provided = req.get("x-api-key") || header.replace(/^Bearer\s+/i, "");
  if (!provided || !matches(provided, config.apiKey)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Body matches Capsolver's ReCaptchaV3EnterpriseTask. Omitted fields fall back
// to farm.target when one is configured.
app.post("/solve", requireApiKey, async (req, res) => {
  const body = req.body || {};
  const target = config.farm.target || {};
  const websiteURL = body.websiteURL || target.websiteURL;
  const websiteKey = body.websiteKey || target.websiteKey;
  const pageAction = body.pageAction || target.pageAction;
  const proxy = body.proxy;

  const required = { websiteURL, websiteKey, pageAction };
  const absent = Object.keys(required).filter((k) => !required[k]);
  if (absent.length) {
    return res.status(400).json({ error: `Missing required fields: ${absent.join(", ")}` });
  }

  let origin;
  try {
    origin = new URL(websiteURL).origin;
  } catch {
    return res.status(400).json({ error: `websiteURL is not a valid URL: ${websiteURL}` });
  }

  console.log(`[solve] url=${origin} proxy=${proxyLabel(proxy)}`);
  const start = Date.now();
  await sem.acquire();

  try {
    const browser = await pool.acquire();
    const result = await solve(browser, {
      websiteURL,
      websiteKey,
      pageAction,
      proxy,
      userAgent: pool.userAgent,
    });
    const solveTime = Date.now() - start;

    stats.total++;
    stats.success++;
    stats.totalTime += solveTime;

    console.log(
      `[solve] OK ${solveTime}ms token=${result.token.length}chars proxy=${proxyLabel(proxy)}`,
    );
    res.json({ token: result.token, userAgent: result.userAgent, solveTime });
  } catch (err) {
    const solveTime = Date.now() - start;
    stats.total++;
    stats.fail++;
    stats.totalTime += solveTime;

    const { code: errorCode, message: errorMessage } = classifyError(err, !!proxy);
    console.error(`[solve] FAIL ${solveTime}ms ${errorMessage} proxy=${proxyLabel(proxy)}`);
    res.status(500).json({ errorCode, errorMessage, solveTime });
  } finally {
    sem.release();
  }
});

// Farm mode only. 204 when the buffer is empty.
app.get("/token", requireApiKey, (_req, res) => {
  if (!farm) return res.status(404).json({ error: "farm mode is disabled" });
  const entry = farm.buffer.take();
  if (!entry) return res.status(204).end();
  res.json({
    token: entry.token,
    ageMs: entry.ageMs,
    remainingMs: entry.remainingMs,
  });
});

app.get("/stats", requireApiKey, (_req, res) => {
  res.json({
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
    recaptcha: {
      solveCount: stats.total,
      successCount: stats.success,
      failCount: stats.fail,
      successRate:
        stats.total > 0 ? `${((stats.success / stats.total) * 100).toFixed(1)}%` : "N/A",
      avgSolveTime: stats.total > 0 ? Math.round(stats.totalTime / stats.total) : 0,
    },
    activeSolves: sem.active,
    queuedSolves: sem.queue.length,
    poolSize: config.poolSize,
    maxConcurrent: config.maxConcurrent,
    ...(farm && { farm: farm.stats() }),
  });
});

// Left open so it works as a container healthcheck.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

async function start() {
  console.log(`[server] recaptcha-harvester v${VERSION}`);
  await pool.init();

  if (config.farm.enabled) {
    const { FarmManager } = require("./farm/manager");
    const { ProxyProvider } = require("./farm/proxyProvider");
    const { TokenBuffer } = require("./farm/buffer");

    const provider = new ProxyProvider({ proxyFile: config.farm.proxyFile });
    const buffer = new TokenBuffer({
      capacity: config.farm.bufferCapacity,
      ttlMs: config.farm.tokenTtlMs,
      mode: config.farm.bufferMode,
    });
    farm = new FarmManager({ config, buffer, provider });
    await farm.start();
  }

  app.listen(config.port, config.host, () => {
    const bits = [
      `listening on http://${config.host}:${config.port}`,
      `pool=${config.poolSize}`,
      `maxConcurrent=${config.maxConcurrent}`,
    ];
    if (config.farm.enabled) bits.push(`farm=${config.farm.mode}`);
    if (config.apiKey) bits.push("auth=on");
    console.log(`[server] ${bits.join("  ")}`);
  });
}

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[server] shutting down...");
  try {
    if (farm) await farm.stop();
    await pool.shutdown();
  } catch (err) {
    console.error(`[server] shutdown error: ${err.message}`);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch(fatal);
