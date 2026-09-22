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
  resourceUuid,
} from "./given/access-context.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  denyAccessRequest,
  seed,
  submitAndAssign,
} from "./given/access-request.js";
import { decisionTasks, managerHasTask } from "./given/access-decision-assignment.js";

// The projection reacts to the request's lifecycle facts, produced here through
// the real submission-and-decision path (the only way to create a request now).
beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

const twoManagers = { policy: { manager: [{ uuid: "primary" }, { uuid: "second" }] } };

/** Waits until `manager`'s queue holds (or drops) a task for `id`. */
function awaitTask(box: BlackBox, manager: string, id: string, present: boolean): Promise<boolean> {
  const requester = box.onBehalfOf(actor);
  return box.eventually(
    () => managerHasTask(requester, manager, id),
    (has) => has === present,
  );
}

describe("AccessDecisionAssignmentProjection should", () => {
  describe("on 'AccessRequestSubmitted'", () => {
    it("add the request as a rich task to every candidate manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary", "second"], twoManagers);

      await submitAndAssign(box, requester, "req-submitted", ["primary", "second"]);

      const rows = await readAll(requester, AccessDecisionAssignmentSchema, "assign-submitted");
      const task = rows
        .find((row) => row.id?.uuid === "primary")
        ?.task.find((candidate) => candidate.request?.uuid === "req-submitted");
      expect(task?.snapshot?.requester?.uuid).toBe(actor);
      // A first-time request carries its resource and level, not an extension.
      const kind = task?.snapshot?.kind;
      expect(kind?.case).toBe("newRequest");
      if (kind?.case === "newRequest") {
        expect(kind.value.resource?.uuid).toBe(resourceUuid);
        expect(kind.value.accessLevel?.name).toBe("Read");
      }
      expect(await managerHasTask(requester, "second", "req-submitted")).toBe(true);
    });
  });

  describe("on 'AccessRequestApproved'", () => {
    it("remove the task from every manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary", "second"], twoManagers);
      await submitAndAssign(box, requester, "req-approved", ["primary", "second"]);

      await approveAccessRequest(requester, "req-approved", "primary");

      await awaitTask(box, "primary", "req-approved", false);
      await awaitTask(box, "second", "req-approved", false);
    });
  });

  describe("on 'AccessRequestDenied'", () => {
    it("remove the task from every manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary", "second"], twoManagers);
      await submitAndAssign(box, requester, "req-denied", ["primary", "second"]);

      await denyAccessRequest(requester, "req-denied", "primary", "Insufficient justification.");

      await awaitTask(box, "primary", "req-denied", false);
      await awaitTask(box, "second", "req-denied", false);
    });
  });

  describe("on 'AccessRequestCanceled'", () => {
    it("remove the task from every manager's queue", async () => {
      const box = await accessBlackBox();
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary", "second"], twoManagers);
      await submitAndAssign(box, requester, "req-canceled", ["primary", "second"]);

      await cancelAccessRequest(requester, "req-canceled");

      await awaitTask(box, "primary", "req-canceled", false);
      await awaitTask(box, "second", "req-canceled", false);
    });
  });

  it("clears only the decided request, keeping a manager's other tasks", async () => {
    const box = await accessBlackBox();
    const requester = box.onBehalfOf(actor);
    const teammate = box.onBehalfOf("teammate");
    await seed(box, [actor, "teammate", "primary"], { policy: { manager: [{ uuid: "primary" }] } });
    await submitAndAssign(box, requester, "req-a", "primary");
    // A second requester keeps the same manager busy with an independent request.
    await submitAndAssign(box, teammate, "req-b", "primary", { requester: { uuid: "teammate" } });

    await denyAccessRequest(requester, "req-a", "primary", "Not this time.");

    await box.eventually(
      () => decisionTasks(requester, "primary"),
      (tasks) => !tasks.includes("req-a") && tasks.includes("req-b"),
    );
  });
});
