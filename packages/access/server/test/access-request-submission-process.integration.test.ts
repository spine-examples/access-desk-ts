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
import { AccessRequestCreatedSchema } from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import {
  AccessRequestAdmissionAcceptedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_submission_events_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_submission_commands_pb.js";
import { AccessRequestStatus } from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
} from "./given/access-context.js";
import { recordEvents } from "./given/events.js";
import {
  seed,
  submitExtensionRequest,
  submitRequest,
} from "./given/access-request-submission.js";
import { approveAccessRequest, readRequests, statusOf } from "./given/access-request.js";
import { managerHasTask, readAssignments } from "./given/access-decision-assignment.js";

// These exercise the whole submission-and-decision choreography end to end —
// process manager, request aggregate, and decision-queue projection — from the
// client command to the client queries a browser would issue.
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

describe("AccessRequestSubmissionProcessManager should", () => {
  it("submit a request end to end and expose it through the request and queue queries", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary", "second"], {
      policy: { manager: [{ uuid: "primary" }, { uuid: "second" }] },
    });

    const admitted = await recordEvents(requester, AccessRequestAdmissionAcceptedSchema);
    const created = await recordEvents(requester, AccessRequestCreatedSchema);
    const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
    try {
      expect((await requester.post(SubmitAccessRequestSchema, submitRequest("req-int"))).kind).toBe(
        "ok",
      );

      // The three choreography facts fire in order: admitted, created, submitted.
      const admission = await admitted.waitFor(box, (event) => event.id?.uuid === "req-int");
      expect(admission.candidateManager.map((manager) => manager.uuid)).toEqual(["primary", "second"]);
      expect((await created.waitFor(box, (event) => event.id?.uuid === "req-int")).snapshot?.requester?.uuid).toBe(
        actor,
      );
      await submitted.waitFor(box, (event) => event.id?.uuid === "req-int");

      // The request is retrievable through its own query.
      const requests = await box.eventually(
        () => readRequests(requester),
        (rows) =>
          rows.some((r) => r.id?.uuid === "req-int" && r.status === AccessRequestStatus.PENDING),
      );
      expect(
        requests.find((r) => r.id?.uuid === "req-int")?.candidateManager.map((m) => m.uuid),
      ).toEqual(["primary", "second"]);

      // And through both managers' decision queues, each task carrying the snapshot.
      expect(await managerHasTask(requester, "primary", "req-int")).toBe(true);
      expect(await managerHasTask(requester, "second", "req-int")).toBe(true);
      const assignments = await readAssignments(requester);
      const task = assignments
        .find((row) => row.id?.uuid === "primary")
        ?.task.find((candidate) => candidate.request?.uuid === "req-int");
      expect(task?.snapshot?.requester?.uuid).toBe(actor);
    } finally {
      await Promise.all([admitted.cancel(), created.cancel(), submitted.cancel()]);
    }
  });

  it("renew access end to end: submit an extension, assign it, approve it, and expose the decision", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);

    expect(
      (await requester.post(SubmitAccessExtensionRequestSchema, submitExtensionRequest("ext-int")))
        .kind,
    ).toBe("ok");

    // The renewal reaches the manager's queue carrying its grant and duration.
    await box.eventually(
      () => managerHasTask(requester, "primary", "ext-int"),
      (present) => present,
    );
    const assignments = await readAssignments(requester);
    const kind = assignments
      .find((row) => row.id?.uuid === "primary")
      ?.task.find((task) => task.request?.uuid === "ext-int")?.snapshot?.kind;
    expect(kind?.case).toBe("extension");
    if (kind?.case === "extension") {
      expect(kind.value.grant?.uuid).toBe("grant-1");
      expect(kind.value.duration?.seconds).toBe(120n);
    }

    // The manager approves; the decision is exposed and the task is cleared.
    expect((await approveAccessRequest(box.onBehalfOf("primary"), "ext-int", "primary")).kind).toBe(
      "ok",
    );
    await box.eventually(
      () => statusOf(requester, "ext-int"),
      (status) => status === AccessRequestStatus.APPROVED,
    );
    await box.eventually(
      () => managerHasTask(requester, "primary", "ext-int"),
      (present) => !present,
    );
  });
});
