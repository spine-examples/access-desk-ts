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
  AccessExtensionRequestSubmissionFailedSchema,
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovalFailedSchema,
  AccessRequestApprovalStartedSchema,
  AccessRequestApprovedSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmissionFailedSchema,
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
  givenActiveGrant,
  minutesIn,
  revokeGrant,
  testClock,
} from "../grant/given/resource-access.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// Each handler is observed through the facts it emits and the rejections it
// throws. A command the process refuses as malformed emits neither, so its
// refusal is proven by a later command that only a refused one explains.
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
  await approveAccessRequest(box, request, "primary");
  await awaitGrantIssued(box, requester, request);
}

/**
 * Proves that no request was submitted under the identifier: a request that was
 * never submitted cannot be cancelled, as though it were already decided.
 */
async function expectNotSubmitted(
  box: BlackBox,
  requester: BlackBoxScope,
  id: string,
): Promise<void> {
  await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
    cancelAccessRequest(requester, id),
  );
}

/** Approves a request and waits until it is terminal. */
async function givenApproved(box: BlackBox, requester: BlackBoxScope, id: string): Promise<void> {
  await approveAccessRequest(box, id, "primary");
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
                value: { start: { seconds: 3600n }, end: { seconds: 10800n } },
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

    it("refuse reuse of a request identifier", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-reused");
      const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
      try {
        await requester.post(SubmitAccessRequestSchema, submitRequest("req-reused"));
        await requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("req-reused", { grant: { uuid: "grant-unused" } }),
        );
        await cancelAccessRequest(requester, "req-reused");

        await box.eventually(
          () => statusOf(requester, "req-reused"),
          (status) => status === AccessRequestStatus.CANCELED,
        );
        expect(submitted.received).toHaveLength(0);
      } finally {
        await submitted.cancel();
      }
    });

    it("reject access already held for the requested period ('AccessAlreadyHeld')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-held", 10);

      await expectRejection(box, requester, AccessAlreadyHeldSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-held-again")),
      );
    });

    it("fail the submission of a request for access already held", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-held-first", 10);
      const failed = await recordEvents(requester, AccessRequestSubmissionFailedSchema);
      const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
      try {
        await requester.post(SubmitAccessRequestSchema, submitRequest("req-held-second"));

        const event = await failed.waitFor(box, (e) => e.id?.uuid === "req-held-second");
        expect(event.requester?.uuid).toBe(actor);
        expect(submitted.received.map((e) => e.id?.uuid)).not.toContain("req-held-second");
        expect(await statusOf(requester, "req-held-second")).toBeUndefined();
      } finally {
        await failed.cancel();
        await submitted.cancel();
      }
    });

    it("submit a request for a stronger level than the one held", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-read", 10, twoLevels);

      await submitAndAssign(box, requester, "req-write", "primary", {
        accessLevel: { name: "Write", rank: 2 },
      });

      expect(await statusOf(requester, "req-write")).toBe(AccessRequestStatus.PENDING);
    });

    it("submit a request for a period starting when held access ends", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-first-slot", 10);

      await submitAndAssign(box, requester, "req-next-slot", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(10), end: minutesIn(20) } },
        },
      });

      expect(await statusOf(requester, "req-next-slot")).toBe(AccessRequestStatus.PENDING);
    });

    it("submit a request for a scheduled period that is already over", async () => {
      const box = await resourcesBlackBox(testClock());
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);

      await submitAndAssign(box, requester, "req-already-over", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(-30), end: minutesIn(-10) } },
        },
      });

      expect(await statusOf(requester, "req-already-over")).toBe(AccessRequestStatus.PENDING);
    });

    it("submit a request for a period overlapping access that has ended", async () => {
      // Held: [0, 10), which is over by minute 10. Requested: [5, 30).
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenActiveGrant(box, "req-over-by-now", 10);
      clock.advanceMinutes(10);

      await submitAndAssign(box, requester, "req-across-ended", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(5), end: minutesIn(30) } },
        },
      });

      expect(await statusOf(requester, "req-across-ended")).toBe(AccessRequestStatus.PENDING);
    });

    it("reject a request for a resource whose access awaits an extension ('RequestAlreadyPending')", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenPendingExtension(box, "req-being-extended", "ext-awaiting");

      await expectRejection(box, requester, RequestAlreadyPendingSchema, () =>
        requester.post(
          SubmitAccessRequestSchema,
          submitRequest("req-beside-extension", {
            period: {
              kind: { case: "scheduled", value: { start: minutesIn(12), end: minutesIn(20) } },
            },
          }),
        ),
      );
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

  describe("refuse a 'SubmitAccessRequest'", () => {
    it("for immediate access that does not last", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);

      await requester.post(
        SubmitAccessRequestSchema,
        submitRequest("req-negative", {
          period: { kind: { case: "immediateDuration", value: { seconds: -60n } } },
        }),
      );

      await expectNotSubmitted(box, requester, "req-negative");
    });

    it("for scheduled access that ends before it begins", async () => {
      const box = await resourcesBlackBox(testClock());
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);

      await requester.post(
        SubmitAccessRequestSchema,
        submitRequest("req-reversed", {
          period: {
            kind: { case: "scheduled", value: { start: minutesIn(30), end: minutesIn(20) } },
          },
        }),
      );

      await expectNotSubmitted(box, requester, "req-reversed");
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
      await revokeGrant(box, "req-revoked", "primary", "No longer needed.");
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

    it("fail the submission of an extension of a grant that gives no access", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenActiveGrant(box, "req-over", 10);
      clock.advanceMinutes(10);
      const failed = await recordEvents(requester, AccessExtensionRequestSubmissionFailedSchema);
      try {
        await requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-over", { grant: { uuid: "req-over" } }),
        );

        await failed.waitFor(box, (e) => e.id?.uuid === "ext-over");
        expect(await statusOf(requester, "ext-over")).toBeUndefined();
      } finally {
        await failed.cancel();
      }
    });

    it("reject extending into access another grant already gives ('AccessAlreadyHeld')", async () => {
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

  describe("refuse a 'SubmitAccessExtensionRequest'", () => {
    it("that adds no time to the access", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-shortened", 10);

      await requester.post(
        SubmitAccessExtensionRequestSchema,
        submitExtensionRequest("ext-negative", {
          grant: { uuid: "req-shortened" },
          duration: { seconds: -60n },
        }),
      );

      await expectNotSubmitted(box, requester, "ext-negative");
    });
  });

  describe("handle 'ApproveAccessRequest', and", () => {
    it("emit 'AccessRequestApproved' once the grant is created", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenPending(box, "req-approve");
      const approved = await recordEvents(requester, AccessRequestApprovedSchema);
      try {
        clock.advanceMinutes(5);

        expect((await approveAccessRequest(box, "req-approve", "primary")).kind).toBe("ok");

        const event = await approved.waitFor(
          box,
          (approvedEvent) => approvedEvent.id?.uuid === "req-approve",
        );
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
        expect(event.snapshot?.requester?.uuid).toBe(actor);
      } finally {
        await approved.cancel();
      }
    });

    it("emit 'AccessRequestApprovalStarted' recording the deciding manager and the time", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenPending(box, "req-approval-requested");
      const requested = await recordEvents(requester, AccessRequestApprovalStartedSchema);
      try {
        clock.advanceMinutes(5);

        await approveAccessRequest(box, "req-approval-requested", "primary");

        const event = await requested.waitFor(box, (e) => e.id?.uuid === "req-approval-requested");
        expect(event.decidedBy?.uuid).toBe("primary");
        expect(event.whenDecided).toEqual(minutesIn(5));
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
      } finally {
        await requested.cancel();
      }
    });

    it("reject a decider outside the manager pool ('NotAnEligibleManager')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-outsider");
      await expectRejection(box, requester, NotAnEligibleManagerSchema, () =>
        approveAccessRequest(box, "req-outsider", "outsider"),
      );
      expect(await statusOf(requester, "req-outsider")).toBe(AccessRequestStatus.PENDING);
    });

    it("allow a requester who manages the resource to approve their own request", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await submitAndAssign(box, requester, "req-self", actor);

      expect((await approveAccessRequest(box, "req-self", actor)).kind).toBe("ok");
      await box.eventually(
        () => statusOf(requester, "req-self"),
        (status) => status === AccessRequestStatus.APPROVED,
      );
    });

    it("fail the approval of an extension of access revoked since it was submitted", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenPendingExtension(box, "req-revoked-since", "ext-too-late");
      await revokeGrant(box, "req-revoked-since", "primary", "No longer needed.");
      await awaitGrantRevoked(box, requester, "req-revoked-since");
      const failed = await recordEvents(requester, AccessRequestApprovalFailedSchema);
      try {
        await approveAccessRequest(box, "ext-too-late", "primary");

        const event = await failed.waitFor(box, (e) => e.id?.uuid === "ext-too-late");
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
        await box.eventually(
          () => statusOf(requester, "ext-too-late"),
          (status) => status === AccessRequestStatus.APPROVAL_FAILED,
        );
      } finally {
        await failed.cancel();
      }
    });

    it("fail the approval of an extension of access ended since it was submitted", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenPendingExtension(box, "req-ended-since", "ext-after-end");
      clock.advanceMinutes(10);

      await approveAccessRequest(box, "ext-after-end", "primary");

      await box.eventually(
        () => statusOf(requester, "ext-after-end"),
        (status) => status === AccessRequestStatus.APPROVAL_FAILED,
      );
    });

    it("reject a decision on a request whose approval failed ('RequestAlreadyDecided')", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenPendingExtension(box, "req-ended-before", "ext-failed");
      clock.advanceMinutes(10);
      await approveAccessRequest(box, "ext-failed", "primary");
      await box.eventually(
        () => statusOf(requester, "ext-failed"),
        (status) => status === AccessRequestStatus.APPROVAL_FAILED,
      );

      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        denyAccessRequest(box, "ext-failed", "primary", "Too late."),
      );
    });

    it("reject a decision on an already-decided request ('RequestAlreadyDecided')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-twice");
      await givenApproved(box, requester, "req-twice");
      await expectRejection(box, requester, RequestAlreadyDecidedSchema, () =>
        approveAccessRequest(box, "req-twice", "primary"),
      );
    });
  });

  describe("handle 'DenyAccessRequest', and", () => {
    it("emit 'AccessRequestDenied' carrying the reason, the deciding manager, and the time", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = await givenPending(box, "req-deny");
      const denied = await recordEvents(requester, AccessRequestDeniedSchema);
      try {
        clock.advanceMinutes(5);

        expect(
          (await denyAccessRequest(box, "req-deny", "primary", "Insufficient justification.")).kind,
        ).toBe("ok");
        const event = await denied.waitFor(
          box,
          (deniedEvent) => deniedEvent.id?.uuid === "req-deny",
        );
        expect(event.decidedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Insufficient justification.");
        expect(event.whenDecided).toEqual(minutesIn(5));
      } finally {
        await denied.cancel();
      }
    });

    it("allow a requester who manages the resource to deny their own request", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await submitAndAssign(box, requester, "req-deny-self", actor);

      expect((await denyAccessRequest(box, "req-deny-self", actor, "Changed my mind.")).kind).toBe(
        "ok",
      );
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
        denyAccessRequest(box, "req-deny-twice", "primary", "Too late."),
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
