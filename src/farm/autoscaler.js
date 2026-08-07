const os = require("os");

// os.freemem() is useless on macOS: it excludes purgeable pages and reads
// near-full even with plenty free. There we go on CPU alone and rely on the
// manager's total-RAM cap. Elsewhere it's directional enough to gate growth.
const IS_DARWIN = os.platform() === "darwin";

function cpuSample() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const k in cpu.times) total += cpu.times[k];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// Moves the farm's target worker count from host load. CPU is the signal
// (idle-vs-total tick deltas, EWMA smoothed). Fast down, slow up, with a
// deadband and cooldown so it doesn't oscillate around the threshold.
class Autoscaler {
  constructor(manager) {
    this.m = manager;
    this.f = manager.config.farm;
    this.cpu = 0;
    this._seeded = false;
    this._prev = cpuSample();
    this._upStreak = 0;
    this._lastUp = 0;
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => {
      try {
        this._tick();
      } catch (err) {
        console.error(`[autoscaler] tick error: ${err.message}`);
      }
    }, this.f.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _sampleCpu() {
    const cur = cpuSample();
    const dTotal = cur.total - this._prev.total;
    const dIdle = cur.idle - this._prev.idle;
    this._prev = cur;

    const busy = dTotal > 0 ? 1 - dIdle / dTotal : 0;
    this.cpu = this._seeded ? 0.4 * busy + 0.6 * this.cpu : busy;
    this._seeded = true;
    return this.cpu;
  }

  _tick() {
    const cpu = this._sampleCpu();
    const f = this.f;
    const ram = 1 - os.freemem() / os.totalmem();
    const ramPressure = !IS_DARWIN && ram > f.ramHigh;
    const ramHeadroom = IS_DARWIN || ram < f.ramLow;

    let target = this.m.target;

    if (cpu > f.cpuHigh || ramPressure) {
      target -= f.stepDown;
      this._upStreak = 0;
    } else if (cpu < f.cpuLow && ramHeadroom) {
      // Would one more worker cross the brake? The real ceiling is the
      // manager's maxWorkers(); this just stops us walking into it.
      const estFrac = (f.estPerWorkerRamMB * 1024 * 1024) / os.totalmem();
      if (IS_DARWIN || ram + estFrac < f.ramHigh) {
        this._upStreak++;
        const now = Date.now();
        if (this._upStreak >= f.upTicksRequired && now - this._lastUp > f.cooldownUpMs) {
          target += f.stepUp;
          this._lastUp = now;
          this._upStreak = 0;
        }
      }
    } else {
      this._upStreak = 0;
    }

    this.m.setTarget(target);
    this.m.nudge(); // top up after fatals or refused grows
  }
}

module.exports = { Autoscaler };
