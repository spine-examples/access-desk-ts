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
import { eventRecording } from "@access-desk/base/testing";
import {
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovedSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import {
  AccessDurationTooLongSchema,
  AccessLevelNotAvailableSchema,
  DuplicateAccessRequestSchema,
  ManagerNotEligibleSchema,
  NoManagersEligibleSchema,
  RequestAlreadyDecidedSchema,
  ResourceNotRequestableSchema,
  SelfDecisionNotAllowedSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_rejections_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_commands_pb.js";
import { AccessRequestStatus } from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
  testActorContext,
} from "./given/access-context.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  denyAccessRequest,
  seed,
  statusOf,
  submitAndAssign,
  submitExtensionRequest,
  submitRequest,
} from "./given/access-request.js";
import { managerHasTask } from "./given/access-decision-assignment.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The process manager keeps no queryable state, so each handler is observed
// through the facts it emits and the rejections it throws.
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

/** Seeds one manager, submits a first-time request, and waits until it is assigned. */
async function givenPending(box: BlackBox, id: string): Promise<BlackBoxScope> {
  const requester = box.onBehalfOf(actor);
  await seed(box, [actor, "primary"]);
  await submitAndAssign(box, requester, id, "primary");
  return requester;
}

/** Approves a request and waits until it is terminal. */
async function givenApproved(box: BlackBox, requester: BlackBoxScope, id: string): Promise<void> {
  await approveAccessRequest(requester, id, "primary");
  await box.eventually(
    () => statusOf(requester, id),
    (status) => status === AccessRequestStatus.APPROVED,
  );
}

describe("AccessRequestProcessManager should", () => {
  describe("handle 'SubmitAccessRequest', and", () => {
    it("submit a request, emitting 'AccessRequestSubmitted' with the authoritative level and the deduped, active, non-requester managers", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary", "second", { person: "inactive", active: false }], {
        policy: {
          accessLevel: [{ name: "Reader", rank: 4, description: "View payroll entries." }],
          manager: [
            { uuid: "second" },
            { uuid: "primary" },
            { uuid: "inactive" },
            { uuid: "second" },
            { uuid: actor },
          ],
        },
      });
      const requester = box.onBehalfOf(actor);
      const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
      try {
        expect(
          (
            await requester.post(
              SubmitAccessRequestSchema,
              submitRequest("req-ok", { accessLevel: { name: " reader ", rank: 4 } }),
            )
          ).kind,
        ).toBe("ok");

        const event = await submitted.waitFor(box, (candidate) => candidate.id?.uuid === "req-ok");
        // Managers keep policy order, drop the duplicate, the inactive member, and the requester.
        expect(event.candidateManager.map((manager) => manager.uuid)).toEqual(["second", "primary"]);
        const kind = event.snapshot?.kind;
        expect(kind?.case).toBe("newRequest");
        if (kind?.case === "newRequest") {
          // The authoritative policy level is recorded, not the client's spelling.
          expect(kind.value.accessLevel?.name).toBe("Reader");
        }
      } finally {
        await submitted.cancel();
      }
    });

    it("reject a resource that is not open ('ResourceNotRequestable')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotRequestableSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-closed")),
      );
    });

    it("reject a level the policy does not offer ('AccessLevelNotAvailable')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessLevelNotAvailableSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-level", { accessLevel: { name: "Admin", rank: 9 } }),
        ),
      );
    });

    it("reject an immediate duration beyond the maximum ('AccessDurationTooLong')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-toolong", {
            period: { kind: { case: "immediateDuration", value: { seconds: 7200n } } },
          }),
        ),
      );
    });

    it("reject a scheduled interval beyond the maximum ('AccessDurationTooLong')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-scheduled-long", {
            period: {
              kind: { case: "scheduled", value: { start: { seconds: 0n }, end: { seconds: 7200n } } },
            },
          }),
        ),
      );
    });

    it("reject a second pending request for the same requester and resource ('DuplicateAccessRequest')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-first");
      await expectRejection(box, requester, DuplicateAccessRequestSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-second")),
      );
    });

    it("reject a request when no active manager is eligible ('NoManagersEligible')", async () => {
      const box = await accessBlackBox();
      // The only member is the requester, who is also the resource's sole manager.
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, NoManagersEligibleSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-nomanager")),
      );
    });

    it("free the requester and resource after a cancellation so a resubmission is admitted", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-original");
      await cancelAccessRequest(requester, "req-original");
      await box.eventually(
        () => statusOf(requester, "req-original"),
        (status) => status === AccessRequestStatus.CANCELED,
      );

      await submitAndAssign(box, requester, "req-resubmit", "primary");
      expect(await managerHasTask(requester, "primary", "req-resubmit")).toBe(true);
    });
  });

  describe("handle 'SubmitAccessExtensionRequest', and", () => {
    it("submit a renewal, emitting 'AccessExtensionRequestSubmitted' with the extension snapshot", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      const submitted = await recordEvents(requester, AccessExtensionRequestSubmittedSchema);
      try {
        expect(
          (await requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-ok")))
            .kind,
        ).toBe("ok");

        const event = await submitted.waitFor(box, (candidate) => candidate.id?.uuid === "ext-ok");
        expect(event.candidateManager.map((manager) => manager.uuid)).toEqual(["primary"]);
        const kind = event.snapshot?.kind;
        expect(kind?.case).toBe("extension");
        if (kind?.case === "extension") {
          expect(kind.value.grant?.uuid).toBe("grant-1");
          expect(kind.value.duration?.seconds).toBe(120n);
        }
      } finally {
        await submitted.cancel();
      }
    });

    it("reject a resource that is not open ('ResourceNotRequestable')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotRequestableSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-closed")),
      );
    });

    it("reject an added duration beyond the maximum ('AccessDurationTooLong')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-toolong", { duration: { seconds: 7200n } }),
        ),
      );
    });

    it("reject a renewal when no active manager is eligible ('NoManagersEligible')", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, NoManagersEligibleSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-nomanager")),
      );
    });
  });

  describe("handle 'ApproveAccessRequest', and", () => {
    it("emit 'AccessRequestApproved' recording the deciding manager", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-approve");
      const approved = await recordEvents(requester, AccessRequestApprovedSchema);
      try {
        expect((await approveAccessRequest(requester, "req-approve", "primary")).kind).toBe("ok");
        const event = await approved.waitFor(box, (candidate) => candidate.id?.uuid === "req-approve");
        expect(event.decidedBy?.uuid).toBe("primary");
      } finally {
        await approved.cancel();
      }
    });

    it("reject a decider outside the candidate pool ('ManagerNotEligible')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-outsider");
      await expectRejection(box, requester, ManagerNotEligibleSchema, () =>
        approveAccessRequest(requester, "req-outsider", "outsider"),
      );
    });

    it("reject the requester deciding their own request ('SelfDecisionNotAllowed')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-self");
      await expectRejection(box, requester, SelfDecisionNotAllowedSchema, () =>
        approveAccessRequest(requester, "req-self", actor),
      );
    });

    it("reject a decision on an already-decided request ('RequestAlreadyDecided')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-twice");
      await givenApproved(box, requester, "req-twice");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        approveAccessRequest(requester, "req-twice", "primary"),
      );
    });
  });

  describe("handle 'DenyAccessRequest', and", () => {
    it("emit 'AccessRequestDenied' carrying the reason and the deciding manager", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-deny");
      const denied = await recordEvents(requester, AccessRequestDeniedSchema);
      try {
        expect(
          (await denyAccessRequest(requester, "req-deny", "primary", "Insufficient justification."))
            .kind,
        ).toBe("ok");
        const event = await denied.waitFor(box, (candidate) => candidate.id?.uuid === "req-deny");
        expect(event.decidedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Insufficient justification.");
      } finally {
        await denied.cancel();
      }
    });

    it("reject the requester deciding their own request ('SelfDecisionNotAllowed')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-deny-self");
      await expectRejection(box, requester, SelfDecisionNotAllowedSchema, () =>
        denyAccessRequest(requester, "req-deny-self", actor, "Changed my mind."),
      );
    });

    it("reject a decision on an already-decided request ('RequestAlreadyDecided')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-deny-twice");
      await givenApproved(box, requester, "req-deny-twice");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        denyAccessRequest(requester, "req-deny-twice", "primary", "Too late."),
      );
    });
  });

  describe("handle 'CancelAccessRequest', and", () => {
    it("cancel a pending request and clear its decision task", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-cancel");

      await cancelAccessRequest(requester, "req-cancel");

      await box.eventually(
        () => statusOf(requester, "req-cancel"),
        (status) => status === AccessRequestStatus.CANCELED,
      );
      await box.eventually(
        () => managerHasTask(requester, "primary", "req-cancel"),
        (present) => !present,
      );
    });

    it("reject cancelling an already-decided request ('RequestAlreadyDecided')", async () => {
      const box = await accessBlackBox();
      const requester = await givenPending(box, "req-cancel-decided");
      await givenApproved(box, requester, "req-cancel-decided");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        cancelAccessRequest(requester, "req-cancel-decided"),
      );
    });
  });
});
