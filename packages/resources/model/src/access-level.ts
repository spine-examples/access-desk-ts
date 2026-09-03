/*
 * Copyright 2026, TeamDev. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Redistribution and use in source and/or binary forms, with or without
 * modification, must retain the above copyright notice and the following
 * disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { getOption } from "@bufbuild/protobuf";
import type { DescEnumValue } from "@bufbuild/protobuf";
import {
  AccessLevel,
  AccessLevelSchema,
  access_level,
  type AccessLevelOptions,
} from "../generated/access_desk/resources/access_level_pb.js";

/**
 * Reads the `(access_level)` enum-value options attached to one {@link AccessLevel}.
 *
 * The metadata (rank and display name) lives on the enum value descriptor, so it
 * is available anywhere the generated schema is, without a lookup table.
 */
function accessLevelOptions(level: AccessLevel): AccessLevelOptions {
  const target: number = level;
  const descriptor: DescEnumValue | undefined = AccessLevelSchema.values.find(
    (value) => value.number === target,
  );
  if (descriptor === undefined) {
    throw new RangeError(`Unknown access level: ${String(level)}.`);
  }
  return getOption(descriptor, access_level);
}

/**
 * The relative strength of an {@link AccessLevel}; a higher rank is stronger.
 *
 * @param level The access level to rank.
 * @returns The configured rank, or zero for the unspecified level.
 */
export function accessLevelRank(level: AccessLevel): number {
  return accessLevelOptions(level).rank;
}

/**
 * The human-readable name configured for an {@link AccessLevel}.
 *
 * @param level The access level to name.
 * @returns The configured display name, or an empty string for the unspecified level.
 */
export function accessLevelDisplayName(level: AccessLevel): string {
  return accessLevelOptions(level).displayName;
}

/**
 * Whether one access level is the same as or stronger than another by rank.
 *
 * This is the within-resource same-or-stronger comparison; it is not a universal
 * permission language.
 *
 * @param held The level a requester holds or is granted.
 * @param required The level being checked against.
 * @returns `true` when `held` ranks at least as high as `required`.
 */
export function accessLevelIsAtLeast(held: AccessLevel, required: AccessLevel): boolean {
  return accessLevelRank(held) >= accessLevelRank(required);
}
