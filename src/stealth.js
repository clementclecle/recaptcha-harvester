// Injected into every context before page JS runs. Runs on top of the launch
// flags and puppeteer-extra-plugin-stealth (see pool.js).
//
// Only patch what headless actually gets wrong. Every property redefined here
// is itself something to detect, so a missing patch usually beats a sloppy one.
const STEALTH_SCRIPT = `
(() => {
  // Set by Chromium when driven over CDP. The AutomationControlled launch flag
  // covers this already; keep the JS patch for builds that ignore it.
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    if (desc && desc.configurable) {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: false,
        enumerable: true,
      });
    }
  } catch {}

  // Headless ships window.chrome incomplete and the gaps are trivial to probe.
  if (!window.chrome) window.chrome = {};

  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: () => ({
        onMessage: { addListener() {} },
        postMessage() {},
        disconnect() {},
      }),
      sendMessage() {},
      onConnect: { addListener() {}, removeListener() {} },
      onMessage: { addListener() {}, removeListener() {} },
    };
  }
  if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});
  if (!window.chrome.csi) window.chrome.csi = () => ({});
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false,
    };
  }

  // Only fires on older builds. Current headless populates plugins properly.
  if (navigator.plugins.length === 0) {
    const mock = Object.create(PluginArray.prototype);
    Object.defineProperty(mock, 'length', { get: () => 3 });
    mock.item = () => null;
    mock.namedItem = () => null;
    mock.refresh = () => {};
    Object.defineProperty(navigator, 'plugins', { get: () => mock });
  }

  // Match the context locale so the two can't disagree.
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // xr-spatial-tracking is the one that matters: some headless builds reject the
  // query instead of answering it.
  //
  // The notifications branch is a fallback and is NOT what runs today. The
  // stealth plugin wraps this function and answers that name itself, keeping it
  // in step with Notification.permission. Query it from a real page before
  // assuming a change here does anything.
  const query = Permissions.prototype.query;
  Permissions.prototype.query = function (desc) {
    if (desc.name === 'notifications' || desc.name === 'xr-spatial-tracking') {
      return Promise.resolve({ state: 'prompt', onchange: null });
    }
    return query.call(this, desc);
  };
})();
`;

module.exports = { STEALTH_SCRIPT };
