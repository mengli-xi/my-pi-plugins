import assert from "node:assert/strict";
import test from "node:test";
import { DestroyConfirmation } from "../destroy-confirmation.ts";

test("requires a second press within the confirmation window", () => {
  const confirmation = new DestroyConfirmation(4_000);
  assert.equal(confirmation.press(1_000), "armed");
  assert.equal(confirmation.isActive(4_999), true);
  assert.equal(confirmation.press(4_999), "confirmed");
  assert.equal(confirmation.isActive(5_000), false);
});

test("expiry and cancellation require a fresh pair", () => {
  const confirmation = new DestroyConfirmation(4_000);
  assert.equal(confirmation.press(1_000), "armed");
  assert.equal(confirmation.press(5_000), "armed", "an expired confirmation must not destroy");
  confirmation.cancel();
  assert.equal(confirmation.press(5_100), "armed");
  assert.equal(confirmation.press(5_101), "confirmed");
});
