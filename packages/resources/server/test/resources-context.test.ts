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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccessRequestStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import {
  awaitGrantRevoked,
  givenActiveGrant,
  readAccessHeldBy,
  revokeGrant,
  testClock,
} from "./access/grant/given/resource-access.js";
import { statusOf } from "./access/request/given/access-request.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  storageOf,
} from "./given/resources-context.js";

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourcesContext should", () => {
  it("know every request and grant again once it starts over its storage, and act on them", async () => {
    const clock = testClock();
    const before = await resourcesBlackBox(clock);
    await givenActiveGrant(before, "req-kept");
    await before.close();

    const after = await resourcesBlackBox(clock, storageOf(before));
    const requester = after.onBehalfOf(actor);

    expect(await statusOf(requester, "req-kept")).toBe(AccessRequestStatus.APPROVED);
    expect((await readAccessHeldBy(requester)).map((grant) => grant.id?.uuid)).toEqual([
      "req-kept",
    ]);
    expect((await revokeGrant(after, "req-kept", "primary", "No longer needed.")).kind).toBe("ok");
    expect((await awaitGrantRevoked(after, requester, "req-kept")).revoked).toBe(true);
  });
});
