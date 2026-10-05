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

import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type { AccessPeriod } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { compare, type Interval, plus } from "../time/interval.js";

/**
 * The span of access a request asks for, as known when it is submitted.
 *
 * A scheduled request names its interval. An immediate request names only a
 * duration, so its interval is assumed to start at submission; the real start
 * is only known once the request is approved.
 *
 * @param period The requested period.
 * @param submittedAt When the request is submitted.
 * @returns The requested interval, or `undefined` for an incomplete period.
 */
export function requestedInterval(
  period: AccessPeriod,
  submittedAt: Timestamp,
): Interval | undefined {
  if (period.kind.case === "immediateDuration") {
    return { start: submittedAt, end: plus(submittedAt, period.kind.value) };
  }
  if (period.kind.case === "scheduled") {
    const { start, end } = period.kind.value;
    return start === undefined || end === undefined ? undefined : { start, end };
  }
  return undefined;
}

/**
 * The span of access a request grants when it is approved at a given time.
 *
 * 1. An immediate request counts its duration from the approval: `[A, A + duration)`.
 * 2. A scheduled request approved before its start keeps its interval `[S, E)`.
 * 3. A scheduled request approved within its interval starts at the approval: `[A, E)`.
 * 4. A scheduled request approved at or after its end grants no access.
 *
 * @param period The requested period.
 * @param approvedAt When the request was approved.
 * @returns The effective interval, or `undefined` when no access remains.
 */
export function effectiveInterval(
  period: AccessPeriod,
  approvedAt: Timestamp,
): Interval | undefined {
  if (period.kind.case === "immediateDuration") {
    return { start: approvedAt, end: plus(approvedAt, period.kind.value) };
  }
  if (period.kind.case === "scheduled") {
    const { start, end } = period.kind.value;
    if (start === undefined || end === undefined || compare(approvedAt, end) >= 0) {
      return undefined;
    }
    return { start: compare(approvedAt, start) > 0 ? approvedAt : start, end };
  }
  return undefined;
}
