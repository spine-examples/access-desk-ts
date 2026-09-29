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

import { type Timestamp, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type Clock, SystemClock } from "@spine-event-engine/server";

let clock: Clock = new SystemClock();

/**
 * Sets the clock that tells the Resources domain what time it is.
 *
 * Every business decision that depends on the current time — when an approval
 * happened, whether access has started, whether it is due to expire — reads
 * this clock, so a test or a demonstration can control time instead of waiting
 * for it.
 *
 * @param next The clock to read from now on.
 */
export function useClock(next: Clock): void {
  clock = next;
}

/** The current time according to the installed clock. */
export function now(): Timestamp {
  return timestampFromDate(clock.now());
}
