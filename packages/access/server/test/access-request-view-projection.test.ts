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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { AccessRequestStatus } from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
  resourceUuid,
} from "./given/access-context.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  denyAccessRequest,
  readRequests,
  seed,
  statusOf,
  submitAndAssign,
} from "./given/access-request.js";

// The view reacts to the request's own lifecycle facts, produced here through
// the real submission-and-decision path.
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

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
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary", "second"], {
      policy: { manager: [{ uuid: "primary" }, { uuid: "second" }] },
    });

    await submitAndAssign(box, requester, "view-submitted", ["primary", "second"]);

    await awaitStatus(box, requester, "view-submitted", AccessRequestStatus.PENDING);
    const row = (await readRequests(requester)).find((r) => r.id?.uuid === "view-submitted");
    expect(row?.snapshot?.requester?.uuid).toBe(actor);
    expect(row?.candidateManager.map((m) => m.uuid)).toEqual(["primary", "second"]);
    const kind = row?.snapshot?.kind;
    expect(kind?.case).toBe("newRequest");
    if (kind?.case === "newRequest") {
      expect(kind.value.resource?.uuid).toBe(resourceUuid);
    }
  });

  it("on 'AccessRequestApproved' move the request to approved", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-approved", "primary");

    await approveAccessRequest(requester, "view-approved", "primary");

    await awaitStatus(box, requester, "view-approved", AccessRequestStatus.APPROVED);
  });

  it("on 'AccessRequestDenied' move the request to denied", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-denied", "primary");

    await denyAccessRequest(requester, "view-denied", "primary", "Insufficient justification.");

    await awaitStatus(box, requester, "view-denied", AccessRequestStatus.DENIED);
  });

  it("on 'AccessRequestCanceled' move the request to canceled", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "view-canceled", "primary");

    await cancelAccessRequest(requester, "view-canceled");

    await awaitStatus(box, requester, "view-canceled", AccessRequestStatus.CANCELED);
  });
});
