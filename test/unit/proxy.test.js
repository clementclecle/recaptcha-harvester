const test = require("node:test");
const assert = require("node:assert/strict");

const { parseProxy, proxyLabel } = require("../../src/solver");

test("parseProxy handles ip:port", () => {
  assert.deepEqual(parseProxy("1.2.3.4:8080"), { server: "http://1.2.3.4:8080" });
});

test("parseProxy handles ip:port:user:pass", () => {
  assert.deepEqual(parseProxy("1.2.3.4:8080:bob:hunter2"), {
    server: "http://1.2.3.4:8080",
    username: "bob",
    password: "hunter2",
  });
});

test("parseProxy keeps colons inside the password", () => {
  assert.equal(parseProxy("1.2.3.4:8080:bob:a:b:c").password, "a:b:c");
});

test("parseProxy handles url form with credentials", () => {
  assert.deepEqual(parseProxy("http://bob:hunter2@1.2.3.4:8080"), {
    server: "http://1.2.3.4:8080",
    username: "bob",
    password: "hunter2",
  });
});

test("parseProxy percent-decodes credentials", () => {
  assert.equal(parseProxy("http://bob:p%40ss@1.2.3.4:8080").password, "p@ss");
});

test("parseProxy rejects junk", () => {
  for (const input of [null, undefined, "", "nonsense", "1.2.3.4"]) {
    assert.equal(parseProxy(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test("proxyLabel never leaks credentials", () => {
  assert.equal(proxyLabel("1.2.3.4:8080:bob:hunter2"), "1.2.3.4:8080");
  assert.equal(proxyLabel("http://bob:hunter2@1.2.3.4:8080"), "1.2.3.4:8080");
  assert.equal(proxyLabel(null), "direct");
  assert.equal(proxyLabel("nonsense"), "invalid");

  for (const input of ["1.2.3.4:8080:bob:hunter2", "http://bob:hunter2@1.2.3.4:8080"]) {
    const label = proxyLabel(input);
    assert.ok(!label.includes("hunter2"), `password leaked in ${label}`);
    assert.ok(!label.includes("bob"), `username leaked in ${label}`);
  }
});
