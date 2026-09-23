/*
 * Copyright 2026, TeamDev. All rights reserved.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { eventRecording } from "@access-desk/base/testing";
import {
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovedSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_events_pb.js";
import {
  AccessDurationTooLongSchema,
  AccessLevelNotAvailableSchema,
  DuplicateAccessRequestSchema,
  ManagerNotEligibleSchema,
  RequestAlreadyDecidedSchema,
  ResourceNotRequestableSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_rejections_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_commands_pb.js";
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

    it("reject a resource that is not open ('ResourceNotRequestable')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotRequestableSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-closed")),
      );
    });

    it("reject a level the policy does not offer ('AccessLevelNotAvailable')", async () => {
      const box = await resourcesBlackBox();
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
      const box = await resourcesBlackBox();
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
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessDurationTooLongSchema, () =>
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

    it("reject a second pending request for the same requester and resource ('DuplicateAccessRequest')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-first");
      await expectRejection(box, requester, DuplicateAccessRequestSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-second")),
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

  describe("handle 'SubmitAccessExtensionRequest', and", () => {
    it("submit a renewal, emitting 'AccessExtensionRequestSubmitted' with the extension snapshot", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      const submitted = await recordEvents(requester, AccessExtensionRequestSubmittedSchema);
      try {
        expect(
          (
            await requester.post(
              SubmitAccessExtensionRequestSchema,
              submitExtensionRequest("ext-ok"),
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
          expect(kind.value.grant?.uuid).toBe("grant-1");
          expect(kind.value.duration?.seconds).toBe(120n);
        }
      } finally {
        await submitted.cancel();
      }
    });

    it("reject a resource that is not open ('ResourceNotRequestable')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotRequestableSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-closed")),
      );
    });

    it("reject an added duration beyond the maximum ('AccessDurationTooLong')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, AccessDurationTooLongSchema, () =>
        requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-toolong", { duration: { seconds: 7200n } }),
        ),
      );
    });

    it("reject a second pending extension for the same requester and grant ('DuplicateAccessRequest')", async () => {
      const box = await resourcesBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      expect(
        (
          await requester.post(
            SubmitAccessExtensionRequestSchema,
            submitExtensionRequest("ext-first"),
          )
        ).kind,
      ).toBe("ok");
      await box.eventually(
        () => statusOf(requester, "ext-first"),
        (status) => status === AccessRequestStatus.PENDING,
      );

      await expectRejection(box, requester, DuplicateAccessRequestSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-second")),
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

    it("reject a decider outside the manager pool ('ManagerNotEligible')", async () => {
      const box = await resourcesBlackBox();
      const requester = await givenPending(box, "req-outsider");
      await expectRejection(box, requester, ManagerNotEligibleSchema, () =>
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
