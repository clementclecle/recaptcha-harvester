const os = require("os");
const { launchBrowser, detectUserAgent } = require("../pool");
const { CONTEXTS_PER_BROWSER } = require("../constants");
const { FarmWorker } = require("./worker");
const { Autoscaler } = require("./autoscaler");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function timeout(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// Owns the farm's browsers and workers. The autoscaler moves `target`, this
// reconciles toward it. Worker/browser counts are tracked exactly so browsers
// can come and go while workers are attached.
class FarmManager {
  constructor({ config, buffer, provider }) {
    this.config = config;
    this.buffer = buffer;
    this.provider = provider;

    this.workers = [];
    this.browsers = []; // { browser, workers }
    this.target = 0;
    this.userAgent = undefined;
    this.totalTokens = 0;
    this.autoscaler = null;

    this._nextId = 1;
    this._reconciling = false;
    this._reconcileAgain = false;
    this._tokenTimes = []; // rolling 60s
  }

  async start() {
    const proxyCount = this.provider.load();

    const first = await launchBrowser(this.config);
    this.userAgent = await detectUserAgent(first);
    this.browsers.push({ browser: first, workers: 0 });

    this.target = clamp(
      this.config.maxConcurrent,
      this.config.farm.minWorkers,
      this.maxWorkers(),
    );

    console.log(
      `[farm] mode=${this.config.farm.mode} target=${this.target} ` +
        `maxWorkers=${this.maxWorkers()} proxies=${proxyCount || "none (direct)"}`,
    );
    console.log(`[farm] UA: ${this.userAgent}`);

    await this._reconcile();

    this.autoscaler = new Autoscaler(this);
    this.autoscaler.start();
  }

  // Ceiling from total RAM (reliable everywhere, unlike os.freemem) and, if a
  // per-proxy cap is set, the proxy supply. This is what sizes the farm to the
  // host it's on.
  maxWorkers() {
    const f = this.config.farm;
    const ramCap = Math.floor(
      (os.totalmem() * f.ramUsableFraction) / (f.estPerWorkerRamMB * 1024 * 1024),
    );
    let max = Math.min(f.maxWorkers, Math.max(1, ramCap));
    if (f.maxWorkersPerProxy > 0 && this.provider.count > 0) {
      max = Math.min(max, this.provider.count * f.maxWorkersPerProxy);
    }
    return Math.max(f.minWorkers, max);
  }

  setTarget(n) {
    const t = clamp(n, this.config.farm.minWorkers, this.maxWorkers());
    if (t !== this.target) {
      this.target = t;
      this._scheduleReconcile();
    }
  }

  nudge() {
    if (this.workers.length !== this.target) this._scheduleReconcile();
  }

  _scheduleReconcile() {
    this._reconcile().catch((err) =>
      console.error(`[farm] reconcile error: ${err.message}`),
    );
  }

  async _reconcile() {
    if (this._reconciling) {
      this._reconcileAgain = true;
      return;
    }
    this._reconciling = true;
    try {
      // Reads this.target live, so a change mid-pass is picked up. A grow that
      // can't be placed ends the pass and nudge() retries later.
      while (this.workers.length < this.target) {
        if (!(await this._grow())) break;
      }
      while (this.workers.length > this.target) {
        await this._shrink();
      }
    } finally {
      this._reconciling = false;
      if (this._reconcileAgain) {
        this._reconcileAgain = false;
        this._scheduleReconcile();
      }
    }
  }

  async _grow() {
    if (this.provider.count > 0 && this.provider.healthyCount === 0) return false;

    let slot = this.browsers.find(
      (b) => b.browser.isConnected() && b.workers < CONTEXTS_PER_BROWSER,
    );
    if (!slot) {
      try {
        slot = { browser: await launchBrowser(this.config), workers: 0 };
      } catch (err) {
        console.error(`[farm] browser launch failed: ${err.message}`);
        return false;
      }
      this.browsers.push(slot);
    }

    const worker = new FarmWorker({
      id: this._nextId++,
      browser: slot.browser,
      browserSlot: slot,
      manager: this,
    });
    slot.workers++;
    this.workers.push(worker);
    worker.start();
    return true;
  }

  async _shrink() {
    const worker = this.workers.pop(); // newest first
    if (!worker) return;
    this._releaseSlot(worker);
    await worker.stop();
    this._maybeCloseBrowser(worker.browserSlot);
  }

  onWorkerExit(worker) {
    const i = this.workers.indexOf(worker);
    if (i === -1) return; // _shrink already took it
    this.workers.splice(i, 1);
    this._releaseSlot(worker);
    this._maybeCloseBrowser(worker.browserSlot);
    this._scheduleReconcile();
  }

  _releaseSlot(worker) {
    if (worker.browserSlot) {
      worker.browserSlot.workers = Math.max(0, worker.browserSlot.workers - 1);
    }
  }

  _maybeCloseBrowser(slot) {
    if (!slot || slot.workers > 0) return;
    const needed = Math.ceil(this.target / CONTEXTS_PER_BROWSER);
    if (this.browsers.length > needed || !slot.browser.isConnected()) {
      const i = this.browsers.indexOf(slot);
      if (i !== -1) this.browsers.splice(i, 1);
      slot.browser.close().catch(() => {});
    }
  }

  recordToken() {
    this.totalTokens++;
    const now = Date.now();
    this._tokenTimes.push(now);
    this._trim(now);
  }

  _trim(now) {
    const cutoff = now - 60000;
    while (this._tokenTimes.length && this._tokenTimes[0] < cutoff) {
      this._tokenTimes.shift();
    }
  }

  get tokensPerMin() {
    this._trim(Date.now());
    return this._tokenTimes.length;
  }

  stats() {
    return {
      mode: this.config.farm.mode,
      workers: this.workers.length,
      targetWorkers: this.target,
      maxWorkers: this.maxWorkers(),
      browsers: this.browsers.length,
      tokensPerMin: this.tokensPerMin,
      totalTokens: this.totalTokens,
      buffer: this.buffer.stats(),
      cpu: this.autoscaler ? `${Math.round(this.autoscaler.cpu * 100)}%` : "n/a",
      ram: `${Math.round((1 - os.freemem() / os.totalmem()) * 100)}%`,
      proxies: { total: this.provider.count, healthy: this.provider.healthyCount },
    };
  }

  async stop() {
    if (this.autoscaler) this.autoscaler.stop();
    const workers = this.workers.slice();
    this.workers = [];
    // Bounded drain so a hung context can't block shutdown.
    await Promise.race([Promise.allSettled(workers.map((w) => w.stop())), timeout(10000)]);

    const browsers = this.browsers;
    this.browsers = [];
    await Promise.allSettled(browsers.map((b) => b.browser.close()));
  }
}

module.exports = { FarmManager };
