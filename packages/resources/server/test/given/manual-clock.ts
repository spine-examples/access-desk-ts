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

import type { Clock } from "@spine-event-engine/server";

/**
 * A clock that stands still until a test moves it.
 *
 * Lets a test reach a point in time — the start or end of access — at once,
 * instead of waiting for it.
 */
export class ManualClock implements Clock {
  #time: number;

  /**
   * Creates a clock stopped at the given time.
   *
   * @param time The time the clock shows until it is moved.
   */
  constructor(time: Date) {
    this.#time = time.getTime();
  }

  now(): Date {
    return new Date(this.#time);
  }

  /**
   * Moves the clock forward.
   *
   * @param minutes How many minutes to move it by.
   */
  advanceMinutes(minutes: number): void {
    this.#time += minutes * 60_000;
  }
}
