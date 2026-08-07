# Contributing

Bug reports and pull requests are welcome.

## Getting set up

```bash
npm install
npm run setup     # downloads Chromium for Playwright
npm test          # unit tests, no network needed
```

`npm test` must pass before you open a PR. It runs on Node's built-in test runner, so there
is no test framework to install.

For anything touching the solve path, also run:

```bash
npm run test:score
```

That solves a real captcha on 2captcha's demo page and prints the score Google assigned.
Include the before and after numbers in your PR. A change to stealth, mouse movement or
recycling behaviour can't be reviewed without them.

## What's most useful

- Detection vectors that headless Chromium gets wrong and `stealth.js` doesn't cover
- Support for other reCAPTCHA variants (v2, invisible)
- Anything that measurably raises scores, with the numbers to back it

## Conventions

Plain CommonJS, no build step, no linter config. Match the surrounding style rather than
reformatting.

A few things that are deliberate, and worth knowing before changing them:

- **Comments explain why, not what.** If a comment restates the line below it, drop it. The
  ones worth writing are the non-obvious constraints: why `os.freemem()` is ignored on
  macOS, why the token buffer serves newest-first, why a context has to be rebuilt to
  rotate an IP.
- **Proxy credentials never reach a log.** Everything that prints a proxy goes through
  `proxyLabel()`. If you add a log line with a proxy in it, use that.
- **Only patch what headless actually gets wrong.** Every redefined property in
  `stealth.js` is itself a potential tell. A patch that does nothing is worse than no
  patch, because it still leaves a trace.
- **Config keys get a default in `config.js`** and a commented entry in
  `config.example.yaml`. Anything documented as configurable has to be genuinely wired up.

`docs/ARCHITECTURE.md` covers how the pieces fit together.

## Pull requests

Keep them focused, one change per PR. Say what you tested and on what: scores vary
enormously by proxy type and host, so "works for me" needs the context to mean anything.
