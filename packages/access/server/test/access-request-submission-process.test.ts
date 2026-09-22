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
import { eventRecording } from "@access-desk/base/testing";
import { AccessRequestCreatedSchema } from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import {
  AccessRequestAdmittedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_submission_events_pb.js";
import {
  AccessDurationTooLongSchema,
  AccessLevelNotAvailableSchema,
  DuplicateAccessRequestSchema,
  NoManagersEligibleSchema,
  ResourceNotRequestableSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_submission_rejections_pb.js";
import { AccessRequestStatus } from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
  testActorContext,
} from "./given/access-context.js";
import {
  seed,
  submitAndAssign,
  submitExtensionRequest,
  submitRequest,
} from "./given/access-request-submission.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_submission_commands_pb.js";
import { cancelAccessRequest, statusOf } from "./given/access-request.js";
import { managerHasTask } from "./given/access-decision-assignment.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The process manager keeps no queryable state, so each handler is observed
// through the facts it emits and the rejections it throws.
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

describe("AccessRequestSubmissionProcessManager should", () => {
  describe("handle 'SubmitAccessRequest', and", () => {
    it("admit a request with the authoritative level and the deduped, active, non-requester managers", async () => {
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
      const admitted = await recordEvents(requester, AccessRequestAdmittedSchema);
      try {
        expect(
          (
            await requester.post(
              SubmitAccessRequestSchema,
              submitRequest("req-ok", { accessLevel: { name: " reader ", rank: 4 } }),
            )
          ).kind,
        ).toBe("ok");

        const event = await admitted.waitFor(box, (candidate) => candidate.id?.uuid === "req-ok");
        // Managers keep policy order, drop the duplicate, the inactive member, and the requester.
        expect(event.candidateManager.map((manager) => manager.uuid)).toEqual([
          "second",
          "primary",
        ]);
        const kind = event.snapshot?.kind;
        expect(kind?.case).toBe("newRequest");
        if (kind?.case === "newRequest") {
          // The authoritative policy level is recorded, not the client's spelling.
          expect(kind.value.accessLevel?.name).toBe("Reader");
        }
      } finally {
        await admitted.cancel();
      }
    });

    it("reject a resource that is not open", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotRequestableSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-closed")),
      );
    });

    it("reject a level the policy does not offer", async () => {
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

    it("reject an immediate duration beyond the maximum", async () => {
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

    it("reject a scheduled interval beyond the maximum", async () => {
      const box = await accessBlackBox();
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

    it("reject a second pending request for the same requester and resource", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      await submitAndAssign(box, requester, "req-first", "primary");
      await expectRejection(box, requester, DuplicateAccessRequestSchema, () =>
        requester.post(SubmitAccessRequestSchema, submitRequest("req-second")),
      );
    });

    it("reject a request when no active manager is eligible", async () => {
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
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      await submitAndAssign(box, requester, "req-original", "primary");
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
    it("admit a renewal, emitting 'AccessRequestAdmitted' with the extension snapshot", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      const admitted = await recordEvents(requester, AccessRequestAdmittedSchema);
      try {
        expect(
          (
            await requester.post(
              SubmitAccessExtensionRequestSchema,
              submitExtensionRequest("ext-ok"),
            )
          ).kind,
        ).toBe("ok");

        const event = await admitted.waitFor(box, (candidate) => candidate.id?.uuid === "ext-ok");
        expect(event.candidateManager.map((manager) => manager.uuid)).toEqual(["primary"]);
        const kind = event.snapshot?.kind;
        expect(kind?.case).toBe("extension");
        if (kind?.case === "extension") {
          expect(kind.value.grant?.uuid).toBe("grant-1");
          expect(kind.value.duration?.seconds).toBe(120n);
        }
      } finally {
        await admitted.cancel();
      }
    });

    it("reject a resource that is not open", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"], { openForRequests: false });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, ResourceNotRequestableSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-closed")),
      );
    });

    it("reject an added duration beyond the maximum", async () => {
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

    it("reject a renewal when no active manager is eligible", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor], { policy: { manager: [{ uuid: actor }] } });
      const requester = box.onBehalfOf(actor);
      await expectRejection(box, requester, NoManagersEligibleSchema, () =>
        requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-nomanager")),
      );
    });
  });

  describe("handle 'AccessRequestAdmitted', and", () => {
    it("command the request aggregate to create the accepted request", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      const created = await recordEvents(requester, AccessRequestCreatedSchema);
      try {
        await requester.post(SubmitAccessRequestSchema, submitRequest("req-create"));
        const event = await created.waitFor(
          box,
          (candidate) => candidate.id?.uuid === "req-create",
        );
        expect(event.snapshot?.requester?.uuid).toBe(actor);
        expect(event.candidateManager.map((manager) => manager.uuid)).toEqual(["primary"]);
      } finally {
        await created.cancel();
      }
    });
  });

  describe("handle 'AccessRequestCreated', and", () => {
    it("emit 'AccessRequestSubmitted' to complete the submission", async () => {
      const box = await accessBlackBox();
      await seed(box, [actor, "primary"]);
      const requester = box.onBehalfOf(actor);
      const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
      try {
        await requester.post(SubmitAccessRequestSchema, submitRequest("req-submit"));
        expect(
          (await submitted.waitFor(box, (event) => event.id?.uuid === "req-submit")).id?.uuid,
        ).toBe("req-submit");
      } finally {
        await submitted.cancel();
      }
    });
  });
});
