import test from "node:test";
import assert from "node:assert/strict";

import * as lifeline from "../dist/index.js";
import * as core from "../dist/core/index.js";

test("o pacote pode ser importado como um módulo", () => {
  assert.ok(lifeline);
});

test("o subpath core expõe a mesma API do entry principal", () => {
  assert.equal(core.LifeLine, lifeline.LifeLine);
  assert.equal(core.CleanupError, lifeline.CleanupError);
  assert.deepEqual(
    Object.keys(core).sort(),
    Object.keys(lifeline).sort(),
  );
});
