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

import { describe, expect, it } from "vitest";
import { AccessLevel } from "@access-desk/resources-model/generated/access_desk/resources/access_level_pb.js";
import {
  accessLevelDisplayName,
  accessLevelIsAtLeast,
  accessLevelRank,
} from "@access-desk/resources-model/access-level";

describe("AccessLevel enum options", () => {
  it("reads the rank and display name from the enum-value options", () => {
    expect(accessLevelRank(AccessLevel.READ)).toBe(1);
    expect(accessLevelRank(AccessLevel.WRITE)).toBe(2);
    expect(accessLevelRank(AccessLevel.ADMIN)).toBe(3);
    expect(accessLevelDisplayName(AccessLevel.READ)).toBe("Read");
    expect(accessLevelDisplayName(AccessLevel.WRITE)).toBe("Write");
    expect(accessLevelDisplayName(AccessLevel.ADMIN)).toBe("Admin");
  });

  it("defaults the unspecified level to rank zero and an empty name", () => {
    expect(accessLevelRank(AccessLevel.AL_UNSPECIFIED)).toBe(0);
    expect(accessLevelDisplayName(AccessLevel.AL_UNSPECIFIED)).toBe("");
  });

  it("compares levels by rank for same-or-stronger checks", () => {
    expect(accessLevelIsAtLeast(AccessLevel.ADMIN, AccessLevel.READ)).toBe(true);
    expect(accessLevelIsAtLeast(AccessLevel.READ, AccessLevel.READ)).toBe(true);
    expect(accessLevelIsAtLeast(AccessLevel.READ, AccessLevel.WRITE)).toBe(false);
  });
});
