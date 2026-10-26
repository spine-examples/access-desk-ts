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
import { typeRegistry } from "../../generated/model-registry.js";
import { EndedSessions } from "../../src/gateway/ended-sessions.js";
import type { StorageSettings } from "../../src/settings.js";
import { TestStorages, type TestStorage } from "../given/storage.js";

/** An hour, in milliseconds. */
const HOUR_MS = 60 * 60 * 1_000;

let storage: TestStorage;
let settings: StorageSettings;
let ended: EndedSessions;

beforeEach(async () => {
  storage = await TestStorages.singleTenant(typeRegistry);
  settings =
    storage.url === undefined ? { kind: "memory" } : { kind: "postgresql", url: storage.url };
  ended = await EndedSessions.open(settings);
});

afterEach(async () => {
  await ended.close();
  await storage.drop();
});

describe("The sessions people ended should", () => {
  it("include a session once it is ended, and no other", async () => {
    await ended.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));

    expect(await ended.isRevoked("token-1")).toBe(true);
    expect(await ended.isRevoked("token-2")).toBe(false);
  });

  it("take a session ended twice", async () => {
    await ended.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));
    await ended.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));

    expect(await ended.isRevoked("token-1")).toBe(true);
  });

  it("forget a session once it would have expired", async () => {
    await ended.revoke("expired", timestampFromMs(Date.now() - HOUR_MS));
    await ended.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));

    expect(await ended.isRevoked("expired")).toBe(false);
    expect(await ended.isRevoked("token-1")).toBe(true);
  });

  it.runIf(TestStorages.profile() === "postgresql")(
    "still include an ended session when the gateway restarts, in PostgreSQL",
    async () => {
      await ended.revoke("token-1", timestampFromMs(Date.now() + HOUR_MS));
      await ended.close();

      ended = await EndedSessions.open(settings);

      expect(await ended.isRevoked("token-1")).toBe(true);
    },
  );
});
