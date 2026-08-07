// Tokens are single use and expire in ~2 min, which drives everything here:
// take() serves the newest (most TTL left, the old ones were dying anyway),
// expiry is lazy so there's no timer, and a full buffer either blocks the
// worker or drops the oldest.
class TokenBuffer {
  constructor({ capacity = 500, ttlMs = 110000, mode = "block" } = {}) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.mode = mode;
    this.items = []; // oldest first
    this.produced = 0;
    this.served = 0;
    this.expired = 0;
    this.dropped = 0;
  }

  evictExpired() {
    const cutoff = Date.now() - this.ttlMs;
    while (this.items.length && this.items[0].mintedAt <= cutoff) {
      this.items.shift();
      this.expired++;
    }
  }

  isFull() {
    this.evictExpired();
    return this.items.length >= this.capacity;
  }

  // False means block mode refused it. Blocking is the default: minting into a
  // full buffer burns CPU and proxy reputation for nothing.
  push(token, meta = {}) {
    this.evictExpired();
    if (this.items.length >= this.capacity) {
      if (this.mode !== "drop") return false;
      this.items.shift();
      this.dropped++;
    }
    this.items.push({ token, mintedAt: meta.mintedAt || Date.now(), meta });
    this.produced++;
    return true;
  }

  take() {
    this.evictExpired();
    const item = this.items.pop();
    if (!item) return null;
    this.served++;

    const now = Date.now();
    return {
      token: item.token,
      ageMs: now - item.mintedAt,
      remainingMs: Math.max(0, item.mintedAt + this.ttlMs - now),
      meta: item.meta,
    };
  }

  get depth() {
    this.evictExpired();
    return this.items.length;
  }

  stats() {
    this.evictExpired();
    return {
      depth: this.items.length,
      capacity: this.capacity,
      produced: this.produced,
      served: this.served,
      expired: this.expired,
      dropped: this.dropped,
    };
  }
}

module.exports = { TokenBuffer };
