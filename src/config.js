const fs = require("fs");
const os = require("os");
const yaml = require("js-yaml");
const { resolveConfigFile } = require("./paths");
const { CONTEXTS_PER_BROWSER } = require("./constants");

// `mode` picks one of these. Any key set explicitly in yaml still wins.
const MODE_PRESETS = {
  balanced:   { maxTokensPerWorker: 25,  maxWorkerAgeMs: 90000,  humanize: "light", mintDelayMs: 1500, maxWorkersPerProxy: 2 },
  throughput: { maxTokensPerWorker: 150, maxWorkerAgeMs: 300000, humanize: "none",  mintDelayMs: 400,  maxWorkersPerProxy: 0 },
  quality:    { maxTokensPerWorker: 5,   maxWorkerAgeMs: 45000,  humanize: "full",  mintDelayMs: 2500, maxWorkersPerProxy: 1 },
};

function parseYaml(raw, file) {
  try {
    return yaml.load(raw) || {};
  } catch (err) {
    // "C:\Program Files\..." breaks a double-quoted scalar since \ is an escape.
    // Retry with forward slashes, which Chrome takes on Windows anyway.
    try {
      return yaml.load(raw.replace(/\\/g, "/")) || {};
    } catch {
      throw new Error(`Could not parse ${file}: ${err.message}`);
    }
  }
}

function loadFile() {
  // config.yaml wins; falling back to the example means a fresh clone runs
  // without a setup step.
  const file =
    resolveConfigFile("config.yaml") || resolveConfigFile("config.example.yaml");
  if (!file) return {};
  return parseYaml(fs.readFileSync(file, "utf8"), file);
}

const toNumber = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const toBool = (v) => {
  if (v === undefined || v === "") return undefined;
  return !/^(0|false|no|off)$/i.test(String(v));
};

const config = loadFile();

// Env overrides, mainly for Docker.
const overrides = {
  port: toNumber(process.env.PORT),
  host: process.env.HOST,
  apiKey: process.env.API_KEY,
  maxConcurrent: toNumber(process.env.MAX_CONCURRENT),
  poolSize: toNumber(process.env.POOL_SIZE),
  chromePath: process.env.CHROME_PATH,
  headless: toBool(process.env.HEADLESS),
};
for (const [key, value] of Object.entries(overrides)) {
  if (value !== undefined && value !== "") config[key] = value;
}

config.port = config.port || 3131;
// Loopback unless told otherwise. An exposed solver lets anyone on the network
// burn your proxies.
config.host = config.host || "127.0.0.1";
config.headless = config.headless !== false;

// One knob. Left alone it tracks core count, since a solve is roughly a busy
// core while it runs. poolSize follows unless pinned.
config.maxConcurrent = Math.max(1, Math.floor(config.maxConcurrent || os.cpus().length));
config.poolSize = Math.max(
  1,
  Math.floor(config.poolSize || Math.ceil(config.maxConcurrent / CONTEXTS_PER_BROWSER)),
);

const farm = (config.farm = config.farm || {});
if (process.env.FARM_ENABLED !== undefined) farm.enabled = toBool(process.env.FARM_ENABLED);
if (process.env.FARM_MODE) farm.mode = process.env.FARM_MODE;
farm.enabled = farm.enabled === true;

if (farm.enabled) {
  farm.target = farm.target || {};

  const missing = ["websiteURL", "websiteKey", "pageAction"].filter(
    (k) => !farm.target[k],
  );
  if (missing.length) {
    throw new Error(
      `farm.enabled is true but farm.target is missing: ${missing.join(", ")}`,
    );
  }
  try {
    new URL(farm.target.websiteURL);
  } catch {
    throw new Error(`farm.target.websiteURL is not a valid URL: ${farm.target.websiteURL}`);
  }

  if (!MODE_PRESETS[farm.mode]) {
    if (farm.mode) {
      console.warn(
        `[config] unknown farm.mode "${farm.mode}", falling back to balanced ` +
          `(valid: ${Object.keys(MODE_PRESETS).join(", ")})`,
      );
    }
    farm.mode = "balanced";
  }
  for (const [key, value] of Object.entries(MODE_PRESETS[farm.mode])) {
    if (farm[key] === undefined) farm[key] = value;
  }

  farm.proxyFile = farm.proxyFile || "proxies.txt";

  // CPU drives scaling; it reads accurately everywhere. Memory is capped from
  // TOTAL ram (estPerWorkerRamMB / ramUsableFraction) rather than os.freemem(),
  // which hides reclaimable cache on Linux and means nothing on macOS.
  farm.minWorkers = farm.minWorkers ?? 1;
  farm.maxWorkers = farm.maxWorkers ?? 128;
  farm.intervalMs = farm.intervalMs ?? 5000;
  farm.estPerWorkerRamMB = farm.estPerWorkerRamMB ?? 150;
  farm.ramUsableFraction = farm.ramUsableFraction ?? 0.7;
  farm.cpuLow = farm.cpuLow ?? 0.7;
  farm.cpuHigh = farm.cpuHigh ?? 0.88;
  farm.ramLow = farm.ramLow ?? 0.75;
  farm.ramHigh = farm.ramHigh ?? 0.9;
  farm.stepUp = farm.stepUp ?? 1;
  farm.stepDown = farm.stepDown ?? 3;
  farm.upTicksRequired = farm.upTicksRequired ?? 2;
  farm.cooldownUpMs = farm.cooldownUpMs ?? 12000;

  farm.minWorkers = Math.max(1, Math.floor(farm.minWorkers));
  farm.maxWorkers = Math.max(farm.minWorkers, Math.floor(farm.maxWorkers));

  farm.tokenTtlMs = farm.tokenTtlMs ?? 110000;
  farm.bufferCapacity = farm.bufferCapacity ?? 500;
  farm.bufferMode = farm.bufferMode || "block";
  if (farm.bufferMode !== "block" && farm.bufferMode !== "drop") {
    console.warn(`[config] unknown farm.bufferMode "${farm.bufferMode}", using block`);
    farm.bufferMode = "block";
  }
}

module.exports = config;
