import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPoint } from "../scripts/point-check.ts";
const target = { left: 440, top: 260, right: 600, bottom: 340 };
test("requires an in-target pixel point on the correct screen", () => {
  assert.equal(verifyPoint("red [POINT:520,300:button:screen1]", target), true);
  for (const text of ["red", "[POINT:811,752:button:screen1]", "[POINT:520,300:button:screen2]", "[POINT:600,340:button:screen1]"]) {
    assert.equal(verifyPoint(text, target), false);
  }
});
