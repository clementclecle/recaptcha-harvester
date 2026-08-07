const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyError, ERROR_CODES } = require("../../src/errors");

const err = (message) => new Error(message);

test("proxy transport failures are classified as proxy errors", () => {
  assert.equal(classifyError(err("net::ERR_PROXY_CONNECTION_FAILED"), true).code, ERROR_CODES.PROXY);
  assert.equal(classifyError(err("net::ERR_PROXY_AUTH_REQUESTED"), true).code, ERROR_CODES.PROXY);
  assert.equal(classifyError(err("Malformed proxy: 1.2.3.4"), true).code, ERROR_CODES.PROXY);
});

test("a timeout blames the proxy only when one is in use", () => {
  const message = "Timeout 15000ms exceeded";
  assert.equal(classifyError(err(message), true).code, ERROR_CODES.PROXY);
  assert.equal(classifyError(err(message), false).code, ERROR_CODES.TIMEOUT);
});

test("a failed enterprise.js load blames the proxy only when one is in use", () => {
  const message = "Failed to load enterprise.js";
  assert.equal(classifyError(err(message), true).code, ERROR_CODES.PROXY);
  assert.equal(classifyError(err(message), false).code, ERROR_CODES.RECAPTCHA_LOAD);
});

test("dns and empty-token failures are classified independently of the proxy", () => {
  assert.equal(classifyError(err("net::ERR_NAME_NOT_RESOLVED"), true).code, ERROR_CODES.DNS);
  assert.equal(classifyError(err("Empty token received"), true).code, ERROR_CODES.EMPTY_TOKEN);
});

test("anything unrecognised falls back to unknown", () => {
  assert.deepEqual(classifyError(err("something odd"), false), {
    code: ERROR_CODES.UNKNOWN,
    message: "unknown error",
  });
  assert.equal(classifyError(undefined, false).code, ERROR_CODES.UNKNOWN);
});

test("every code carries a message", () => {
  for (const code of Object.values(ERROR_CODES)) {
    const { message } = classifyError(err("x"), false);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0, `code ${code} has no message`);
  }
});
