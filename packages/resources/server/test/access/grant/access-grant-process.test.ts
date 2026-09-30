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
import { SubmitAccessExtensionRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import { AccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantNotActiveSchema,
  NotResourceManagerSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import { eventRecording } from "../../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  readAll,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
import type { ManualClock } from "../../given/manual-clock.js";
import {
  approveAccessRequest,
  seed,
  submitAndAssign,
  submitExtensionRequest,
} from "../request/given/access-request.js";
import { managerHasTask } from "../request/given/access-decision-assignment.js";
import {
  awaitGrantIssued,
  awaitGrantRevoked,
  awaitGrantView,
  createGrant,
  extendGrant,
  givenActiveGrant,
  minutesIn,
  revokeGrant,
  seedGrantedResource,
  testClock,
} from "./given/access-grant.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// Commands are posted to the grant directly, except in the cases that start from
// a manager's approval of a request.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

interface Given {
  readonly box: BlackBox;
  readonly scope: BlackBoxScope;
  readonly clock: ManualClock;
}

/**
 * Registers the resource, creates a grant to it, for the first hour of the test
 * by default, and waits until the grant is issued.
 */
async function givenGrant(id: string, overrides: Record<string, unknown> = {}): Promise<Given> {
  const clock = testClock();
  const box = await resourcesBlackBox(clock);
  const scope = box.onBehalfOf(actor);
  await seedGrantedResource(box);
  await createGrant(scope, id, overrides);
  await awaitGrantIssued(box, scope, id);
  return { box, scope, clock };
}

/**
 * Proves every earlier command to the grant was handled, by waiting for the
 * rejection of a revocation from someone who does not manage the resource.
 */
async function fence({ box, scope }: Given, id: string): Promise<void> {
  await expectRejection(box, scope, NotResourceManagerSchema, () =>
    revokeGrant(scope, id, "outsider", "Fence."),
  );
}

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

describe("AccessGrantProcessManager should", () => {
  describe("on 'AccessRequestApproved' for a first-time request", () => {
    it("issue immediate access counted from the approval", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]); // default maximumDuration is 3600s
      await submitAndAssign(box, requester, "req-now", "primary", {
        period: { kind: { case: "immediateDuration", value: { seconds: 600n } } },
      });
      clock.advanceMinutes(5);

      await approveAccessRequest(requester, "req-now", "primary");

      const item = await awaitGrantIssued(box, requester, "req-now");
      expect(item.start).toEqual(minutesIn(5));
      expect(item.end).toEqual(minutesIn(15));
      expect(item.revoked).toBe(false);
      const grant = (await readAll(requester, AccessGrantSchema, "grants")).find(
        (state) => state.id?.uuid === "req-now",
      );
      expect(grant?.request?.uuid).toBe("req-now");
      expect(grant?.approvedBy?.uuid).toBe("primary");
      expect(grant?.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
    });

    it("begin scheduled access approved within its interval at the approval, keeping its end", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      clock.advanceMinutes(10);

      await approveScheduled(box, requester, "req-within", 0, 30);

      const item = await awaitGrantIssued(box, requester, "req-within");
      expect(item.start).toEqual(minutesIn(10));
      expect(item.end).toEqual(minutesIn(30));
    });

    it("keep the interval of scheduled access approved before it begins", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);

      await approveScheduled(box, requester, "req-future", 30, 90);

      const item = await awaitGrantIssued(box, requester, "req-future");
      expect(item.start).toEqual(minutesIn(30));
      expect(item.end).toEqual(minutesIn(90));
    });

    it("keep the interval of scheduled access approved only after its end", async () => {
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

      const item = await awaitGrantIssued(box, requester, "req-too-late");
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

  describe("handle 'CreateAccessGrant', and", () => {
    it("emit 'AccessGrantCreated' with the access, its period, and its managers", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        expect((await createGrant(scope, "grant-created")).kind).toBe("ok");

        const event = await created.waitFor(box, (e) => e.id?.uuid === "grant-created");
        expect(event.access?.grantee?.uuid).toBe(actor);
        expect(event.start).toEqual(minutesIn(0));
        expect(event.end).toEqual(minutesIn(60));
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
      } finally {
        await created.cancel();
      }
    });

    it("create the grant once, leaving issued access as it is", async () => {
      const given = await givenGrant("grant-once");
      const { box, scope } = given;
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        await createGrant(scope, "grant-once", { end: minutesIn(30) });
        await fence(given, "grant-once");

        expect(created.received).toHaveLength(0);
        const view = await awaitGrantIssued(box, scope, "grant-once");
        expect(view.end).toEqual(minutesIn(60));
      } finally {
        await created.cancel();
      }
    });
  });

  describe("handle 'ExtendAccessGrant', and", () => {
    it("emit 'AccessGrantExtended' moving the end", async () => {
      const { box, scope } = await givenGrant("grant-extended");
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        await extendGrant(scope, "grant-extended", "ext-1", minutesIn(90));

        const event = await extended.waitFor(box, (e) => e.id?.uuid === "grant-extended");
        expect(event.previousEnd).toEqual(minutesIn(60));
        expect(event.end).toEqual(minutesIn(90));
        expect(event.request?.uuid).toBe("ext-1");
        await awaitGrantView(
          box,
          scope,
          "grant-extended",
          (item) => item.end?.seconds === minutesIn(90).seconds,
        );
      } finally {
        await extended.cancel();
      }
    });

    it("extend access that begins later once its start has arrived", async () => {
      const given = await givenGrant("grant-begins-later", {
        start: minutesIn(30),
        end: minutesIn(90),
      });
      const { box, scope, clock } = given;
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
          extendGrant(scope, "grant-begins-later", "ext-too-early", minutesIn(100)),
        );
        clock.advanceMinutes(30);

        await extendGrant(scope, "grant-begins-later", "ext-on-time", minutesIn(100));

        const event = await extended.waitFor(box, (e) => e.id?.uuid === "grant-begins-later");
        expect(event.request?.uuid).toBe("ext-on-time");
      } finally {
        await extended.cancel();
      }
    });

    it("reject extending revoked access ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-extend-revoked");
      await revokeGrant(scope, "grant-extend-revoked", "primary", "Ended.");
      await awaitGrantRevoked(box, scope, "grant-extend-revoked");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        extendGrant(scope, "grant-extend-revoked", "ext-late", minutesIn(90)),
      );
    });

    it("reject extending access whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-ended");
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        extendGrant(scope, "grant-ended", "ext-ended", minutesIn(90)),
      );
    });

    it("reject extending access that has not yet begun ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-not-begun", {
        start: minutesIn(30),
        end: minutesIn(90),
      });

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        extendGrant(scope, "grant-not-begun", "ext-early", minutesIn(120)),
      );
    });
  });

  describe("handle 'RevokeAccessGrant', and", () => {
    it("emit 'AccessGrantRevoked' with the revoking manager, the reason, and the time", async () => {
      const { box, scope, clock } = await givenGrant("grant-revoked");
      const revoked = await recordEvents(scope, AccessGrantRevokedSchema);
      try {
        clock.advanceMinutes(20);
        expect(
          (await revokeGrant(scope, "grant-revoked", "primary", "Investigation finished.")).kind,
        ).toBe("ok");

        const event = await revoked.waitFor(box, (e) => e.id?.uuid === "grant-revoked");
        expect(event.revokedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Investigation finished.");
        expect(event.whenRevoked).toEqual(minutesIn(20));
        await awaitGrantRevoked(box, scope, "grant-revoked");
      } finally {
        await revoked.cancel();
      }
    });

    it("revoke access that has yet to begin", async () => {
      const { box, scope } = await givenGrant("grant-later", {
        start: minutesIn(30),
        end: minutesIn(90),
      });

      expect((await revokeGrant(scope, "grant-later", "primary", "Plans changed.")).kind).toBe(
        "ok",
      );

      await awaitGrantRevoked(box, scope, "grant-later");
    });

    it("reject a person who does not manage the resource ('NotResourceManager')", async () => {
      const { box, scope } = await givenGrant("grant-outsider");
      await expectRejection(box, scope, NotResourceManagerSchema, () =>
        revokeGrant(scope, "grant-outsider", actor, "I am done."),
      );
      const view = await awaitGrantIssued(box, scope, "grant-outsider");
      expect(view.revoked).toBe(false);
    });

    it("reject revoking access whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-revoke-ended");
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(scope, "grant-revoke-ended", "primary", "Too late."),
      );
    });

    it("reject revoking access again ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-revoke-twice");
      await revokeGrant(scope, "grant-revoke-twice", "primary", "No longer needed.");
      await awaitGrantRevoked(box, scope, "grant-revoke-twice");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(scope, "grant-revoke-twice", "primary", "Once more."),
      );
    });

    it("reject a revocation without a reason", async () => {
      const { scope } = await givenGrant("grant-no-reason");
      expect((await revokeGrant(scope, "grant-no-reason", "primary", "")).kind).toBe("error");
    });
  });
});
