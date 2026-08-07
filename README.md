# recaptcha-harvester

Self-hosted reCAPTCHA v3 solver, both Enterprise and standard. It runs a pool of warm,
stealth-patched Chromium instances behind a small HTTP API and hands back tokens.

The approach is deliberately boring: there is no fingerprint spoofing to maintain, because
a real browser produces real canvas, WebGL, audio and font data on its own. What's left is
keeping the automation markers out of the page, moving the mouse like a person, and calling
`grecaptcha.execute()` from the right origin.

The task fields are the ones Capsolver's `ReCaptchaV3Task` and `ReCaptchaV3EnterpriseTask`
already take (`websiteURL`, `websiteKey`, `pageAction`, `proxy`), so porting an existing
integration is mostly mechanical. It is not wire-compatible, though: this is a single
synchronous `POST /solve` that returns the token, rather than Capsolver's
`createTask`/`getTaskResult` polling pair.

**Supported:** reCAPTCHA Enterprise v3 (default) and plain reCAPTCHA v3, selected per
request with the `enterprise` flag. The two differ only in which script gets loaded
(`enterprise.js` vs `api.js`) and which namespace holds `execute()`; everything else about
solving them is identical. reCAPTCHA v2 and invisible are **not** supported, since they
need a challenge to be solved rather than just a score.

## Requirements

- Node.js 20 or newer (22+ recommended, since 20 is past its upstream end-of-life)
- ~500 MB RAM per browser instance, plus roughly 150 MB per farm worker
- Optional: HTTP proxies, and a real Google Chrome install (it tends to score better than
  bundled Chromium)

## Quick start

```bash
git clone https://github.com/clementclecle/recaptcha-harvester.git
cd recaptcha-harvester
npm install
npm run setup                 # downloads Chromium for Playwright

cp config.example.yaml config.yaml
npm start
```

Check that the machine can actually produce tokens before wiring anything up:

```bash
npm run test:score            # solves a demo captcha and prints the score Google gave it
ENTERPRISE=false npm run test:score   # same, against a plain v3 site key
```

That posts a real token to 2captcha's public demo verifier. Anything at 0.7 or above is
healthy. If it comes back at 0.1 or 0.3, see [Improving scores](#improving-scores).

## API

Requests go to `http://127.0.0.1:3131` by default. Set `apiKey` in the config to require
`X-API-Key: <key>` or `Authorization: Bearer <key>` on everything except `/health`.

### POST /solve

```bash
curl -X POST http://127.0.0.1:3131/solve \
  -H 'Content-Type: application/json' \
  -d '{
    "websiteURL": "https://example.com/checkout",
    "websiteKey": "6Lxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "pageAction": "checkout",
    "proxy": "1.2.3.4:8080:user:pass",
    "enterprise": true
  }'
```

`proxy` is optional and accepts `ip:port`, `ip:port:user:pass` or
`http://user:pass@ip:port`.

`enterprise` is optional and defaults to `true`. Set it to `false` for a plain reCAPTCHA v3
site key. Getting it wrong fails with `errorCode: 4`, because Google serves the two site
key types from different endpoints and rejects a mismatch.

Any omitted field falls back to `farm.target` in the config, if one is set, so with a
target configured, an empty `{}` body is a valid request.

```json
{
  "token": "03AFcWeA5...",
  "userAgent": "Mozilla/5.0 ...",
  "solveTime": 3187
}
```

Failures return HTTP 500 with a stable code:

```json
{ "errorCode": 1, "errorMessage": "proxy error", "solveTime": 2041 }
```

| Code | Meaning |
|---|---|
| 0 | unknown error |
| 1 | proxy error (unreachable, bad auth, or malformed) |
| 2 | timeout |
| 3 | DNS failure |
| 4 | reCAPTCHA failed to load |
| 5 | empty token returned |

Timeouts and script-load failures are reported as proxy errors when a proxy was in use,
since that is nearly always the cause.

### GET /token

Farm mode only. Pops the freshest buffered token, or returns `204 No Content` when the
buffer is empty.

```json
{ "token": "03AFcWeA5...", "ageMs": 1200, "remainingMs": 108800 }
```

### GET /stats

Solve counts, success rate, queue depth, and, in farm mode, worker counts, throughput,
buffer state, CPU and proxy health.

### GET /health

Returns `{"status":"ok"}`. Never requires auth, so it works as a container healthcheck.

## Farm mode

`/solve` builds a fresh browser context per request. That is the right trade when targets
vary, but it means paying for context setup, navigation and the reCAPTCHA handshake on
every single token.

Farm mode inverts that. Set `farm.enabled: true` with one fixed target and the service
keeps contexts and pages **warm** and calls `execute()` in a loop, which is the only
irreducible per-token work. The results go into a buffer. Consumers then pull pre-made tokens from
`/token` with no wait at all.

```yaml
farm:
  enabled: true
  mode: balanced
  target:
    websiteURL: "https://example.com/checkout"
    websiteKey: "6Lxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    pageAction: "checkout"
    enterprise: true
```

Workers recycle on a schedule, rebuilding the context and rotating to the next proxy.
This is not just about IP rotation: v3 scores drift downward when one session calls
`execute()` repeatedly, so a page has a useful lifetime measured in tokens.

`mode` picks how aggressively to trade score for volume. Any individual key can be
overridden alongside it.

| Mode | Recycle after | Mouse | Workers per proxy |
|---|---|---|---|
| `quality` | 5 tokens / 45s | full | 1 |
| `balanced` (default) | 25 tokens / 90s | light | 2 |
| `throughput` | 150 tokens / 300s | none | unlimited |

The worker count autoscales. It starts at `maxConcurrent` and follows CPU, which reads
accurately on every platform. The ceiling comes from **total** system RAM
(`ramUsableFraction * totalmem / estPerWorkerRamMB`), so the farm sizes itself to whatever
host it lands on. `os.freemem()` is only used as a soft gate on Linux and Windows. It is
meaningless on macOS, so it is ignored there.

`POST /solve` keeps working while the farm runs.

## Configuration

Copy `config.example.yaml` to `config.yaml`, which is git-ignored. Without one, the service
falls back to the example so a fresh clone still starts.

Environment variables override the file:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose the service. |
| `PORT` | `3131` | Listen port |
| `API_KEY` | _(none)_ | When set, required on `/solve`, `/token` and `/stats` |
| `MAX_CONCURRENT` | _(CPU cores)_ | Concurrent solves. The one concurrency knob. |
| `POOL_SIZE` | _(derived)_ | Warm browsers. Defaults to `ceil(maxConcurrent / 4)`. |
| `CHROME_PATH` | _(bundled)_ | Path to a Chrome/Chromium binary |
| `HEADLESS` | `true` | `false` for a visible window, which is useful when debugging |
| `FARM_ENABLED` | `false` | Turn farm mode on |
| `FARM_MODE` | `balanced` | `balanced`, `throughput` or `quality` |

The service binds to loopback by default. If you expose it, set an `apiKey` too. An open
solver lets anyone on the network spend your proxies.

## Proxies

Farm mode reads `proxies.txt` (git-ignored) from next to the binary, the working directory,
or the repo root. One per line:

```
1.2.3.4:8080:user:pass
5.6.7.8:3128
http://user:pass@9.10.11.12:8080
```

Blank lines and `#` comments are ignored; duplicates and unparseable lines are skipped with
a warning at startup. Proxies that fail back off exponentially, from 5 seconds up to 5
minutes, and rejoin the rotation as soon as they succeed again. With no file present, the
farm connects directly from the host's own IP.

Because Playwright binds a proxy per browser *context*, one warm browser serves many
requests through different proxies at once. This is the main reason the project uses
Playwright rather than Puppeteer, which only accepts a proxy at browser-launch time.

## Docker

```bash
docker build -t recaptcha-harvester .
docker run --rm -p 3131:3131 \
  -e HOST=0.0.0.0 \
  -e API_KEY=your-secret \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  -v "$PWD/proxies.txt:/app/proxies.txt:ro" \
  --shm-size=1g \
  recaptcha-harvester
```

`--shm-size=1g` matters: Chromium's default 64 MB of shared memory in a container causes
renderer crashes under load.

## Improving scores

The token carries a score from 0.0 to 1.0. This setup typically lands at 0.7-0.9. If yours
is lower, in rough order of impact:

1. **Change proxies.** Datacenter IPs score badly. Residential and mobile score well. This
   dominates everything else on this list.
2. **Use real Chrome** via `chromePath` rather than bundled Chromium.
3. **Run headed** with `headless: false`, on a machine with a display.
4. **Switch to `quality` mode**, or lower `maxTokensPerWorker` so pages recycle sooner.
5. **Check the action string.** `pageAction` must match what the real site sends, or the
   score is assessed against the wrong model.

Run `npm run test:score` after each change, it is the only way to know whether something
helped.

## Development

```bash
npm test                      # unit tests, no network required
npm run test:solve            # solve one token directly, without the server
npm run test:solve -- 1.2.3.4:8080:user:pass
npm run build                 # standalone binaries via pkg
```

`docs/ARCHITECTURE.md` covers how the pieces fit together and why the tricky parts are
built the way they are. `CONTRIBUTING.md` has the conventions.

## Responsible use

This exists for testing and automating systems you own or are authorised to operate
against. Solving captchas on someone else's site is very likely against their terms of
service, and may be against the law where you are. That call is yours to make.

## License

[MIT](LICENSE)
