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
import {
  AccessGrantActivatedSchema,
  AccessGrantCreatedSchema,
  AccessGrantExpiredSchema,
  AccessGrantExpiredBeforeActivationSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantNotPendingSchema,
  AccessGrantNotActiveSchema,
  NotResourceManagerSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import { eventRecording } from "../../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
import type { ManualClock } from "../../given/manual-clock.js";
import {
  activateGrant,
  awaitGrantStatus,
  createGrant,
  expireGrant,
  extendGrant,
  minutesIn,
  revokeGrant,
  testClock,
} from "./given/access-grant.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// Each command is posted to the grant directly. Creating a grant still lets grant
// issuance activate it, exactly as it does for a grant issued on approval.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

interface Given {
  readonly box: BlackBox;
  readonly scope: BlackBoxScope;
  readonly clock: ManualClock;
}

/** Creates a grant for the first hour of the test and waits until it is active. */
async function givenActive(id: string): Promise<Given> {
  const clock = testClock();
  const box = await resourcesBlackBox(clock);
  const scope = box.onBehalfOf(actor);
  await createGrant(scope, id);
  await awaitGrantStatus(box, scope, id, AccessGrantStatus.ACTIVE);
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

describe("AccessGrantAggregate should", () => {
  describe("handle 'CreateAccessGrant', and", () => {
    it("await the scheduling of access that begins later", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        await createGrant(scope, "grant-future", { start: minutesIn(30), end: minutesIn(90) });

        const event = await created.waitFor(box, (e) => e.id?.uuid === "grant-future");
        expect(event.status).toBe(AccessGrantStatus.PENDING_SCHEDULING);
      } finally {
        await created.cancel();
      }
    });

    it("await activation of access whose end has passed, which then expires it before activation", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const scope = box.onBehalfOf(actor);
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      const lapsed = await recordEvents(scope, AccessGrantExpiredBeforeActivationSchema);
      try {
        clock.advanceMinutes(60);

        await createGrant(scope, "grant-past");

        const event = await created.waitFor(box, (e) => e.id?.uuid === "grant-past");
        expect(event.status).toBe(AccessGrantStatus.PENDING_ACTIVATION);
        await lapsed.waitFor(box, (e) => e.id?.uuid === "grant-past");
      } finally {
        await created.cancel();
        await lapsed.cancel();
      }
    });

    it("emit 'AccessGrantCreated' for access due to begin now", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        expect((await createGrant(scope, "grant-created")).kind).toBe("ok");

        const event = await created.waitFor(box, (e) => e.id?.uuid === "grant-created");
        expect(event.status).toBe(AccessGrantStatus.PENDING_ACTIVATION);
        expect(event.access?.grantee?.uuid).toBe(actor);
        expect(event.start).toEqual(minutesIn(0));
        expect(event.end).toEqual(minutesIn(60));
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
      } finally {
        await created.cancel();
      }
    });
  });

  describe("handle 'ActivateAccessGrant', and", () => {
    it("emit 'AccessGrantActivated' once the start has arrived", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      const activated = await recordEvents(scope, AccessGrantActivatedSchema);
      try {
        await createGrant(scope, "grant-activated");

        const event = await activated.waitFor(box, (e) => e.id?.uuid === "grant-activated");
        expect(event.start).toEqual(minutesIn(0));
        expect(event.end).toEqual(minutesIn(60));
      } finally {
        await activated.cancel();
      }
    });

    it("end access that was not activated by its end, exactly once", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const scope = box.onBehalfOf(actor);
      const given = { box, scope, clock };
      const lapsed = await recordEvents(scope, AccessGrantExpiredBeforeActivationSchema);
      try {
        await createGrant(scope, "grant-missed", { start: minutesIn(10), end: minutesIn(20) });
        await awaitGrantStatus(box, scope, "grant-missed", AccessGrantStatus.SCHEDULED);
        clock.advanceMinutes(20);

        await activateGrant(scope, "grant-missed");
        await activateGrant(scope, "grant-missed");
        await fence(given, "grant-missed");

        const event = await lapsed.waitFor(box, (e) => e.id?.uuid === "grant-missed");
        expect(event.end).toEqual(minutesIn(20));
        expect(lapsed.received).toHaveLength(1);
        await awaitGrantStatus(
          box,
          scope,
          "grant-missed",
          AccessGrantStatus.EXPIRED_BEFORE_ACTIVATION,
        );
      } finally {
        await lapsed.cancel();
      }
    });

    it("never activate expired access again", async () => {
      const given = await givenActive("grant-reactivate");
      const { box, scope, clock } = given;
      clock.advanceMinutes(60);
      await expireGrant(scope, "grant-reactivate");
      await awaitGrantStatus(box, scope, "grant-reactivate", AccessGrantStatus.EXPIRED);

      await activateGrant(scope, "grant-reactivate");
      await fence(given, "grant-reactivate");

      await awaitGrantStatus(box, scope, "grant-reactivate", AccessGrantStatus.EXPIRED);
    });
  });

  describe("handle 'ExpireAccessGrant', and", () => {
    it("emit 'AccessGrantExpired' once the end has arrived", async () => {
      const { box, scope, clock } = await givenActive("grant-expired");
      const expired = await recordEvents(scope, AccessGrantExpiredSchema);
      try {
        clock.advanceMinutes(60);
        expect((await expireGrant(scope, "grant-expired")).kind).toBe("ok");

        const event = await expired.waitFor(box, (e) => e.id?.uuid === "grant-expired");
        expect(event.end).toEqual(minutesIn(60));
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
      } finally {
        await expired.cancel();
      }
    });

    it("expire access at most once", async () => {
      const given = await givenActive("grant-expire-twice");
      const { box, scope, clock } = given;
      const expired = await recordEvents(scope, AccessGrantExpiredSchema);
      try {
        clock.advanceMinutes(61);
        await expireGrant(scope, "grant-expire-twice");
        await expireGrant(scope, "grant-expire-twice");
        await fence(given, "grant-expire-twice");

        await expired.waitFor(box, (e) => e.id?.uuid === "grant-expire-twice");
        expect(expired.received).toHaveLength(1);
      } finally {
        await expired.cancel();
      }
    });
  });

  describe("handle 'RevokeAccessGrant', and", () => {
    it("emit 'AccessGrantRevoked' with the revoking manager, the reason, and the time", async () => {
      const { box, scope, clock } = await givenActive("grant-revoked");
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
        await awaitGrantStatus(box, scope, "grant-revoked", AccessGrantStatus.REVOKED);
      } finally {
        await revoked.cancel();
      }
    });

    it("reject a person who does not manage the resource ('NotResourceManager')", async () => {
      const { box, scope } = await givenActive("grant-outsider");
      await expectRejection(box, scope, NotResourceManagerSchema, () =>
        revokeGrant(scope, "grant-outsider", actor, "I am done."),
      );
      await awaitGrantStatus(box, scope, "grant-outsider", AccessGrantStatus.ACTIVE);
    });

    it("revoke access that has yet to begin", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      await createGrant(scope, "grant-not-begun", { start: minutesIn(30), end: minutesIn(90) });
      await awaitGrantStatus(box, scope, "grant-not-begun", AccessGrantStatus.SCHEDULED);

      expect((await revokeGrant(scope, "grant-not-begun", "primary", "Plans changed.")).kind).toBe(
        "ok",
      );

      await awaitGrantStatus(box, scope, "grant-not-begun", AccessGrantStatus.REVOKED);
    });

    it("reject revoking expired access ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenActive("grant-revoke-expired");
      clock.advanceMinutes(60);
      await expireGrant(scope, "grant-revoke-expired");
      await awaitGrantStatus(box, scope, "grant-revoke-expired", AccessGrantStatus.EXPIRED);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(scope, "grant-revoke-expired", "primary", "Too late."),
      );
    });

    it("reject a revocation without a reason", async () => {
      const { scope } = await givenActive("grant-no-reason");
      expect((await revokeGrant(scope, "grant-no-reason", "primary", "")).kind).toBe("error");
    });

    it("leave revoked access revoked when its planned end arrives", async () => {
      const given = await givenActive("grant-revoked-end");
      const { box, scope, clock } = given;
      await revokeGrant(scope, "grant-revoked-end", "primary", "No longer needed.");
      await awaitGrantStatus(box, scope, "grant-revoked-end", AccessGrantStatus.REVOKED);

      clock.advanceMinutes(60);
      await expireGrant(scope, "grant-revoked-end");
      await activateGrant(scope, "grant-revoked-end");
      await fence(given, "grant-revoked-end");

      await awaitGrantStatus(box, scope, "grant-revoked-end", AccessGrantStatus.REVOKED);
    });
  });

  describe("handle 'ExtendAccessGrant', and", () => {
    it("emit 'AccessGrantExtended' moving the end", async () => {
      const { box, scope } = await givenActive("grant-extended");
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        await extendGrant(scope, "grant-extended", "ext-1", minutesIn(90));

        const event = await extended.waitFor(box, (e) => e.id?.uuid === "grant-extended");
        expect(event.previousEnd).toEqual(minutesIn(60));
        expect(event.end).toEqual(minutesIn(90));
        expect(event.request?.uuid).toBe("ext-1");
      } finally {
        await extended.cancel();
      }
    });

    it("reject extending revoked access ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenActive("grant-extend-revoked");
      await revokeGrant(scope, "grant-extend-revoked", "primary", "Ended.");
      await awaitGrantStatus(box, scope, "grant-extend-revoked", AccessGrantStatus.REVOKED);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        extendGrant(scope, "grant-extend-revoked", "ext-late", minutesIn(90)),
      );
    });

    it("reject extending access whose end has already arrived ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenActive("grant-lapsed");
      clock.advanceMinutes(60);
      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        extendGrant(scope, "grant-lapsed", "ext-lapsed", minutesIn(90)),
      );
    });
  });

  describe("refuse a command that would change nothing, with", () => {
    it("'AccessGrantNotPending' for activating active access", async () => {
      const { box, scope } = await givenActive("grant-active-again");
      await expectRejection(box, scope, AccessGrantNotPendingSchema, () =>
        activateGrant(scope, "grant-active-again"),
      );
    });
  });
});
