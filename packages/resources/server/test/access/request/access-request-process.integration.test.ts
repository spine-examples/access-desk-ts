/*
 * Copyright 2026, TeamDev. All rights reserved.
 * Licensed under the Apache License, Version 2.0.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eventRecording } from "@access-desk/base/testing";
import { AccessRequestSubmittedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_events_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_commands_pb.js";
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
    const box = await resourcesBlackBox();
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
    expect((await approveAccessRequest(requester, "ext-int", "primary")).kind).toBe("ok");
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
