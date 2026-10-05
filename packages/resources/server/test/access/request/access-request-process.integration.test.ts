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
  submitAndAssign,
  submitExtensionRequest,
  submitRequest,
} from "./given/access-request.js";
import { managerHasTask, readAssignments } from "./given/access-decision-assignment.js";
import {
  awaitGrantIssued,
  awaitGrantView,
  givenActiveGrant,
  minutesIn,
  readAccessTo,
  testClock,
} from "../grant/given/resource-access.js";

const { recordEvents } = eventRecording(testActorContext);

// These exercise the whole request lifecycle end to end — the process manager,
// the requester's access to the resource, the decision-queue projection, and
// the request and grant views — from the client command to the client queries
// a browser would issue.
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
      expect(requests.some((r) => r.id?.uuid === "req-int")).toBe(true);

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

  it("grant access end to end: approve a submitted request and expose its grant to the requester and the resource", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "req-issue", "primary", {
      period: { kind: { case: "immediateDuration", value: { seconds: 600n } } },
    });

    // Approved five minutes later: the ten-minute countdown starts at approval.
    clock.advanceMinutes(5);
    expect((await approveAccessRequest(box, "req-issue", "primary")).kind).toBe("ok");

    await box.eventually(
      () => statusOf(requester, "req-issue"),
      (status) => status === AccessRequestStatus.APPROVED,
    );
    const active = await awaitGrantIssued(box, requester, "req-issue");
    expect(active.start).toEqual(minutesIn(5));
    expect(active.end).toEqual(minutesIn(15));
    expect(active.accessLevel?.name).toBe("Read");
    const managed = await box.eventually(
      () => readAccessTo(requester),
      (rows) => rows.some((row) => row.id?.uuid === "req-issue"),
    );
    const row = managed.find((item) => item.id?.uuid === "req-issue");
    expect(row?.grantee?.uuid).toBe(actor);
    expect(row?.request?.uuid).toBe("req-issue");
    expect(row?.revoked).toBe(false);
    await box.eventually(
      () => managerHasTask(requester, "primary", "req-issue"),
      (present) => !present,
    );
  });

  it("renew access end to end: submit an extension, assign it, approve it, and expose the decision and the extended grant", async () => {
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

    // The renewal reaches the manager's queue carrying its grant and proposed end.
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

    // The grant takes the proposed end, and tells which request extended it.
    const extended = await awaitGrantView(
      box,
      requester,
      "req-int-held",
      (item) => item.end?.seconds === minutesIn(12).seconds,
    );
    expect(extended.start).toEqual(minutesIn(0));
    expect(extended.revoked).toBe(false);
    expect(extended.extension.map((request) => request.uuid)).toEqual(["ext-int"]);
  });
});
