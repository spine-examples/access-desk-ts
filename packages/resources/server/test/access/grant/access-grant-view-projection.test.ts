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
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "../../given/resources-context.js";
import { resourceUuid } from "../request/given/access-request.js";
import {
  awaitGrantIssued,
  awaitGrantRevoked,
  awaitGrantView,
  approveExtension,
  issueGrant,
  minutesIn,
  readAccessHeldBy,
  readAccessTo,
  revokeGrant,
  seedGrantedResource,
  seedOtherResource,
  testClock,
} from "./given/resource-access.js";

// The projection is driven by managers approving requests, which issue and
// extend grants, and by revoking them. It is read through both of its queries:
// the access a person holds, and the access to a resource.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("AccessGrantViewProjection should", () => {
  it("list a grant to the person holding it and among its resource's access", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await seedGrantedResource(box);
    await seedOtherResource(box, "vault");

    await issueGrant(box, "grant-mine");
    await issueGrant(box, "grant-theirs", { grantee: "colleague" });
    await issueGrant(box, "grant-elsewhere", { resource: "vault" });

    const view = await awaitGrantIssued(box, scope, "grant-mine");
    expect(view.grantee?.uuid).toBe(actor);
    expect(view.resource?.uuid).toBe(resourceUuid);
    expect(view.accessLevel?.name).toBe("Read");
    expect(view.start).toEqual(minutesIn(0));
    expect(view.end).toEqual(minutesIn(60));
    expect(view.request?.uuid).toBe("grant-mine");
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

  it("show the new end of extended access, and the requests that extended it", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await seedGrantedResource(box);
    await issueGrant(box, "grant-extended");
    const issued = await awaitGrantIssued(box, scope, "grant-extended");
    expect(issued.extension).toHaveLength(0);

    await approveExtension(box, "ext-1", "grant-extended", 30);
    await awaitGrantView(
      box,
      scope,
      "grant-extended",
      (view) => view.end?.seconds === minutesIn(90).seconds,
    );
    await approveExtension(box, "ext-2", "grant-extended", 10);

    const view = await awaitGrantView(
      box,
      scope,
      "grant-extended",
      (item) => item.end?.seconds === minutesIn(100).seconds,
    );
    expect(view.extension.map((request) => request.uuid)).toEqual(["ext-1", "ext-2"]);
  });

  it("show revoked access as revoked", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await seedGrantedResource(box);
    await issueGrant(box, "grant-revoked");
    await awaitGrantIssued(box, scope, "grant-revoked");

    await revokeGrant(box, "grant-revoked", "primary", "Investigation finished.");

    const view = await awaitGrantRevoked(box, scope, "grant-revoked");
    expect(view.revoked).toBe(true);
    expect(view.end).toEqual(minutesIn(60));
  });
});
