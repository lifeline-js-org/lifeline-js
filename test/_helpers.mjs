import assert from "node:assert/strict";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createResource(name, log, delayMs = 0) {
  return {
    name,
    async init() {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      log.push(name);
    },
  };
}

export const captureRejection = (promise) =>
  promise.then(
    () => assert.fail("a operação deveria ter rejeitado"),
    (error) => error,
  );
