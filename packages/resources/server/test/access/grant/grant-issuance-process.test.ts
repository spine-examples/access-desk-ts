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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { AccessGrantStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { SubmitAccessExtensionRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import { AccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import {
  AccessGrantActivationScheduledSchema,
  AccessGrantExtendedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import { eventRecording } from "../../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  readAll,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
import {
  approveAccessRequest,
  seed,
  submitAndAssign,
  submitExtensionRequest,
} from "../request/given/access-request.js";
import { managerHasTask } from "../request/given/access-decision-assignment.js";
import {
  awaitActivationPlan,
  packedActivation,
  scheduleCommand,
} from "../../scheduling/given/scheduling.js";
import { awaitGrantStatus, givenActiveGrant, minutesIn, testClock } from "./given/access-grant.js";

const { recordEvents } = eventRecording(testActorContext);

// The process reacts to real approvals, so each case submits and approves a
// request, then observes the grant it issued.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

/** Has the requester ask for access over the interval and `primary` approve it. */
async function approveScheduled(
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
  await approveAccessRequest(requester, request, "primary");
}

/** Submits an extension of the grant by `minutes` and has `primary` approve it. */
async function approveExtension(
  box: BlackBox,
  requester: BlackBoxScope,
  request: string,
  grant: string,
  minutes: number,
): Promise<void> {
  await requester.post(
    SubmitAccessExtensionRequestSchema,
    submitExtensionRequest(request, {
      grant: { uuid: grant },
      duration: { seconds: BigInt(minutes * 60) },
    }),
  );
  await box.eventually(
    () => managerHasTask(requester, "primary", request),
    (present) => present,
  );
  await approveAccessRequest(requester, request, "primary");
}

describe("GrantIssuanceProcessManager should", () => {
  describe("on 'AccessRequestApproved' for a first-time request", () => {
    it("issue active access counted from the approval, limited by the resource's maximum", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      await submitAndAssign(box, requester, "req-now", "primary", {
        period: { kind: { case: "immediateDuration", value: { seconds: 600n } } },
      });
      clock.advanceMinutes(5);

      await approveAccessRequest(requester, "req-now", "primary");

      const item = await awaitGrantStatus(box, requester, "req-now", AccessGrantStatus.ACTIVE);
      expect(item.start).toEqual(minutesIn(5));
      expect(item.end).toEqual(minutesIn(15));
      const grant = (await readAll(requester, AccessGrantSchema, "grants")).find(
        (state) => state.id?.uuid === "req-now",
      );
      expect(grant?.request?.uuid).toBe("req-now");
      expect(grant?.approvedBy?.uuid).toBe("primary");
      expect(grant?.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
      expect(grant?.maximumLifetime?.seconds).toBe(3600n);
    });

    it("start scheduled access approved within its interval at the approval, keeping its end", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      await submitAndAssign(box, requester, "req-scheduled", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(0), end: minutesIn(30) } },
        },
      });
      clock.advanceMinutes(10);

      await approveAccessRequest(requester, "req-scheduled", "primary");

      const item = await awaitGrantStatus(
        box,
        requester,
        "req-scheduled",
        AccessGrantStatus.ACTIVE,
      );
      expect(item.start).toEqual(minutesIn(10));
      expect(item.end).toEqual(minutesIn(30));
    });

    it("schedule the start of access approved before it begins", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      await submitAndAssign(box, requester, "req-future", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(30), end: minutesIn(90) } },
        },
      });

      await approveAccessRequest(requester, "req-future", "primary");

      const item = await awaitGrantStatus(
        box,
        requester,
        "req-future",
        AccessGrantStatus.SCHEDULED,
      );
      expect(item.start).toEqual(minutesIn(30));
      expect(item.end).toEqual(minutesIn(90));
      await awaitActivationPlan(
        box,
        requester,
        "req-future",
        (plan) => plan.due?.seconds === minutesIn(30).seconds,
      );
    });

    it("end access approved only after its end, without ever activating it", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      await submitAndAssign(box, requester, "req-too-late", "primary", {
        period: {
          kind: { case: "scheduled", value: { start: minutesIn(0), end: minutesIn(10) } },
        },
      });
      clock.advanceMinutes(10);

      await approveAccessRequest(requester, "req-too-late", "primary");

      const item = await awaitGrantStatus(
        box,
        requester,
        "req-too-late",
        AccessGrantStatus.EXPIRED_BEFORE_ACTIVATION,
      );
      // The requested interval is kept for history.
      expect(item.start).toEqual(minutesIn(0));
      expect(item.end).toEqual(minutesIn(10));
    });
  });

  describe("on 'AccessRequestApproved' for an extension request", () => {
    it("move the grant's end to the end each approved extension proposed", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = await givenActiveGrant(box, "req-to-extend", 10);
      const extended = await recordEvents(requester, AccessGrantExtendedSchema);
      try {
        await approveExtension(box, requester, "ext-first", "req-to-extend", 10);
        await extended.waitFor(box, (e) => e.request?.uuid === "ext-first");
        await approveExtension(box, requester, "ext-second", "req-to-extend", 10);

        const event = await extended.waitFor(box, (e) => e.request?.uuid === "ext-second");
        expect(event.previousEnd).toEqual(minutesIn(20));
        expect(event.end).toEqual(minutesIn(30));
        expect(extended.received.map((e) => e.request?.uuid)).toEqual(["ext-first", "ext-second"]);
      } finally {
        await extended.cancel();
      }
    });
  });

  describe("on 'CommandScheduled'", () => {
    it("hear only of commands scheduled with it as the invoker", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      const scheduled = await recordEvents(requester, AccessGrantActivationScheduledSchema);
      try {
        await approveScheduled(box, requester, "req-routed", 30, 90);
        await scheduled.waitFor(box, (e) => e.id?.uuid === "req-routed");

        // Another activation of the grant is scheduled without naming an invoker.
        await scheduleCommand(requester, packedActivation("req-routed"), minutesIn(45));
        // A later grant's activation, confirmed after it.
        await approveScheduled(box, requester, "req-fence", 100, 130);
        await scheduled.waitFor(box, (e) => e.id?.uuid === "req-fence");

        const routed = scheduled.received.filter((e) => e.id?.uuid === "req-routed");
        expect(routed.map((e) => e.start)).toEqual([minutesIn(30)]);
      } finally {
        await scheduled.cancel();
      }
    });
  });
});
