// Solve one token without starting the server. Quickest check that a machine
// can produce tokens at all.
//
// Usage: node test/test-solve.js [proxy]
// Target can be overridden with WEBSITE_URL / WEBSITE_KEY / PAGE_ACTION.
// Set ENTERPRISE=false for a plain reCAPTCHA v3 site key.
const { launchBrowser, detectUserAgent } = require("../src/pool");
const { solve, proxyLabel } = require("../src/solver");
const config = require("../src/config");

// 2captcha's public v3-enterprise demo, which exists to be tested against.
const WEBSITE_URL =
  process.env.WEBSITE_URL || "https://2captcha.com/demo/recaptcha-v3-enterprise";
const WEBSITE_KEY = process.env.WEBSITE_KEY || "6Lel38UnAAAAAMRwKj9qLH2Ws4Tf2uTDQCyfgR6b";
const PAGE_ACTION = process.env.PAGE_ACTION || "demo_action";
const ENTERPRISE = process.env.ENTERPRISE !== "false";

async function main() {
  const proxy = process.argv[2] || undefined;

  console.log("Launching browser...");
  const browser = await launchBrowser(config);

  try {
    const userAgent = await detectUserAgent(browser);
    console.log(
      `Solving ${new URL(WEBSITE_URL).origin} ` +
        `(${ENTERPRISE ? "enterprise" : "v3"}) via ${proxyLabel(proxy)}...`,
    );
    const start = Date.now();

    const result = await solve(browser, {
      websiteURL: WEBSITE_URL,
      websiteKey: WEBSITE_KEY,
      pageAction: PAGE_ACTION,
      enterprise: ENTERPRISE,
      proxy,
      userAgent,
    });

    console.log(`\nToken (${result.token.length} chars): ${result.token.slice(0, 60)}...`);
    console.log(`UA: ${result.userAgent}`);
    console.log(`Solved in ${Date.now() - start}ms`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`Solve failed: ${err.message}`);
  process.exit(1);
});
