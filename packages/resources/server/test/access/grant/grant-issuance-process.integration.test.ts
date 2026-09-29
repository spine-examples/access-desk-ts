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
import { AccessGrantStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { SubmitAccessExtensionRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "../../given/resources-context.js";
import {
  approveAccessRequest,
  submitAndAssign,
  submitExtensionRequest,
} from "../request/given/access-request.js";
import { managerHasTask } from "../request/given/access-decision-assignment.js";
import {
  awaitGrantStatus,
  awaitGrantView,
  givenActiveGrant,
  minutesIn,
  readAccessTo,
  testClock,
} from "./given/access-grant.js";
import { seed } from "../request/given/access-request.js";
import { awaitActivationPlan } from "../../scheduling/given/scheduling.js";

// These run grant issuance end to end — from a manager's approval, through the
// grant's creation and activation, to the requester's and the resource's views —
// on a controlled clock, sending due activation commands as the system.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("GrantIssuanceProcessManager should", () => {
  it("issue active access on approval", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "req-issue", "primary", {
      period: { kind: { case: "immediateDuration", value: { seconds: 600n } } },
    });

    // Approved five minutes later: the ten-minute countdown starts at approval.
    clock.advanceMinutes(5);
    expect((await approveAccessRequest(requester, "req-issue", "primary")).kind).toBe("ok");

    const active = await awaitGrantStatus(box, requester, "req-issue", AccessGrantStatus.ACTIVE);
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
    expect(row?.status).toBe(AccessGrantStatus.ACTIVE);
  });

  it("extend active access when a manager approves an extension request", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = await givenActiveGrant(box, "req-extended", 10);

    expect(
      (
        await requester.post(
          SubmitAccessExtensionRequestSchema,
          submitExtensionRequest("ext-grant", {
            grant: { uuid: "req-extended" },
            duration: { seconds: 900n },
          }),
        )
      ).kind,
    ).toBe("ok");
    await box.eventually(
      () => managerHasTask(requester, "primary", "ext-grant"),
      (present) => present,
    );

    expect((await approveAccessRequest(requester, "ext-grant", "primary")).kind).toBe("ok");

    const extended = await awaitGrantView(
      box,
      requester,
      "req-extended",
      (item) => item.end?.seconds === minutesIn(25).seconds,
    );
    expect(extended.start).toEqual(minutesIn(0));
    expect(extended.status).toBe(AccessGrantStatus.ACTIVE);

    expect(extended.end).toEqual(minutesIn(25));
  });

  it("schedule access approved before it begins", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "req-future", "primary", {
      period: {
        kind: { case: "scheduled", value: { start: minutesIn(30), end: minutesIn(90) } },
      },
    });

    expect((await approveAccessRequest(requester, "req-future", "primary")).kind).toBe("ok");

    // Approved, and its start is scheduled.
    await awaitGrantStatus(box, requester, "req-future", AccessGrantStatus.SCHEDULED);
    const plan = await awaitActivationPlan(box, requester, "req-future");
    expect(plan.due).toEqual(minutesIn(30));
  });
});
