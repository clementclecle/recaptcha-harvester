const test = require("node:test");
const assert = require("node:assert/strict");

const { ProxyProvider, parseProxyList } = require("../../src/farm/proxyProvider");

test("parseProxyList strips comments and blank lines", () => {
  const { proxies } = parseProxyList(
    ["# a comment", "", "  ", "1.2.3.4:8080", "  5.6.7.8:9090  "].join("\n"),
  );
  assert.deepEqual(proxies, ["1.2.3.4:8080", "5.6.7.8:9090"]);
});

test("parseProxyList normalises semicolon separators", () => {
  const { proxies } = parseProxyList("1.2.3.4:8080;bob;hunter2");
  assert.deepEqual(proxies, ["1.2.3.4:8080:bob:hunter2"]);
});

test("parseProxyList leaves url-form entries alone", () => {
  const { proxies } = parseProxyList("http://bob:hunter2@1.2.3.4:8080");
  assert.deepEqual(proxies, ["http://bob:hunter2@1.2.3.4:8080"]);
});

test("parseProxyList reports duplicates and junk instead of loading them", () => {
  const result = parseProxyList(
    ["1.2.3.4:8080", "1.2.3.4:8080", "not-a-proxy", "5.6.7.8:9090"].join("\n"),
  );
  assert.deepEqual(result.proxies, ["1.2.3.4:8080", "5.6.7.8:9090"]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped, 1);
});

test("next() rotates round-robin", () => {
  const p = new ProxyProvider({ proxies: ["a:1", "b:2", "c:3"] });
  assert.deepEqual([p.next(), p.next(), p.next(), p.next()], ["a:1", "b:2", "c:3", "a:1"]);
});

test("next() returns null in direct mode", () => {
  const p = new ProxyProvider({ proxies: [] });
  assert.equal(p.count, 0);
  assert.equal(p.next(), null);
});

test("a bad proxy is skipped while it cools down", () => {
  const p = new ProxyProvider({ proxies: ["a:1", "b:2"] });
  p.markBad("a:1");

  assert.equal(p.healthyCount, 1);
  assert.deepEqual([p.next(), p.next()], ["b:2", "b:2"]);
});

test("next() returns null when every proxy is cooling down", () => {
  const p = new ProxyProvider({ proxies: ["a:1", "b:2"] });
  p.markBad("a:1");
  p.markBad("b:2");

  assert.equal(p.healthyCount, 0);
  assert.equal(p.next(), null);
  assert.equal(p.count, 2, "cooling down is not the same as being removed");
});

test("cooldown backs off exponentially and caps at five minutes", () => {
  const p = new ProxyProvider({ proxies: ["a:1"] });
  const state = p.state.get("a:1");

  const cooldownFor = (fails) => {
    state.fails = fails - 1;
    p.markBad("a:1");
    return state.cooldownUntil - Date.now();
  };

  assert.ok(cooldownFor(1) <= 5000 && cooldownFor(1) > 4000);
  assert.ok(cooldownFor(2) <= 10000 && cooldownFor(2) > 9000);
  assert.ok(cooldownFor(20) <= 300000 && cooldownFor(20) > 299000);
});

test("markGood clears the cooldown and the failure streak", () => {
  const p = new ProxyProvider({ proxies: ["a:1"] });
  p.markBad("a:1");
  p.markGood("a:1");

  assert.equal(p.healthyCount, 1);
  assert.equal(p.state.get("a:1").fails, 0);
  assert.equal(p.next(), "a:1");
});

test("marking an unknown proxy is a no-op", () => {
  const p = new ProxyProvider({ proxies: ["a:1"] });
  p.markBad("nope:1");
  p.markGood("nope:1");
  assert.equal(p.healthyCount, 1);
});
