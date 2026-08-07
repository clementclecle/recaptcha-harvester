const fs = require("fs");
const { resolveConfigFile } = require("../paths");
const { parseProxy, proxyLabel } = require("../solver");

const MAX_COOLDOWN_MS = 5 * 60000;
const BASE_COOLDOWN_MS = 5000;
const RETIRE_AFTER_FAILS = 3;

// Drops comments, blanks, duplicates and anything that isn't a proxy.
function parseProxyList(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    // ip:port;user;pass shows up a lot in vendor exports. URLs keep their own.
    .map((l) => (l.includes("@") ? l : l.replace(/;/g, ":")));

  const seen = new Set();
  let skipped = 0;
  const proxies = lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    if (parseProxy(line)) return true;
    skipped++;
    return false;
  });

  return { proxies, skipped, duplicates: lines.length - seen.size };
}

// Round-robins proxies to farm workers and skips ones that are cooling down.
// The per-proxy worker cap lives in the manager, not here.
class ProxyProvider {
  constructor({ proxyFile = "proxies.txt", proxies } = {}) {
    this.proxyFile = proxyFile;
    this.proxies = [];
    this.state = new Map();
    this._robin = 0;
    if (proxies) this._adopt(proxies);
  }

  _adopt(proxies) {
    this.proxies = proxies;
    for (const proxy of proxies) {
      if (!this.state.has(proxy)) this.state.set(proxy, { fails: 0, cooldownUntil: 0 });
    }
    return proxies.length;
  }

  load() {
    const file = resolveConfigFile(this.proxyFile);
    if (!file) {
      this.proxies = [];
      return 0;
    }

    const { proxies, skipped, duplicates } = parseProxyList(fs.readFileSync(file, "utf8"));
    if (skipped) console.warn(`[proxies] skipped ${skipped} unparseable line(s) in ${file}`);
    if (duplicates) console.warn(`[proxies] skipped ${duplicates} duplicate line(s)`);

    return this._adopt(proxies);
  }

  get count() {
    return this.proxies.length;
  }

  get healthyCount() {
    const now = Date.now();
    return this.proxies.filter((p) => this.state.get(p).cooldownUntil <= now).length;
  }

  // null means direct mode or everything is cooling down. Callers check count
  // to tell those apart.
  next() {
    const n = this.proxies.length;
    if (n === 0) return null;

    const now = Date.now();
    for (let i = 0; i < n; i++) {
      const proxy = this.proxies[this._robin];
      this._robin = (this._robin + 1) % n;
      if (this.state.get(proxy).cooldownUntil <= now) return proxy;
    }
    return null;
  }

  markBad(proxy) {
    const state = proxy && this.state.get(proxy);
    if (!state) return;
    state.fails++;
    const backoff = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (state.fails - 1));
    state.cooldownUntil = Date.now() + backoff;

    // One-off failures are normal and a big list would flood the log, so only
    // say something once a proxy looks properly dead.
    if (state.fails === RETIRE_AFTER_FAILS) {
      console.warn(
        `[proxies] ${proxyLabel(proxy)} failing repeatedly, backing off up to ` +
          `${Math.round(MAX_COOLDOWN_MS / 60000)}m`,
      );
    }
  }

  markGood(proxy) {
    const state = proxy && this.state.get(proxy);
    if (!state) return;
    state.fails = 0;
    state.cooldownUntil = 0;
  }
}

module.exports = { ProxyProvider, parseProxyList };
