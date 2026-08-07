const test = require("node:test");
const assert = require("node:assert/strict");

const { Semaphore } = require("../../src/semaphore");

const tick = () => new Promise((r) => setImmediate(r));

test("acquire is immediate while slots are free", async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
  assert.equal(sem.active, 2);
  assert.equal(sem.queue.length, 0);
});

test("callers past the limit queue and resume in arrival order", async () => {
  const sem = new Semaphore(1);
  const order = [];

  await sem.acquire();
  const second = sem.acquire().then(() => order.push("second"));
  const third = sem.acquire().then(() => order.push("third"));

  await tick();
  assert.deepEqual(order, [], "queued callers must not run while the slot is held");
  assert.equal(sem.queue.length, 2);

  sem.release();
  await second;
  sem.release();
  await third;

  assert.deepEqual(order, ["second", "third"]);
});

test("active count stays consistent through a handoff", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  const queued = sem.acquire();
  sem.release(); // hands the slot over rather than freeing it
  await queued;

  assert.equal(sem.active, 1);
  sem.release();
  assert.equal(sem.active, 0);
});

test("release never drives active negative", () => {
  const sem = new Semaphore(1);
  sem.release();
  sem.release();
  assert.equal(sem.active, 0);
});

test("run() releases the slot even when fn throws", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(() => sem.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(sem.active, 0);

  assert.equal(await sem.run(async () => "ok"), "ok");
  assert.equal(sem.active, 0);
});

test("concurrency never exceeds the limit under load", async () => {
  const sem = new Semaphore(3);
  let running = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 20 }, () =>
      sem.run(async () => {
        peak = Math.max(peak, ++running);
        await tick();
        running--;
      }),
    ),
  );

  assert.equal(peak, 3);
  assert.equal(sem.active, 0);
});
