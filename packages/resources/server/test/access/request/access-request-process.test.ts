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
import { create } from "@bufbuild/protobuf";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { eventRecording } from "../../given/event-recording.js";
import {
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovedSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  AccessAlreadyHeldSchema,
  RequestedDurationTooLongSchema,
  AccessLevelNotOfferedSchema,
  RequestAlreadyPendingSchema,
  NotAnEligibleManagerSchema,
  RequestAlreadyDecidedSchema,
  ResourceNotOpenForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections_pb.js";
import { AccessGrantNotActiveSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  AccessLevelSchema,
  AccessRequestStatus,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
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
import {
  awaitGrantIssued,
  awaitGrantRevoked,
  awaitGrantView,
  givenActiveGrant,
  minutesIn,
  revokeGrant,
  testClock,
} from "../grant/given/access-grant.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The process manager keeps no queryable state, so each handler is observed
// through the facts it emits and the rejections it throws.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

/** Seeds one manager, submits a first-time request, and waits until it is assigned. */
async function givenPending(box: BlackBox, id: string): Promise<BlackBoxScope> {
  const requester = box.onBehalfOf(actor);
  await seed(box, [actor, "primary"]);
  await submitAndAssign(box, requester, id, "primary");
  return requester;
}

/** The payroll resource offering a weaker and a stronger level. */
const twoLevels = {
  accessLevel: [
    create(AccessLevelSchema, { name: "Read", rank: 1 }),
    create(AccessLevelSchema, { name: "Write", rank: 2 }),
  ],
};

/**
 * Has the requester of ten minutes of active access ask to extend it, and
 * waits until the extension is pending.
 */
async function givenPendingExtension(
  box: BlackBox,
  grant: string,
  extension: string,
): Promise<BlackBoxScope> {
  const requester = await givenActiveGrant(box, grant, 10);
  await requester.post(
    SubmitAccessExtensionRequestSchema,
    submitExtensionRequest(extension, { grant: { uuid: grant } }),
  );
  await box.eventually(
    () => statusOf(requester, extension),
    (status) => status === AccessRequestStatus.PENDING,
  );
  return requester;
}

/**
 * Has the requester ask for access over `[start, end)` minutes into the test and
 * `primary` approve it, and waits until the grant is issued.
 */
async function givenScheduledGrant(
  box: BlackBox,
  requester: BlackBoxScope,
  request: string,
  start: number,
  end: number,
): Promise<void> {
  await submitAndAssign(box, requester, request, "primary", {
    period: {
      kind: { case: "scheduled", value: { start: minutesIn(start), end: minutesIn(end) } },
    },
  });
  await approveAccessRequest(requester, request, "primary");
  await awaitGrantIssued(box, requester, request);
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
    it("submit a request with the authoritative level and deduplicated resource managers", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary", "second"], {
        policy: {
          accessLevel: [
            create(AccessLevelSchema, {
              name: "Reader",
              rank: 4,
              description: "View payroll entries.",
            }),
          ],
          manager: [
            { uuid: "second" },
            { uuid: "primary" },
            { uuid: "not-a-member" },
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

        const event = await submitted.waitFor(
          box,
          (submittedEvent) => submittedEvent.id?.uuid === "req-ok",
        );
        // Managers keep policy order and drop only the duplicate.
        expect(event.manager.map((manager) => manager.uuid)).toEqual([
          "second",
          "primary",
          "not-a-member",
          actor,
        ]);
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

    it("reject a resource that is not open ('ResourceNotOpenForRequests')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotOpenForRequestsSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-closed")),
      );
    });

    it("reject a level the policy does not offer ('AccessLevelNotOffered')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessLevelNotOfferedSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-level", { accessLevel: { name: "Admin", rank: 9 } }),
        ),
      );
    });

    it("reject an immediate duration beyond the maximum ('RequestedDurationTooLong')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, RequestedDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-toolong", {
            period: { kind: { case: "immediateDuration", value: { seconds: 7200n } } },
          }),
        ),
      );
    });

    it("reject a scheduled interval beyond the maximum ('RequestedDurationTooLong')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, RequestedDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-scheduled-long", {
            period: {
              kind: {
                case: "scheduled",
                value: { start: { seconds: 0n }, end: { seconds: 7200n } },
              },
            },
          }),
        ),
      );
    });

    it("reject a second pending request for the same requester and resource ('RequestAlreadyPending')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-first");
      await expectRejection(box, requester, RequestAlreadyPendingSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-second")),
      );
    });

    it("reject access already held for the requested period ('AccessAlreadyHeld')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-held", 10);

      await expectRejection(box, requester, AccessAlreadyHeldSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-held-again")),
      );
    });

    it("submit a request for a stronger level than the one held", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-read", 10, twoLevels);

      await submitAndAssign(box, requester, "req-write", "primary", {
        accessLevel: { name: "Write", rank: 2 },
      });
    });

    it("submit a request for a period starting when held access ends", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-first-slot", 10);

      await submitAndAssign(box, requester, "req-next-slot", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(10), end: minutesIn(20) } },
        },
      });
    });

    it("submit when the requester is the resource's sole manager", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
      try {
        expect(
          (await requester.post(SubmitAccessRequestSchema, submitRequest("req-self-managed"))).kind,
        ).toBe("ok");
        const event = await submitted.waitFor(
          box,
          (submittedEvent) => submittedEvent.id?.uuid === "req-self-managed",
        );
        expect(event.manager.map((manager) => manager.uuid)).toEqual([actor]);
      } finally {
        await submitted.cancel();
      }
    });

    it("free the requester and resource after a cancellation so a resubmission is admitted", async () => {
      const box = await resourcesBlackBox();
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
    it("submit an extension of active access, fixing the proposed end", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-renewed", 10);
      const submitted = await recordEvents(requester, AccessExtensionRequestSubmittedSchema);
      try {
        expect(
          (
            await requester.post(
              SubmitAccessExtensionRequestSchema,
              submitExtensionRequest("ext-ok", { grant: { uuid: "req-renewed" } }),
            )
          ).kind,
        ).toBe("ok");

        const event = await submitted.waitFor(
          box,
          (submittedEvent) => submittedEvent.id?.uuid === "ext-ok",
        );
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
        const kind = event.snapshot?.kind;
        expect(kind?.case).toBe("extension");
        if (kind?.case === "extension") {
          expect(kind.value.grant?.uuid).toBe("req-renewed");
          expect(kind.value.proposedEnd).toEqual(minutesIn(12));
        }
      } finally {
        await submitted.cancel();
      }
    });

    it("reject a resource that is not open ('ResourceNotOpenForRequests')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotOpenForRequestsSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-closed")),
      );
    });

    it("reject a grant the requester does not hold ('AccessGrantNotActive')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessGrantNotActiveSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-unheld")),
      );
    });

    it("reject a grant that was revoked ('AccessGrantNotActive')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-revoked", 10);
      await revokeGrant(requester, "req-revoked", "primary", "No longer needed.");
      await awaitGrantRevoked(box, requester, "req-revoked");

      await expectRejection(box, requester, AccessGrantNotActiveSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-revoked", { grant: { uuid: "req-revoked" } }),
        ),
      );
    });

    it("reject a grant whose access has not yet begun ('AccessGrantNotActive')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      await givenScheduledGrant(box, requester, "req-not-begun", 30, 60);

      await expectRejection(box, requester, AccessGrantNotActiveSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-not-begun", { grant: { uuid: "req-not-begun" } }),
        ),
      );
    });

    it("reject a grant whose access has ended ('AccessGrantNotActive')", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenActiveGrant(box, "req-ended", 10);
      clock.advanceMinutes(10);

      await expectRejection(box, requester, AccessGrantNotActiveSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-ended", { grant: { uuid: "req-ended" } }),
        ),
      );
    });

    it("reject extending into access another grant already confers ('AccessAlreadyHeld')", async () => {
      // Held: [0, 10) and, through another grant, [10, 20). Extending the first overlaps the second.
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-this-slot", 10);
      await givenScheduledGrant(box, requester, "req-next-slot", 10, 20);

      await expectRejection(box, requester, AccessAlreadyHeldSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-into-next", {
            grant: { uuid: "req-this-slot" },
            duration: { seconds: 600n },
          }),
        ),
      );
    });

    it("reject access lasting longer in total than the resource permits ('RequestedDurationTooLong')", async () => {
      // Ten minutes held plus fifty-one more exceeds the default hour.
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-long", 10);
      await expectRejection(box, requester, RequestedDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-toolong", {
            grant: { uuid: "req-long" },
            duration: { seconds: 3060n },
          }),
        ),
      );
    });

    it("reject a second pending extension for the same requester and grant ('RequestAlreadyPending')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-extended", 10);
      const extension = { grant: { uuid: "req-extended" } };
      expect(
        (
          await requester.post(
            SubmitAccessExtensionRequestSchema,
            submitExtensionRequest("ext-first", extension),
          )
        ).kind,
      ).toBe("ok");
      await box.eventually(
        () => statusOf(requester, "ext-first"),
        (status) => status === AccessRequestStatus.PENDING,
      );

      await expectRejection(box, requester, RequestAlreadyPendingSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-second", extension),
        ),
      );
    });
  });

  describe("handle 'ApproveAccessRequest', and", () => {
    it("emit 'AccessRequestApproved' recording the deciding manager", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-approve");
      const approved = await recordEvents(requester, AccessRequestApprovedSchema);
      try {
        expect((await approveAccessRequest(requester, "req-approve", "primary")).kind).toBe("ok");
        const event = await approved.waitFor(
          box,
          (approvedEvent) => approvedEvent.id?.uuid === "req-approve",
        );
        expect(event.decidedBy?.uuid).toBe("primary");
      } finally {
        await approved.cancel();
      }
    });

    it("reject a decider outside the manager pool ('NotAnEligibleManager')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-outsider");
      await expectRejection(box, requester, NotAnEligibleManagerSchema, () =>
        approveAccessRequest(requester, "req-outsider", "outsider"),
      );
    });

    it("allow a requester who manages the resource to approve their own request", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await submitAndAssign(box, requester, "req-self", actor);

      expect((await approveAccessRequest(requester, "req-self", actor)).kind).toBe("ok");
      await box.eventually(
        () => statusOf(requester, "req-self"),
        (status) => status === AccessRequestStatus.APPROVED,
      );
    });

    it("reject access the requester came to hold after submitting ('AccessAlreadyHeld')", async () => {
      // Held: [0, 10). Requested: [20, 30), clear of it when submitted.
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-held", 10);
      await requester.post(
        SubmitAccessExtensionRequestSchema,
        submitExtensionRequest("ext-overlap", {
          grant: { uuid: "req-held" },
          duration: { seconds: 900n },
        }),
      );
      await submitAndAssign(box, requester, "req-later", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(20), end: minutesIn(30) } },
        },
      });

      // The extension moves the held end to 25, into the requested period.
      await approveAccessRequest(requester, "ext-overlap", "primary");
      await awaitGrantView(
        box,
        requester,
        "req-held",
        (item) => item.end?.seconds === minutesIn(25).seconds,
      );

      await expectRejection(box, requester, AccessAlreadyHeldSchema, () =>
        approveAccessRequest(requester, "req-later", "primary"),
      );
      expect(await statusOf(requester, "req-later")).toBe(AccessRequestStatus.PENDING);
    });

    it("reject an extension into access granted since it was submitted ('AccessAlreadyHeld')", async () => {
      // The extension would move the held end from 10 to 12, into [10, 20) granted since.
      const box = await resourcesBlackBox(testClock());
      const requester = await givenPendingExtension(box, "req-before-next", "ext-overtaken");
      await givenScheduledGrant(box, requester, "req-granted-since", 10, 20);

      await expectRejection(box, requester, AccessAlreadyHeldSchema, () =>
        approveAccessRequest(requester, "ext-overtaken", "primary"),
      );
      expect(await statusOf(requester, "ext-overtaken")).toBe(AccessRequestStatus.PENDING);
    });

    it("reject an extension of access revoked since it was submitted ('AccessGrantNotActive')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenPendingExtension(box, "req-revoked-since", "ext-too-late");
      await revokeGrant(requester, "req-revoked-since", "primary", "No longer needed.");
      await awaitGrantRevoked(box, requester, "req-revoked-since");

      await expectRejection(box, requester, AccessGrantNotActiveSchema, () =>
        approveAccessRequest(requester, "ext-too-late", "primary"),
      );
      expect(await statusOf(requester, "ext-too-late")).toBe(AccessRequestStatus.PENDING);
    });

    it("reject a decision on an already-decided request ('RequestAlreadyDecided')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-twice");
      await givenApproved(box, requester, "req-twice");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        approveAccessRequest(requester, "req-twice", "primary"),
      );
    });
  });

  describe("handle 'DenyAccessRequest', and", () => {
    it("emit 'AccessRequestDenied' carrying the reason and the deciding manager", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-deny");
      const denied = await recordEvents(requester, AccessRequestDeniedSchema);
      try {
        expect(
          (await denyAccessRequest(requester, "req-deny", "primary", "Insufficient justification."))
            .kind,
        ).toBe("ok");
        const event = await denied.waitFor(
          box,
          (deniedEvent) => deniedEvent.id?.uuid === "req-deny",
        );
        expect(event.decidedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Insufficient justification.");
      } finally {
        await denied.cancel();
      }
    });

    it("allow a requester who manages the resource to deny their own request", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await submitAndAssign(box, requester, "req-deny-self", actor);

      expect(
        (await denyAccessRequest(requester, "req-deny-self", actor, "Changed my mind.")).kind,
      ).toBe("ok");
      await box.eventually(
        () => statusOf(requester, "req-deny-self"),
        (status) => status === AccessRequestStatus.DENIED,
      );
    });

    it("reject a decision on an already-decided request ('RequestAlreadyDecided')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-deny-twice");
      await givenApproved(box, requester, "req-deny-twice");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        denyAccessRequest(requester, "req-deny-twice", "primary", "Too late."),
      );
    });
  });

  describe("handle 'CancelAccessRequest', and", () => {
    it("cancel a pending request and clear its decision task", async () => {
      const box = await resourcesBlackBox();
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
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-cancel-decided");
      await givenApproved(box, requester, "req-cancel-decided");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        cancelAccessRequest(requester, "req-cancel-decided"),
      );
    });
  });
});
