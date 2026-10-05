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

import { create } from "@bufbuild/protobuf";
import {
  type Duration,
  type Timestamp,
  DurationSchema,
  TimestampSchema,
} from "@bufbuild/protobuf/wkt";

const NANOS_PER_SECOND = 1_000_000_000n;

/** A half-open span of time, `[start, end)`: it includes its start and excludes its end. */
export interface Interval {
  readonly start: Timestamp;
  readonly end: Timestamp;
}

/**
 * Orders two points in time.
 *
 * @returns A negative number when `a` is earlier, zero when equal, positive when later.
 */
export function compare(a: Timestamp, b: Timestamp): number {
  const difference = nanosOf(a) - nanosOf(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** The point in time `duration` after `time`. */
export function plus(time: Timestamp, duration: Duration): Timestamp {
  const total = nanosOf(time) + nanosOf(duration);
  return create(TimestampSchema, {
    seconds: total / NANOS_PER_SECOND,
    nanos: Number(total % NANOS_PER_SECOND),
  });
}

/** The time elapsed from `start` to `end`. */
export function between(start: Timestamp, end: Timestamp): Duration {
  const total = nanosOf(end) - nanosOf(start);
  return create(DurationSchema, {
    seconds: total / NANOS_PER_SECOND,
    nanos: Number(total % NANOS_PER_SECOND),
  });
}

/** Whether `duration` is longer than `maximum`. */
export function longerThan(duration: Duration, maximum: Duration): boolean {
  return nanosOf(duration) > nanosOf(maximum);
}

/**
 * Whether two half-open intervals share any moment.
 *
 * Intervals that merely touch, such as `[a, b)` and `[b, c)`, do not overlap.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return compare(a.start, b.end) < 0 && compare(b.start, a.end) < 0;
}

function nanosOf(value: Timestamp | Duration): bigint {
  return value.seconds * NANOS_PER_SECOND + BigInt(value.nanos);
}
