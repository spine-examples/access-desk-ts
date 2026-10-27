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

import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestStorages, type TestStorage } from "@access-desk/testing/storage";
import { typeRegistry } from "../../generated/model-registry.js";
import { RevokedTokens } from "../../src/gateway/revoked-tokens.js";
import type { StorageSettings } from "../../src/settings.js";

/** An hour, in milliseconds. */
const HOUR_MS = 60 * 60 * 1_000;

let storage: TestStorage;
let settings: StorageSettings;
let revoked: Awaited<ReturnType<typeof RevokedTokens.open>>;

beforeEach(async () => {
  storage = await TestStorages.singleTenant(typeRegistry);
  settings = TestStorages.settingsOf(storage);
  revoked = await RevokedTokens.open(settings);
});

afterEach(async () => {
  await revoked.close();
  await storage.drop();
});

describe("The revoked tokens should", () => {
  it("include a token once it is revoked, and no other", async () => {
    await revoked.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));

    expect(await revoked.isRevoked("token-1")).toBe(true);
    expect(await revoked.isRevoked("token-2")).toBe(false);
  });

  it("take a token revoked twice", async () => {
    await revoked.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));
    await revoked.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));

    expect(await revoked.isRevoked("token-1")).toBe(true);
  });

  it("forget a token once it would have expired", async () => {
    await revoked.revoke("expired", timestampFromMs(Date.now() - HOUR_MS));
    await revoked.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));

    expect(await revoked.isRevoked("expired")).toBe(false);
    expect(await revoked.isRevoked("token-1")).toBe(true);
  });

  it.runIf(TestStorages.profile() === "postgresql")(
    "still include a revoked token when the gateway restarts, in PostgreSQL",
    async () => {
      await revoked.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));
      await revoked.close();

      revoked = await RevokedTokens.open(settings);

      expect(await revoked.isRevoked("token-1")).toBe(true);
    },
  );
});
