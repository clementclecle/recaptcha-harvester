const test = require("node:test");
const assert = require("node:assert/strict");

const { TokenBuffer } = require("../../src/farm/buffer");

test("take() serves the freshest token", () => {
  const buf = new TokenBuffer({ capacity: 10 });
  buf.push("old");
  buf.push("new");
  assert.equal(buf.take().token, "new");
  assert.equal(buf.take().token, "old");
  assert.equal(buf.take(), null);
});

test("expired tokens are evicted, never served", () => {
  const buf = new TokenBuffer({ ttlMs: 1000 });
  buf.push("stale", { mintedAt: Date.now() - 5000 });
  buf.push("fresh");

  assert.equal(buf.depth, 1);
  assert.equal(buf.take().token, "fresh");
  assert.equal(buf.stats().expired, 1);
});

test("take() reports age and remaining ttl", () => {
  const buf = new TokenBuffer({ ttlMs: 10000 });
  buf.push("t", { mintedAt: Date.now() - 2000 });

  const entry = buf.take();
  assert.ok(entry.ageMs >= 2000, `ageMs was ${entry.ageMs}`);
  assert.ok(entry.remainingMs <= 8000 && entry.remainingMs > 7000);
});

test("block mode refuses pushes when full", () => {
  const buf = new TokenBuffer({ capacity: 2, mode: "block" });
  assert.equal(buf.push("a"), true);
  assert.equal(buf.push("b"), true);
  assert.equal(buf.push("c"), false);
  assert.equal(buf.depth, 2);
  assert.equal(buf.stats().dropped, 0);
});

test("drop mode evicts the oldest to stay fresh", () => {
  const buf = new TokenBuffer({ capacity: 2, mode: "drop" });
  buf.push("a");
  buf.push("b");
  assert.equal(buf.push("c"), true);

  assert.equal(buf.depth, 2);
  assert.equal(buf.stats().dropped, 1);
  assert.equal(buf.take().token, "c");
  assert.equal(buf.take().token, "b");
});

test("stats track the token lifecycle", () => {
  const buf = new TokenBuffer({ capacity: 5 });
  buf.push("a");
  buf.push("b");
  buf.take();

  const stats = buf.stats();
  assert.equal(stats.produced, 2);
  assert.equal(stats.served, 1);
  assert.equal(stats.depth, 1);
  assert.equal(stats.capacity, 5);
});
