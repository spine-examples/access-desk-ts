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
import { AccessGrantStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "../../given/resources-context.js";
import { resourceUuid } from "../request/given/access-request.js";
import {
  awaitGrantStatus,
  awaitGrantView,
  createGrant,
  expireGrant,
  extendGrant,
  minutesIn,
  readAccessHeldBy,
  readAccessTo,
  revokeGrant,
  testClock,
} from "./given/access-grant.js";

// The projection is driven by posting the grant's own commands, and read
// through both of its queries: the access a person holds, and the access to a
// resource.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("AccessGrantViewProjection should", () => {
  it("list a grant to the person holding it and among its resource's access", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);

    await createGrant(scope, "grant-mine", { request: { uuid: "req-mine" } });
    await createGrant(scope, "grant-theirs", {
      access: {
        grantee: { uuid: "colleague" },
        resource: { uuid: resourceUuid },
        accessLevel: { name: "Read", rank: 1 },
      },
    });
    await createGrant(scope, "grant-elsewhere", {
      access: {
        grantee: { uuid: actor },
        resource: { uuid: "vault" },
        accessLevel: { name: "Read", rank: 1 },
      },
    });

    const view = await awaitGrantStatus(box, scope, "grant-mine", AccessGrantStatus.ACTIVE);
    expect(view.grantee?.uuid).toBe(actor);
    expect(view.resource?.uuid).toBe(resourceUuid);
    expect(view.accessLevel?.name).toBe("Read");
    expect(view.start).toEqual(minutesIn(0));
    expect(view.end).toEqual(minutesIn(60));
    expect(view.request?.uuid).toBe("req-mine");
    await box.eventually(
      () => readAccessTo(scope),
      (rows) => rows.some((row) => row.id?.uuid === "grant-theirs"),
    );
    await box.eventually(
      () => readAccessHeldBy(scope),
      (rows) => rows.some((row) => row.id?.uuid === "grant-elsewhere"),
    );

    const held = await readAccessHeldBy(scope);
    const toPayroll = await readAccessTo(scope);
    expect(held.map((row) => row.id?.uuid).sort()).toEqual(["grant-elsewhere", "grant-mine"]);
    expect(toPayroll.map((row) => row.id?.uuid).sort()).toEqual(["grant-mine", "grant-theirs"]);
  });

  it("show the new end of extended access", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await createGrant(scope, "grant-extended");
    await awaitGrantStatus(box, scope, "grant-extended", AccessGrantStatus.ACTIVE);

    await extendGrant(scope, "grant-extended", "ext-1", minutesIn(90));

    await awaitGrantView(
      box,
      scope,
      "grant-extended",
      (view) => view.end?.seconds === minutesIn(90).seconds,
    );
  });

  it("move expired access to history", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const scope = box.onBehalfOf(actor);
    await createGrant(scope, "grant-expired");
    await awaitGrantStatus(box, scope, "grant-expired", AccessGrantStatus.ACTIVE);

    clock.advanceMinutes(60);
    await expireGrant(scope, "grant-expired");

    await awaitGrantStatus(box, scope, "grant-expired", AccessGrantStatus.EXPIRED);
  });

  it("move revoked access to history", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await createGrant(scope, "grant-revoked");
    await awaitGrantStatus(box, scope, "grant-revoked", AccessGrantStatus.ACTIVE);

    await revokeGrant(scope, "grant-revoked", "primary", "Investigation finished.");

    await awaitGrantStatus(box, scope, "grant-revoked", AccessGrantStatus.REVOKED);
  });
});
