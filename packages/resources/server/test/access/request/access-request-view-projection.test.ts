/*
 * Copyright 2026, TeamDev. All rights reserved.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { AccessRequestStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
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
} from "./given/access-request.js";

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
    expect(row?.manager.map((m) => m.uuid)).toEqual(["primary", "second"]);
    const kind = row?.snapshot?.kind;
    expect(kind?.case).toBe("newRequest");
    if (kind?.case === "newRequest") {
      expect(kind.value.resource?.uuid).toBe(resourceUuid);
    }
  });

  it("on 'AccessRequestApproved' move the request to approved", async () => {
    const box = await resourcesBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-approved", "primary");

    await approveAccessRequest(requester, "view-approved", "primary");

    await awaitStatus(box, requester, "view-approved", AccessRequestStatus.APPROVED);
  });

  it("on 'AccessRequestDenied' move the request to denied", async () => {
    const box = await resourcesBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-denied", "primary");

    await denyAccessRequest(requester, "view-denied", "primary", "Insufficient justification.");

    await awaitStatus(box, requester, "view-denied", AccessRequestStatus.DENIED);
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
