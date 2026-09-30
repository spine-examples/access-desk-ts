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
import { eventRecording } from "../../given/event-recording.js";
import { AccessRequestSubmittedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import { AccessRequestStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
import {
  approveAccessRequest,
  readRequests,
  seed,
  statusOf,
  submitExtensionRequest,
  submitRequest,
} from "./given/access-request.js";
import { managerHasTask, readAssignments } from "./given/access-decision-assignment.js";
import { givenActiveGrant, minutesIn, testClock } from "../grant/given/access-grant.js";

const { recordEvents } = eventRecording(testActorContext);

// These exercise the whole request lifecycle end to end — the process manager,
// the decision-queue projection, and the request view — from the client command
// to the client queries a browser would issue.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("AccessRequestProcessManager should", () => {
  it("submit a request end to end and expose it through the request and queue queries", async () => {
    const box = await resourcesBlackBox();
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary", "second"], {
      policy: { manager: [{ uuid: "primary" }, { uuid: "second" }] },
    });

    const submitted = await recordEvents(requester, AccessRequestSubmittedSchema);
    try {
      expect((await requester.post(SubmitAccessRequestSchema, submitRequest("req-int"))).kind).toBe(
        "ok",
      );

      const event = await submitted.waitFor(
        box,
        (submittedEvent) => submittedEvent.id?.uuid === "req-int",
      );
      expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary", "second"]);
      expect(event.snapshot?.requester?.uuid).toBe(actor);

      // The request is retrievable through its own query.
      const requests = await box.eventually(
        () => readRequests(requester),
        (rows) =>
          rows.some((r) => r.id?.uuid === "req-int" && r.status === AccessRequestStatus.PENDING),
      );
      expect(requests.find((r) => r.id?.uuid === "req-int")?.manager.map((m) => m.uuid)).toEqual([
        "primary",
        "second",
      ]);

      // And through both managers' decision queues, each task carrying the snapshot.
      expect(await managerHasTask(requester, "primary", "req-int")).toBe(true);
      expect(await managerHasTask(requester, "second", "req-int")).toBe(true);
      const assignments = await readAssignments(requester);
      const task = assignments
        .find((row) => row.id?.uuid === "primary")
        ?.task.find((task) => task.request?.uuid === "req-int");
      expect(task?.snapshot?.requester?.uuid).toBe(actor);
    } finally {
      await submitted.cancel();
    }
  });

  it("renew access end to end: submit an extension, assign it, approve it, and expose the decision", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = await givenActiveGrant(box, "req-int-held", 10);

    expect(
      (
        await requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-int", { grant: { uuid: "req-int-held" } }),
        )
      ).kind,
    ).toBe("ok");

    // The renewal reaches the manager's queue carrying its grant, duration, and proposed end.
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
      expect(kind.value.grant?.uuid).toBe("req-int-held");
      expect(kind.value.proposedEnd).toEqual(minutesIn(12));
    }

    // The manager approves; the decision is exposed and the task is cleared.
    expect((await approveAccessRequest(box, "ext-int", "primary")).kind).toBe("ok");
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
