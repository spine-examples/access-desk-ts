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

import {
  AccessRequestApprovedSchema,
  AccessRequestCancelledSchema,
  AccessRequestCreatedSchema,
  AccessRequestDeniedSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import {
  ManagerNotEligibleSchema,
  RequestAlreadyDecidedSchema,
  SelfApprovalNotAllowedSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_rejections_pb.js";

import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
} from "./given/access-context.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  createAccessRequest,
  denyAccessRequest,
  givenCreatedRequest,
} from "./given/access-request.js";
import { expectRejection, recordEvents } from "./given/events.js";

// The aggregate's commands are posted directly, bypassing the submission process,
// so each handler's own event and rejections are verified in isolation.
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

/** Approves a request as candidate manager `manager` and waits until it is terminal. */
async function givenApproved(
  box: BlackBox,
  scope: BlackBoxScope,
  id: string,
  manager: string,
): Promise<void> {
  const approved = await recordEvents(scope, AccessRequestApprovedSchema);
  try {
    expect((await approveAccessRequest(scope, id, manager)).kind).toBe("ok");
    await approved.waitFor(box, (event) => event.id?.uuid === id);
  } finally {
    await approved.cancel();
  }
}

describe("AccessRequestAggregate should", () => {
  describe("handle 'CreateAccessRequest', and", () => {
    it("emit 'AccessRequestCreated' carrying the request snapshot and manager pool", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      const events = await recordEvents(requester, AccessRequestCreatedSchema);
      try {
        expect(
          (await createAccessRequest(requester, "req-create", { candidateManager: ["primary", "fallback"] }))
            .kind,
        ).toBe("ok");

        const event = await events.waitFor(box, (candidate) => candidate.id?.uuid === "req-create");
        expect(event.snapshot?.requester?.uuid).toBe(actor);
        expect(event.snapshot?.justification).toBe("Need payroll review");
        expect(event.snapshot?.kind.case).toBe("newRequest");
        expect(event.candidateManager.map((manager) => manager.uuid)).toEqual(["primary", "fallback"]);
      } finally {
        await events.cancel();
      }
    });
  });

  describe("handle 'ApproveAccessRequest', and", () => {
    it("emit 'AccessRequestApproved' recording the deciding manager", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-approve", { candidateManager: ["primary"] });
      const manager = box.onBehalfOf("primary");
      const events = await recordEvents(manager, AccessRequestApprovedSchema);
      try {
        expect((await approveAccessRequest(manager, "req-approve", "primary")).kind).toBe("ok");

        const event = await events.waitFor(box, (candidate) => candidate.id?.uuid === "req-approve");
        expect(event.decidedBy?.uuid).toBe("primary");
        expect(event.candidateManager.map((who) => who.uuid)).toEqual(["primary"]);
      } finally {
        await events.cancel();
      }
    });

    it("reject a decider outside the candidate pool with 'ManagerNotEligible'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-approve-outsider", { candidateManager: ["primary"] });
      const outsider = box.onBehalfOf("outsider");

      await expectRejection(box, outsider, ManagerNotEligibleSchema, () =>
        approveAccessRequest(outsider, "req-approve-outsider", "outsider"),
      );
    });

    it("reject the requester deciding their own request with 'SelfApprovalNotAllowed'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-approve-self", { candidateManager: ["primary"] });

      await expectRejection(box, requester, SelfApprovalNotAllowedSchema, () =>
        approveAccessRequest(requester, "req-approve-self", actor),
      );
    });

    it("reject a decision on an already-decided request with 'RequestAlreadyDecided'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-approve-twice", { candidateManager: ["primary"] });
      const manager = box.onBehalfOf("primary");
      await givenApproved(box, manager, "req-approve-twice", "primary");

      await expectRejection(box, manager, RequestAlreadyDecidedSchema, () =>
        approveAccessRequest(manager, "req-approve-twice", "primary"),
      );
    });
  });

  describe("handle 'DenyAccessRequest', and", () => {
    it("emit 'AccessRequestDenied' carrying the reason and deciding manager", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-deny", { candidateManager: ["primary"] });
      const manager = box.onBehalfOf("primary");
      const events = await recordEvents(manager, AccessRequestDeniedSchema);
      try {
        expect(
          (await denyAccessRequest(manager, "req-deny", "primary", "Insufficient justification.")).kind,
        ).toBe("ok");

        const event = await events.waitFor(box, (candidate) => candidate.id?.uuid === "req-deny");
        expect(event.decidedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Insufficient justification.");
      } finally {
        await events.cancel();
      }
    });

    it("reject a decider outside the candidate pool with 'ManagerNotEligible'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-deny-outsider", { candidateManager: ["primary"] });
      const outsider = box.onBehalfOf("outsider");

      await expectRejection(box, outsider, ManagerNotEligibleSchema, () =>
        denyAccessRequest(outsider, "req-deny-outsider", "outsider", "Not your call."),
      );
    });

    it("reject the requester deciding their own request with 'SelfApprovalNotAllowed'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-deny-self", { candidateManager: ["primary"] });

      await expectRejection(box, requester, SelfApprovalNotAllowedSchema, () =>
        denyAccessRequest(requester, "req-deny-self", actor, "Changed my mind."),
      );
    });

    it("reject a decision on an already-decided request with 'RequestAlreadyDecided'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-deny-twice", { candidateManager: ["primary"] });
      const manager = box.onBehalfOf("primary");
      await givenApproved(box, manager, "req-deny-twice", "primary");

      await expectRejection(box, manager, RequestAlreadyDecidedSchema, () =>
        denyAccessRequest(manager, "req-deny-twice", "primary", "Too late."),
      );
    });
  });

  describe("handle 'CancelAccessRequest', and", () => {
    it("emit 'AccessRequestCancelled' retaining the request snapshot", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-cancel", { candidateManager: ["primary"] });
      const events = await recordEvents(requester, AccessRequestCancelledSchema);
      try {
        expect((await cancelAccessRequest(requester, "req-cancel")).kind).toBe("ok");

        const event = await events.waitFor(box, (candidate) => candidate.id?.uuid === "req-cancel");
        expect(event.snapshot?.requester?.uuid).toBe(actor);
        expect(event.candidateManager.map((who) => who.uuid)).toEqual(["primary"]);
      } finally {
        await events.cancel();
      }
    });

    it("reject cancelling an already-decided request with 'RequestAlreadyDecided'", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await givenCreatedRequest(box, requester, "req-cancel-decided", { candidateManager: ["primary"] });
      await givenApproved(box, box.onBehalfOf("primary"), "req-cancel-decided", "primary");

      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        cancelAccessRequest(requester, "req-cancel-decided"),
      );
    });
  });
});
