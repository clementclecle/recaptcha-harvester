// Shared by the /solve handler (to shape the response) and farm workers (to
// decide whether the proxy is what broke).

const ERROR_CODES = {
  UNKNOWN: 0,
  PROXY: 1,
  TIMEOUT: 2,
  DNS: 3,
  RECAPTCHA_LOAD: 4,
  EMPTY_TOKEN: 5,
};

const ERROR_MESSAGES = {
  [ERROR_CODES.UNKNOWN]: "unknown error",
  [ERROR_CODES.PROXY]: "proxy error",
  [ERROR_CODES.TIMEOUT]: "timeout",
  [ERROR_CODES.DNS]: "dns error",
  [ERROR_CODES.RECAPTCHA_LOAD]: "recaptcha load failed",
  [ERROR_CODES.EMPTY_TOKEN]: "empty token",
};

// hasProxy tips the ambiguous cases: a timeout or a dead enterprise.js fetch
// through a proxy is nearly always the proxy.
function classifyError(err, hasProxy) {
  const msg = (err && err.message) || "";
  const { UNKNOWN, PROXY, TIMEOUT, DNS, RECAPTCHA_LOAD, EMPTY_TOKEN } = ERROR_CODES;

  let code = UNKNOWN;
  if (
    msg.includes("ERR_PROXY_CONNECTION_FAILED") ||
    msg.includes("ERR_PROXY_AUTH") ||
    msg.includes("Malformed proxy")
  ) {
    code = PROXY;
  } else if (msg.includes("ERR_CONNECTION_TIMED_OUT") || msg.includes("Timeout")) {
    code = hasProxy ? PROXY : TIMEOUT;
  } else if (msg.includes("ERR_NAME_NOT_RESOLVED")) {
    code = DNS;
  } else if (msg.includes("enterprise.js")) {
    code = hasProxy ? PROXY : RECAPTCHA_LOAD;
  } else if (msg.includes("Empty token")) {
    code = EMPTY_TOKEN;
  }

  return { code, message: ERROR_MESSAGES[code] };
}

module.exports = { classifyError, ERROR_CODES, ERROR_MESSAGES };
