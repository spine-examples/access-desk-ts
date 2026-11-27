/*
 * Copyright 2026 CodeMatters, Lda.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

import { describe, expect, it } from "vitest";
import { BackoffType, Retry } from "../src/retry.js";

import { delaysOf, expectAbout } from "./given/retry.js";

describe("Retry should", () => {
  it("wait the same delay before every retry with a constant backoff", async () => {
    expectAbout(await delaysOf(BackoffType.CONSTANT), [40, 40, 40]);
  });

  it("grow the delay by the first delay with a linear backoff", async () => {
    expectAbout(await delaysOf(BackoffType.LINEAR), [40, 80, 120]);
  });

  it("double the delay with an exponential backoff", async () => {
    expectAbout(await delaysOf(BackoffType.EXPONENTIAL), [40, 80, 160]);
  });
  const options = { backoffType: BackoffType.CONSTANT, delayMs: 10, timeoutMs: 1_000 };

  it("give the result of the first attempt that gives one", async () => {
    let attempts = 0;

    const outcome = await Retry.execute(options, () => {
      attempts += 1;
      return Promise.resolve(attempts < 3 ? undefined : "done");
    });

    expect(outcome).toEqual({ kind: "succeeded", result: "done" });
    expect(attempts).toBe(3);
  });

  it("retry an attempt that fails", async () => {
    let attempts = 0;

    const outcome = await Retry.execute(options, () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("down")) : Promise.resolve("done");
    });

    expect(outcome).toEqual({ kind: "succeeded", result: "done" });
  });

  it("stop after the most retries, with the error of the last failed attempt", async () => {
    let attempts = 0;
    const error = new Error("down");

    const outcome = await Retry.execute({ ...options, maxRetryAttempts: 2 }, () => {
      attempts += 1;
      return Promise.reject(error);
    });

    expect(outcome).toEqual({ kind: "exhausted", lastError: error });
    expect(attempts).toBe(3);
  });

  it("make one attempt when no retries are allowed", async () => {
    let attempts = 0;

    await Retry.execute({ ...options, maxRetryAttempts: 0 }, () => {
      attempts += 1;
      return Promise.resolve(undefined);
    });

    expect(attempts).toBe(1);
  });

  it("stop when the time runs out, and give each attempt the time left", async () => {
    const remaining: number[] = [];
    const started = Date.now();

    const outcome = await Retry.execute({ ...options, delayMs: 50, timeoutMs: 300 }, (left) => {
      remaining.push(left);
      return Promise.resolve(undefined);
    });

    expect(outcome).toEqual({ kind: "exhausted", lastError: undefined });
    expect(Date.now() - started).toBeLessThan(400);
    expect(remaining.length).toBeGreaterThan(1);
    expect(
      remaining.every((left, index) => index === 0 || left < (remaining[index - 1] ?? 0)),
    ).toBe(true);
  });
});
