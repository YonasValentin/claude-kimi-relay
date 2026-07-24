import assert from "node:assert/strict";
import test from "node:test";

import { meetsNodeFloor } from "../src/doctor.js";

void test("meetsNodeFloor enforces the full 22.14 floor, not just the major version", () => {
  assert.equal(meetsNodeFloor("v22.16.0"), true);
  assert.equal(meetsNodeFloor("22.14.0"), true);
  assert.equal(meetsNodeFloor("v23.0.0"), true);
  assert.equal(meetsNodeFloor("v22.13.9"), false);
  assert.equal(meetsNodeFloor("v22.0.0"), false);
  assert.equal(meetsNodeFloor("v21.99.99"), false);
});
