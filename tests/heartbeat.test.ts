import assert from "node:assert/strict";
import test from "node:test";

import { startHeartbeat } from "../src/heartbeat.js";

void test("no beat during the first interval; a beat once an interval passes with no activity", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const beats: number[] = [];
  const hb = startHeartbeat({ intervalMs: 1000, onBeat: (elapsedMs) => beats.push(elapsedMs) });

  // First interval is suppressed: startup activity is imminent, don't beat yet.
  t.mock.timers.tick(1000);
  assert.deepEqual(beats, []);

  // Second interval elapsed with no recorded activity -> one beat, elapsed 2s.
  t.mock.timers.tick(1000);
  assert.deepEqual(beats, [2000]);

  hb.stop();
});

void test("recorded activity suppresses the following beat", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const beats: number[] = [];
  const hb = startHeartbeat({ intervalMs: 1000, onBeat: (elapsedMs) => beats.push(elapsedMs) });

  t.mock.timers.tick(1000); // suppressed (initial)
  hb.recordActivity(); // progress arrived
  t.mock.timers.tick(1000); // active -> suppressed
  assert.deepEqual(beats, []);

  t.mock.timers.tick(1000); // idle again -> beat
  assert.equal(beats.length, 1);

  hb.stop();
});

void test("stop halts all further beats", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const beats: number[] = [];
  const hb = startHeartbeat({ intervalMs: 1000, onBeat: (elapsedMs) => beats.push(elapsedMs) });

  t.mock.timers.tick(1000);
  hb.stop();
  t.mock.timers.tick(10_000);
  assert.deepEqual(beats, []);
});
