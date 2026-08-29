import assert from "node:assert/strict";
import test from "node:test";
import {
  RetryExhaustedError,
  retryAfterMilliseconds,
  withRetry
} from "../src/retry.js";

test("uses Retry-After seconds and returns response metadata", async () => {
  const delays: number[] = [];
  let calls = 0;

  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 429,
        headers: { "Retry-After": "2" },
        body: "limited"
      };
    }
    return { status: 200, body: "complete" };
  }, {
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    jitterRatio: 0,
    sleep: async (delay) => {
      delays.push(delay);
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
  assert.equal(result.attempts, 2);
  assert.equal(result.status, 200);
  assert.equal(result.body, "complete");
  assert.deepEqual(result.value, { status: 200, body: "complete" });
});

test("parses Retry-After HTTP dates with an injected clock", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const headers = new Headers({
    "Retry-After": new Date(now + 4_000).toUTCString()
  });

  assert.equal(retryAfterMilliseconds(headers, now), 4_000);
  assert.equal(retryAfterMilliseconds({ "retry-after": "invalid" }, now), undefined);
});

test("does not cap Retry-After at the exponential backoff limit", async () => {
  const delays: number[] = [];
  let calls = 0;

  await withRetry(async () => {
    calls += 1;
    return calls === 1
      ? { status: 429, headers: { "retry-after": "120" }, body: "limited" }
      : { status: 200, body: "ok" };
  }, {
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
    sleep: async (delay) => {
      delays.push(delay);
    }
  });

  assert.deepEqual(delays, [120_000]);
});

test("retries network failures, 408, and 5xx with bounded exponential jitter", async () => {
  const delays: number[] = [];
  let calls = 0;

  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    }
    if (calls === 2) {
      return { status: 408, body: "timeout" };
    }
    if (calls === 3) {
      return { status: 503, body: "unavailable" };
    }
    return { status: 204, body: "" };
  }, {
    maxAttempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 600,
    jitterRatio: 0.25,
    random: () => 1,
    sleep: async (delay) => {
      delays.push(delay);
    }
  });

  assert.equal(result.attempts, 4);
  assert.deepEqual(delays, [125, 250, 500]);
});

test("honors Retry-After from thrown HTTP responses", async () => {
  const delays: number[] = [];
  let calls = 0;

  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("rate limited"), {
        response: {
          status: 429,
          data: "slow down",
          headers: { "retry-after": "3" }
        }
      });
    }
    return { status: 200, body: "ok" };
  }, {
    baseDelayMs: 50,
    maxDelayMs: 5_000,
    jitterRatio: 0,
    sleep: async (delay) => {
      delays.push(delay);
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(delays, [3_000]);
});

test("throws a structured error after the final retryable response", async () => {
  const delays: number[] = [];

  await assert.rejects(
    withRetry(async () => ({ status: 503, body: "still unavailable" }), {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitterRatio: 0,
      sleep: async (delay) => {
        delays.push(delay);
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof RetryExhaustedError);
      assert.equal(error.attempts, 3);
      assert.equal(error.status, 503);
      assert.equal(error.body, "still unavailable");
      assert.equal(error.reason, "max-attempts");
      return true;
    }
  );

  assert.deepEqual(delays, [10, 20]);
});

test("does not retry a non-retryable response", async () => {
  let calls = 0;

  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      return { status: 404, body: "missing" };
    }, {
      sleep: async () => {
        throw new Error("sleep should not run");
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof RetryExhaustedError);
      assert.equal(error.attempts, 1);
      assert.equal(error.status, 404);
      assert.equal(error.reason, "non-retryable-status");
      return true;
    }
  );

  assert.equal(calls, 1);
});
