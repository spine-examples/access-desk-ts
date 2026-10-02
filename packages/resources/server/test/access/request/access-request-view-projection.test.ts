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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { AccessRequestStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { SubmitAccessExtensionRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "../../given/resources-context.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  denyAccessRequest,
  readRequests,
  resourceUuid,
  seed,
  statusOf,
  submitAndAssign,
  submitExtensionRequest,
} from "./given/access-request.js";
import { givenActiveGrant, minutesIn, testClock } from "../grant/given/resource-access.js";

// The view reacts to the request's own lifecycle facts, produced here through
// the real submission-and-decision path.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

/** Waits until the view shows `id` at `status`. */
function awaitStatus(
  box: BlackBox,
  reader: BlackBoxScope,
  id: string,
  status: AccessRequestStatus,
): Promise<AccessRequestStatus | undefined> {
  return box.eventually(
    () => statusOf(reader, id),
    (current) => current === status,
  );
}

describe("AccessRequestViewProjection should", () => {
  it("on 'AccessRequestSubmitted' expose the request as pending with its details", async () => {
    const box = await resourcesBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary", "second"], {
      policy: { manager: [{ uuid: "primary" }, { uuid: "second" }] },
    });

    await submitAndAssign(box, requester, "view-submitted", ["primary", "second"]);

    await awaitStatus(box, requester, "view-submitted", AccessRequestStatus.PENDING);
    const row = (await readRequests(requester)).find((r) => r.id?.uuid === "view-submitted");
    expect(row?.snapshot?.requester?.uuid).toBe(actor);
    const kind = row?.snapshot?.kind;
    expect(kind?.case).toBe("newRequest");
    if (kind?.case === "newRequest") {
      expect(kind.value.resource?.uuid).toBe(resourceUuid);
    }
  });

  it("on 'AccessRequestApproved' move the request to approved, recording who approved it and when", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-approved", "primary");
    clock.advanceMinutes(5);

    await approveAccessRequest(box, "view-approved", "primary");

    await awaitStatus(box, requester, "view-approved", AccessRequestStatus.APPROVED);
    const row = (await readRequests(requester)).find((r) => r.id?.uuid === "view-approved");
    expect(row?.decidedBy?.uuid).toBe("primary");
    expect(row?.whenDecided).toEqual(minutesIn(5));
  });

  it("on 'AccessRequestApprovalFailed' move the request to approval failed", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = await givenActiveGrant(box, "view-grant", 10);
    await requester.post(
      SubmitAccessExtensionRequestSchema,
      submitExtensionRequest("view-failed", { grant: { uuid: "view-grant" } }),
    );
    await awaitStatus(box, requester, "view-failed", AccessRequestStatus.PENDING);
    clock.advanceMinutes(10);

    await approveAccessRequest(box, "view-failed", "primary");

    await awaitStatus(box, requester, "view-failed", AccessRequestStatus.APPROVAL_FAILED);
    const row = (await readRequests(requester)).find((r) => r.id?.uuid === "view-failed");
    expect(row?.decidedBy?.uuid).toBe("primary");
    expect(row?.whenDecided).toEqual(minutesIn(10));
  });

  it("on 'AccessRequestDenied' move the request to denied, recording who denied it and when", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-denied", "primary");
    clock.advanceMinutes(5);

    await denyAccessRequest(box, "view-denied", "primary", "Insufficient justification.");

    await awaitStatus(box, requester, "view-denied", AccessRequestStatus.DENIED);
    const row = (await readRequests(requester)).find((r) => r.id?.uuid === "view-denied");
    expect(row?.decidedBy?.uuid).toBe("primary");
    expect(row?.whenDecided).toEqual(minutesIn(5));
  });

  it("on 'AccessRequestCanceled' move the request to canceled", async () => {
    const box = await resourcesBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-canceled", "primary");

    await cancelAccessRequest(requester, "view-canceled");

    await awaitStatus(box, requester, "view-canceled", AccessRequestStatus.CANCELED);
  });
});
