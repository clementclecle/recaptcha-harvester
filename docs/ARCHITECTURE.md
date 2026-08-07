# Architecture

## The idea

Most captcha solvers lose to fingerprinting because they emulate a browser. This one runs
a browser. Canvas, WebGL, audio, fonts, timing: everything Google's v3 model looks at is
produced by real Chromium, so none of it has to be faked or kept in sync as detection
evolves.

That leaves three problems worth solving, and the code is organised around them:

1. **Automation markers.** CDP-driven Chromium leaks a handful of tells. They're patched
   at three layers (see [Stealth](#stealth)).
2. **Behaviour.** A page that fires `execute()` with no prior input looks synthetic, so
   the cursor moves along Bezier curves before the call.
3. **Cost.** Launching a browser takes seconds. Pooling amortises it; farm mode goes
   further and amortises the page too.

## Layout

```
src/
  server.js            Express API, request auth, stats, lifecycle
  semaphore.js         concurrency limiter for /solve
  solver.js            setupSolverPage + mintToken, mouse simulation, proxy parsing
  pool.js              warm browser pool, shared launch + UA detection
  stealth.js           init script injected into every context
  config.js            config.yaml + env loading, defaults, mode presets, validation
  constants.js         values shared across modules
  paths.js             companion-file lookup (config.yaml, proxies.txt)
  errors.js            failure classification shared by /solve and the farm
  farm/
    manager.js         owns browsers and workers, reconciles toward a target count
    worker.js          one warm context+page: mint loop and recycling
    autoscaler.js      CPU-driven, total-RAM-capped target adjustment
    proxyProvider.js   proxies.txt parsing, rotation, cooldown
    buffer.js          freshest-first token buffer behind GET /token
```

## Solving one token

`setupSolverPage()` and `mintToken()` are split apart on purpose. Setup is the expensive
part and happens once; minting is the part you want to repeat.

Setup does the following, in order:

1. **New context**, with the proxy bound to it. A context's proxy is fixed for its
   lifetime, which is why rotating IPs means rebuilding the context.
2. **Inject the stealth script** via `addInitScript`, so it runs before any page JS.
3. **Navigate to the origin.** A route handler intercepts the request and serves an empty
   HTML shell. reCAPTCHA only cares which origin `execute()` runs from, so downloading the
   real page is wasted bandwidth and wasted time.
4. **Simulate a person** arriving: cursor settles, wanders, sometimes scrolls.
5. **Load the reCAPTCHA script** if the page didn't already ship it: `enterprise.js` for
   Enterprise, `api.js` for plain v3.
6. **Absorb the `ready()` handshake**, so every later mint is a bare `execute()`.

`mintToken()` is then just optional mouse activity, a short pause, and the call.

Enterprise and plain v3 differ in exactly two places: the script URL above, and whether
`ready`/`execute` live on `grecaptcha.enterprise` or `grecaptcha`. The `enterprise` flag
picks between them and defaults to true. Google rejects a site key sent to the wrong
endpoint, so a mismatch surfaces as a script-load failure rather than a bad token.

`solve()` composes both and always tears the context down. `/solve` uses it directly.

## Farm mode

For a single fixed target, rebuilding a context per token is pure waste. `FarmWorker` keeps
the page warm and loops on `mintToken()`, pushing into a buffer that `/token` serves from.

The catch is that v3 scores decay when one session mints repeatedly, so workers recycle
after `maxTokensPerWorker` tokens or `maxWorkerAgeMs`, whichever comes first. Recycling
rebuilds the context and takes the next proxy, which is also how IPs rotate.

### Reconciliation

`FarmManager` holds a `target` worker count and reconciles the live set toward it. Growth
and shrinkage both go through `_reconcile()`, which is guarded against re-entry. A request
that arrives mid-pass sets a flag and runs straight afterward instead of interleaving.

Worker-to-browser bookkeeping is exact, at `CONTEXTS_PER_BROWSER` tabs each. That's what
lets browsers be launched and retired safely while workers are attached to them.

A grow can legitimately fail: every proxy cooling down, or a browser that won't launch. It
returns false rather than throwing, the pass ends, and `nudge()` retries on the next
autoscaler tick.

### Autoscaling

CPU is the control signal, sampled from `os.cpus()` idle-vs-total tick deltas and
EWMA-smoothed. It reads accurately on every platform, which is the whole reason it's
primary.

Memory is handled differently. `os.freemem()` is not trustworthy: on Linux it excludes
reclaimable cache, and on macOS it excludes purgeable pages and so sits near "full" even
when memory is plentiful. Instead the ceiling comes from **total** RAM
(`ramUsableFraction * totalmem / estPerWorkerRamMB`), which is stable and portable.
`os.freemem()` survives only as a soft grow-gate and brake on Linux and Windows, and is
ignored entirely on macOS. Without that split, farm mode would refuse to scale on any Mac.

The policy is fast-down, slow-up: shed `stepDown` workers the moment CPU crosses `cpuHigh`,
but require `upTicksRequired` consecutive calm ticks plus a cooldown before adding one.
Shedding late costs throughput; growing early costs stability.

### Token buffer

Tokens are single-use and expire in about two minutes, which drives every decision in
`buffer.js`:

- `take()` returns the **newest** token, not the oldest. The consumer wants maximum
  remaining TTL, and the old ones were going to expire regardless.
- Expiry is lazy, evaluated on whatever call touches the buffer next. No timer.
- When full, `block` mode refuses the push so workers idle. That's the default: minting
  into a full buffer burns CPU and, worse, spends proxy reputation for nothing. `drop`
  mode instead discards the oldest, trading that waste for always-fresh tokens.

## Stealth

Three overlapping layers, each catching what the others miss:

1. **Launch flags** (`pool.js`): `--disable-blink-features=AutomationControlled` plus
   pointer-capability overrides, so headless doesn't report a coarse touch pointer on a
   1920x1080 desktop viewport.
2. **puppeteer-extra-plugin-stealth**, applied through `playwright-extra`.
3. **`stealth.js`**, injected per context: `navigator.webdriver`, the `window.chrome`
   surface, `navigator.languages`, a `navigator.plugins` fallback for older headless
   builds, and Permissions API queries that headless answers badly.

Layer 3 runs first, so layer 2 can wrap it. That ordering has a consequence worth knowing:
the plugin re-wraps `Permissions.prototype.query`, and for `notifications` its answer wins
over ours. It returns whatever `Notification.permission` says, which keeps the two
consistent. Our handling of that name is a fallback for a build without the plugin. If you
change anything in this area, query it from a real page and check the value, because a
patch here can be installed and still not be the thing answering.

The rule when adding to this: only patch what headless actually gets wrong. Every
redefined property is itself a potential tell, so a missing patch often beats a sloppy one.
A patch that does nothing is strictly worse than no patch, because it still leaves a trace.

The user agent is read off the real binary at startup and pinned to every context, with
`HeadlessChrome` rewritten to `Chrome`. Otherwise the UA would announce headless while the
rest of the fingerprint said otherwise.

## Why Playwright

- **Per-context proxies.** `browser.newContext({ proxy })` is what makes browser pooling
  compatible with a large, diverse proxy list. Puppeteer takes its proxy at launch, which
  would force one browser process per proxy.
- **Botright.** The highest-scoring open framework in this space is built on Playwright,
  and its flag set is where most of `LAUNCH_ARGS` comes from.
- **Route interception** is ergonomic enough that serving a stub page instead of the real
  target is a three-line change.

## Failure handling

`errors.js` maps thrown errors to stable codes, shared by the HTTP layer and farm workers.
The `hasProxy` flag tips the ambiguous cases: a timeout or a failed `enterprise.js` fetch
is almost always the proxy's fault when one is in use, and classifying it that way is what
lets the provider cool the right thing down.

Workers count consecutive failures and exit after five, at which point the manager notices
and starts a replacement. A single failure just triggers a recycle.

The process treats uncaught exceptions as fatal. When a terminal is attached, someone
double-clicked a packaged binary, it holds the window open so the error is readable.
Otherwise it exits non-zero and lets Docker or systemd restart it.
