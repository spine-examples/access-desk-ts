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
import { CommandScheduledSchema } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/events_pb.js";
import { eventRecording } from "../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../given/resources-context.js";
import { minutesIn, testClock } from "../access/grant/given/access-grant.js";
import {
  activatedGrant,
  awaitActivationPlan,
  readSchedules,
  scheduleActivation,
  scheduleCommand,
  unschedulable,
} from "./given/scheduling.js";

const { recordEvents } = eventRecording(testActorContext);

// The planning command is posted directly. The planned command begins the access
// of a grant that does not exist, and nothing sends it yet.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("SchedulingProcessManager should", () => {
  describe("handle 'ScheduleCommand', and", () => {
    it("emit 'CommandScheduled' for the planned command and its due time", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      const scheduled = await recordEvents(scope, CommandScheduledSchema);
      try {
        expect((await scheduleActivation(scope, "grant-planned", minutesIn(30))).kind).toBe("ok");

        const event = await scheduled.waitFor(box);
        expect(activatedGrant(event.command)).toBe("grant-planned");
        expect(event.due).toEqual(minutesIn(30));
        const plan = await awaitActivationPlan(box, scope, "grant-planned");
        expect(plan.id?.uuid).toBe(event.id?.uuid);
        expect(plan.due).toEqual(minutesIn(30));
      } finally {
        await scheduled.cancel();
      }
    });

    describe("not plan a command", () => {
      for (const [condition, command] of Object.entries(unschedulable)) {
        it(condition, async () => {
          const box = await resourcesBlackBox(testClock());
          const scope = box.onBehalfOf(actor);

          await scheduleCommand(scope, command, minutesIn(30));
          // A schedulable command planned afterwards shows the refused one was handled.
          await scheduleActivation(scope, "grant-after", minutesIn(30));
          await awaitActivationPlan(box, scope, "grant-after");

          expect(await readSchedules(scope)).toHaveLength(1);
        });
      }
    });
  });
});
