// Solve on one of 2captcha's demo pages, then post the token to their verify
// endpoint and print the score Google gave it.
//
// A token that parses isn't the same as a token that passes, so this is the one
// that tells you whether the stealth setup actually works.
//
// Usage: node test/test-score.js [proxy]
//        ENTERPRISE=false node test/test-score.js   # plain reCAPTCHA v3
const { launchBrowser, detectUserAgent } = require("../src/pool");
const { solve, proxyLabel } = require("../src/solver");
const config = require("../src/config");

const ENTERPRISE = process.env.ENTERPRISE !== "false";

// Site keys are the ones the live demo widgets actually use. Note that the code
// samples printed on those pages are stale and show different keys, and that
// the two verify endpoints disagree on what to call the token field.
const TARGETS = {
  enterprise: {
    websiteURL: "https://2captcha.com/demo/recaptcha-v3-enterprise",
    websiteKey: "6Lel38UnAAAAAMRwKj9qLH2Ws4Tf2uTDQCyfgR6b",
    pageAction: "demo_action",
    verifyURL: "https://2captcha.com/api/v1/captcha-demo/recaptcha-enterprise/verify",
    tokenField: "token",
  },
  v3: {
    websiteURL: "https://2captcha.com/demo/recaptcha-v3",
    websiteKey: "6Lcyqq8oAAAAAJE7eVJ3aZp_hnJcI6LgGdYD8lge",
    pageAction: "demo_action",
    verifyURL: "https://2captcha.com/api/v1/captcha-demo/recaptcha/verify",
    tokenField: "answer",
  },
};

const target = TARGETS[ENTERPRISE ? "enterprise" : "v3"];

async function verifyToken(token) {
  const res = await fetch(target.verifyURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: target.websiteKey, [target.tokenField]: token }),
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
    console.log(
      `Solving ${ENTERPRISE ? "enterprise" : "v3"} via ${proxyLabel(proxy)}...`,
    );
    const start = Date.now();

    const result = await solve(browser, {
      websiteURL: target.websiteURL,
      websiteKey: target.websiteKey,
      pageAction: target.pageAction,
      enterprise: ENTERPRISE,
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
