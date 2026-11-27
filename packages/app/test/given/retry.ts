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

import { expect } from "vitest";
import { BackoffType, Retry } from "../../src/retry.js";

/**
 * Executes an operation that never gives a result, and measures the delays
 * between its attempts.
 */
export async function delaysOf(backoffType: BackoffType): Promise<number[]> {
  const started: number[] = [];
  await Retry.execute({ backoffType, delayMs: 40, timeoutMs: 2_000, maxRetryAttempts: 3 }, () => {
    started.push(Date.now());
    return Promise.resolve(undefined);
  });
  return started.slice(1).map((at, index) => at - (started[index] ?? at));
}

/** Checks that every delay is about the expected one. */
export function expectAbout(delays: number[], expected: number[]): void {
  expect(delays).toHaveLength(expected.length);
  delays.forEach((delay, index) => {
    expect(delay).toBeGreaterThanOrEqual((expected[index] ?? 0) - 5);
    expect(delay).toBeLessThan((expected[index] ?? 0) + 30);
  });
}
