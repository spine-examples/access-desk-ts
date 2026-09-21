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
import { type BlackBox } from "@spine-event-engine/testing";
import { AccessDecisionAssignmentSchema } from "@access-desk/access-model/generated/access_desk/access/access_decision_assignment_pb.js";
import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
  readAll,
} from "./given/access-context.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  createAccessRequest,
  denyAccessRequest,
} from "./given/access-request.js";
import { decisionTasks, managerHasTask, resourceUuid } from "./given/access-flow.js";

// The projection reacts to the request aggregate's facts. Each event is produced
// by posting the aggregate command directly, so the projection is exercised on
// its own, without the submission process, resource policy, or membership.
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

/** Waits until `manager`'s queue holds (or drops) a task for `id`. */
function awaitTask(
  box: BlackBox,
  manager: string,
  id: string,
  present: boolean,
): Promise<boolean> {
  const requester = box.onBehalfOf(actor);
  return box.eventually(
    () => managerHasTask(requester, manager, id),
    (has) => has === present,
  );
}

describe("AccessDecisionAssignmentProjection should", () => {
  describe("on 'AccessRequestCreated'", () => {
    it("add the request as a rich task to every candidate manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);

      await createAccessRequest(requester, "req-created", {
        candidateManager: ["primary", "second"],
        resource: resourceUuid,
      });

      await awaitTask(box, "primary", "req-created", true);
      await awaitTask(box, "second", "req-created", true);
      const rows = await readAll(requester, AccessDecisionAssignmentSchema, "assign-created");
      const task = rows
        .find((row) => row.id?.uuid === "primary")
        ?.task.find((candidate) => candidate.request?.uuid === "req-created");
      expect(task?.snapshot?.requester?.uuid).toBe(actor);
      // A first-time request carries its resource and level, not an extension.
      const kind = task?.snapshot?.kind;
      expect(kind?.case).toBe("newRequest");
      if (kind?.case === "newRequest") {
        expect(kind.value.resource?.uuid).toBe(resourceUuid);
        expect(kind.value.accessLevel?.name).toBe("Read");
      }
    });
  });

  describe("on 'AccessRequestApproved'", () => {
    it("remove the task from every manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await createAccessRequest(requester, "req-approved", {
        candidateManager: ["primary", "second"],
      });
      await awaitTask(box, "primary", "req-approved", true);
      await awaitTask(box, "second", "req-approved", true);

      await approveAccessRequest(requester, "req-approved", "primary");

      await awaitTask(box, "primary", "req-approved", false);
      await awaitTask(box, "second", "req-approved", false);
    });
  });

  describe("on 'AccessRequestDenied'", () => {
    it("remove the task from every manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await createAccessRequest(requester, "req-denied", {
        candidateManager: ["primary", "second"],
      });
      await awaitTask(box, "primary", "req-denied", true);
      await awaitTask(box, "second", "req-denied", true);

      await denyAccessRequest(requester, "req-denied", "primary", "Insufficient justification.");

      await awaitTask(box, "primary", "req-denied", false);
      await awaitTask(box, "second", "req-denied", false);
    });
  });

  describe("on 'AccessRequestCancelled'", () => {
    it("remove the task from every manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await createAccessRequest(requester, "req-cancelled", {
        candidateManager: ["primary", "second"],
      });
      await awaitTask(box, "primary", "req-cancelled", true);
      await awaitTask(box, "second", "req-cancelled", true);

      await cancelAccessRequest(requester, "req-cancelled");

      await awaitTask(box, "primary", "req-cancelled", false);
      await awaitTask(box, "second", "req-cancelled", false);
    });
  });

  it("clears only the decided request, keeping a manager's other tasks", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    await createAccessRequest(requester, "req-a", { candidateManager: ["primary"] });
    await createAccessRequest(requester, "req-b", { candidateManager: ["primary"] });
    await box.eventually(
      () => decisionTasks(requester, "primary"),
      (tasks) => tasks.includes("req-a") && tasks.includes("req-b"),
    );

    await denyAccessRequest(requester, "req-a", "primary", "Not this time.");

    await box.eventually(
      () => decisionTasks(requester, "primary"),
      (tasks) => !tasks.includes("req-a") && tasks.includes("req-b"),
    );
  });
});
