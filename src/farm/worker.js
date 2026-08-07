const { setupSolverPage, mintToken, proxyLabel } = require("../solver");
const { classifyError, ERROR_CODES } = require("../errors");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

const MAX_CONSECUTIVE_FAILS = 5;

// One warm context+page on one proxy, minting in a loop.
//
// Recycles after maxTokensPerWorker, after maxWorkerAgeMs, or on any error.
// That's not only about IPs (a context is stuck with its proxy for life) but
// about scores: v3 marks a session down the more it calls execute().
class FarmWorker {
  constructor({ id, browser, browserSlot, manager }) {
    this.id = id;
    this.browser = browser;
    this.browserSlot = browserSlot;
    this.manager = manager;

    this.cfg = manager.config.farm;
    this.target = this.cfg.target;
    this.buffer = manager.buffer;
    this.provider = manager.provider;
    this.userAgent = manager.userAgent;

    this.proxy = null;
    this.context = null;
    this.page = null;
    this.tokens = 0; // since last setup
    this.totalTokens = 0;
    this.startedAt = 0;
    this.fails = 0;
    this.stopped = false;
  }

  // Fire and forget. Must never reject: unhandled rejections kill the process.
  start() {
    this._run().catch((err) => {
      console.error(`[farm] worker ${this.id} crashed: ${err.message}`);
      this.manager.onWorkerExit(this);
    });
  }

  async stop() {
    this.stopped = true;
    await this._teardown();
  }

  shouldRecycle() {
    return (
      this.tokens >= this.cfg.maxTokensPerWorker ||
      Date.now() - this.startedAt >= this.cfg.maxWorkerAgeMs
    );
  }

  async _acquireProxy() {
    if (this.provider.count === 0) return null; // direct
    while (!this.stopped) {
      const proxy = this.provider.next();
      if (proxy) return proxy;
      await sleep(2000); // everything is cooling down, wait it out
    }
    return null;
  }

  async _setup() {
    this.proxy = await this._acquireProxy();
    if (this.stopped) return;

    const { context, page } = await setupSolverPage(this.browser, {
      websiteURL: this.target.websiteURL,
      websiteKey: this.target.websiteKey,
      enterprise: this.target.enterprise,
      proxy: this.proxy,
      userAgent: this.userAgent,
    });
    this.context = context;
    this.page = page;
    this.tokens = 0;
    this.startedAt = Date.now();
  }

  async _teardown() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  _noteFailure(err, phase) {
    this.fails++;
    const { code, message } = classifyError(err, !!this.proxy);
    if (this.proxy && code === ERROR_CODES.PROXY) this.provider.markBad(this.proxy);
    if (!this.stopped) {
      console.warn(
        `[farm] worker=${this.id} ${phase} failed: ${message} proxy=${proxyLabel(this.proxy)}`,
      );
    }
  }

  // Give up rather than recycle again.
  _isFatal() {
    return !this.browser.isConnected() || this.fails >= MAX_CONSECUTIVE_FAILS;
  }

  async _run() {
    while (!this.stopped) {
      try {
        await this._setup();
      } catch (err) {
        this._noteFailure(err, "setup");
        await this._teardown();
        if (this.stopped) break;
        if (this._isFatal()) return this.manager.onWorkerExit(this);
        await sleep(jitter(3000));
        continue;
      }
      if (this.stopped) break;

      while (!this.stopped && !this.shouldRecycle()) {
        if (this.buffer.mode === "block" && this.buffer.isFull()) {
          await sleep(500);
          continue;
        }

        try {
          const token = await mintToken(this.page, {
            websiteKey: this.target.websiteKey,
            pageAction: this.target.pageAction,
            enterprise: this.target.enterprise,
            humanize: this.cfg.humanize,
          });

          this.tokens++;
          this.totalTokens++;
          this.fails = 0;
          if (this.proxy) this.provider.markGood(this.proxy);

          // The buffer can fill between isFull() and here. The token is spent
          // either way, so drop it and back off rather than counting it.
          if (!this.buffer.push(token, { workerId: this.id, mintedAt: Date.now() })) {
            await sleep(500);
            continue;
          }

          this.manager.recordToken();
          console.log(
            `[farm] token #${this.manager.totalTokens} worker=${this.id} ` +
              `${token.length}chars ${this.manager.tokensPerMin}/min ` +
              `buf=${this.buffer.depth} proxy=${proxyLabel(this.proxy)}`,
          );
          await sleep(jitter(this.cfg.mintDelayMs));
        } catch (err) {
          this._noteFailure(err, "mint");
          break; // recycle with a fresh context and proxy
        }
      }

      await this._teardown();
      if (this.stopped) break;
      if (this._isFatal()) return this.manager.onWorkerExit(this);
    }
    await this._teardown();
  }
}

module.exports = { FarmWorker };
