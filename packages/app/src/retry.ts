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

import { setTimeout as sleep } from "node:timers/promises";

/** The ways the delay before each retry grows. */
export enum BackoffType {
  /** The same delay before every retry. */
  CONSTANT,
  /** A delay that grows by the first delay before each retry. */
  LINEAR,
  /** A delay that doubles before each retry. */
  EXPONENTIAL,
}

/** The delay before each retry of an operation. */
interface Backoff {
  /**
   * Computes the delay before a retry.
   *
   * @param retry The number of the retry, from 1 for the first.
   * @returns The delay, in milliseconds.
   */
  delayMs(retry: number): number;
}

/** The way an operation is retried, and for how long. */
export interface RetryOptions {
  /** The way the delay before each retry grows. */
  readonly backoffType: BackoffType;
  /** The delay before the first retry, in milliseconds. */
  readonly delayMs: number;
  /** The time for the first attempt and every retry together, in milliseconds. */
  readonly timeoutMs: number;
  /** The most retries after the first attempt. As many as the time allows when left out. */
  readonly maxRetryAttempts?: number;
}

/** The outcome of an operation that was retried. */
export type RetryOutcome<T> = Succeeded<T> | Exhausted;

/** An attempt of the operation gave a result. */
interface Succeeded<T> {
  readonly kind: "succeeded";
  /** The result of the attempt that gave one. */
  readonly result: T;
}

/** No attempt gave a result before the retries or the time ran out. */
interface Exhausted {
  readonly kind: "exhausted";
  /** The error of the last attempt that failed, when one did. */
  readonly lastError: unknown;
}

/** The retry of an operation that gives no result or fails. */
export const Retry = {
  /**
   * Executes an operation, and retries it until an attempt gives a result.
   *
   * An attempt gives no result when it answers `undefined` or fails. The
   * retries stop when the retries or the time run out, or when the next delay
   * would end after the time.
   *
   * @param options The backoff, the time, and the most retries.
   * @param operation Makes one attempt within the time left, in milliseconds.
   * @returns The result, or the error of the last attempt that failed.
   */
  async execute<T>(
    options: RetryOptions,
    operation: (remainingMs: number) => Promise<T | undefined>,
  ): Promise<RetryOutcome<T>> {
    const backoff = backoffOf(options.backoffType, options.delayMs);
    const deadline = Date.now() + options.timeoutMs;
    const maxRetries = options.maxRetryAttempts ?? Number.POSITIVE_INFINITY;
    let lastError: unknown;
    for (let retry = 0; ; retry += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      try {
        const result = await operation(remaining);
        if (result !== undefined) {
          return { kind: "succeeded", result };
        }
      } catch (error) {
        lastError = error;
      }
      const delay = backoff.delayMs(retry + 1);
      if (retry >= maxRetries || deadline - Date.now() <= delay) {
        break;
      }
      await sleep(delay);
    }
    return { kind: "exhausted", lastError };
  },
};

/**
 * Creates the backoff of a type.
 *
 * @param type The way the delay grows.
 * @param delayMs The delay before the first retry, in milliseconds.
 * @returns The delay before each retry.
 */
function backoffOf(type: BackoffType, delayMs: number): Backoff {
  switch (type) {
    case BackoffType.CONSTANT:
      return { delayMs: () => delayMs };
    case BackoffType.LINEAR:
      return { delayMs: (retry) => delayMs * retry };
    case BackoffType.EXPONENTIAL:
      return { delayMs: (retry) => delayMs * 2 ** (retry - 1) };
  }
}
