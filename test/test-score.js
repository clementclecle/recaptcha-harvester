// Solve on 2captcha's v3-enterprise demo, then post the token to their verify
// endpoint and print the score Google gave it.
//
// A token that parses isn't the same as a token that passes, so this is the one
// that tells you whether the stealth setup actually works.
//
// Usage: node test/test-score.js [proxy]
const { launchBrowser, detectUserAgent } = require("../src/pool");
const { solve, proxyLabel } = require("../src/solver");
const config = require("../src/config");

const WEBSITE_URL = "https://2captcha.com/demo/recaptcha-v3-enterprise";
const WEBSITE_KEY = "6Lel38UnAAAAAMRwKj9qLH2Ws4Tf2uTDQCyfgR6b";
const PAGE_ACTION = "demo_action";
const VERIFY_URL =
  "https://2captcha.com/api/v1/captcha-demo/recaptcha-enterprise/verify";

async function verifyToken(token) {
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: WEBSITE_KEY, token }),
  });
  if (!res.ok) throw new Error(`verify endpoint returned ${res.status}`);
  return res.json();
}

async function main() {
  const proxy = process.argv[2] || undefined;

  console.log("Launching browser...");
  const browser = await launchBrowser(config);

  try {
    const userAgent = await detectUserAgent(browser);
    console.log(`Solving via ${proxyLabel(proxy)}...`);
    const start = Date.now();

    const result = await solve(browser, {
      websiteURL: WEBSITE_URL,
      websiteKey: WEBSITE_KEY,
      pageAction: PAGE_ACTION,
      proxy,
      userAgent,
    });

    console.log(`Token (${result.token.length} chars) in ${Date.now() - start}ms`);
    console.log(`UA: ${result.userAgent}\n`);

    console.log("Verifying...");
    console.log(JSON.stringify(await verifyToken(result.token), null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
