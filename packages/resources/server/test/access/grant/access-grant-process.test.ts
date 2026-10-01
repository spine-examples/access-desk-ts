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
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantLifetimeExceededSchema,
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
  approveAccessRequest,
  resourceUuid,
  seed,
  submitAndAssign,
} from "../request/given/access-request.js";
import {
  approveExtension,
  awaitGrantIssued,
  awaitGrantRevoked,
  awaitGrantView,
  givenActiveGrant,
  issueGrant,
  minutesIn,
  postExtendAccessGrant,
  revokeGrant,
  seedGrantedResource,
  testClock,
  type GrantDraft,
} from "./given/access-grant.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// Grants are issued and extended by managers approving requests.
// `ExtendAccessGrant` is posted directly only for extensions that an approval
// would not let through.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

interface Given {
  readonly box: BlackBox;
  readonly scope: BlackBoxScope;
  readonly clock: ManualClock;
}

/**
 * Registers the resource, has `primary` approve a request for access to it,
 * for the first hour of the test by default, and waits until the grant is
 * issued.
 */
async function givenGrant(id: string, draft: GrantDraft = {}): Promise<Given> {
  const clock = testClock();
  const box = await resourcesBlackBox(clock);
  const scope = box.onBehalfOf(actor);
  await seedGrantedResource(box);
  await issueGrant(box, id, draft);
  await awaitGrantIssued(box, scope, id);
  return { box, scope, clock };
}

/**
 * Proves every earlier command to the grant was handled, by waiting for the
 * rejection of a revocation from someone who does not manage the resource.
 */
async function fence({ box, scope }: Given, id: string): Promise<void> {
  await expectRejection(box, scope, NotResourceManagerSchema, () =>
    revokeGrant(box, id, "outsider", "Fence."),
  );
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

      await approveAccessRequest(box, "req-now", "primary");

      const item = await awaitGrantIssued(box, requester, "req-now");
      expect(item.start).toEqual(minutesIn(5));
      expect(item.end).toEqual(minutesIn(15));
      expect(item.revoked).toBe(false);
      expect(item.request?.uuid).toBe("req-now");
    });

    it("begin scheduled access approved within its interval at the approval, keeping its end", async () => {
      const clock = testClock();
      const box = await resourcesBlackBox(clock);
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);
      clock.advanceMinutes(10);

      await issueGrant(box, "req-within", { start: 0, end: 30 });

      const item = await awaitGrantIssued(box, requester, "req-within");
      expect(item.start).toEqual(minutesIn(10));
      expect(item.end).toEqual(minutesIn(30));
    });

    it("keep the interval of scheduled access approved before it begins", async () => {
      const box = await resourcesBlackBox(testClock());
      const requester = box.onBehalfOf(actor);
      await seed(box, [actor, "primary"]);

      await issueGrant(box, "req-future", { start: 30, end: 90 });

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

      await approveAccessRequest(box, "req-too-late", "primary");

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
        await approveExtension(box, "ext-first", "req-to-extend", 10);
        await extended.waitFor(box, (e) => e.request?.uuid === "ext-first");
        await approveExtension(box, "ext-second", "req-to-extend", 10);

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
    it("emit 'AccessGrantCreated' with the access and its period", async () => {
      const box = await resourcesBlackBox(testClock());
      const scope = box.onBehalfOf(actor);
      await seedGrantedResource(box);
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        await issueGrant(box, "grant-created");

        const event = await created.waitFor(box, (e) => e.id?.uuid === "grant-created");
        expect(event.request?.uuid).toBe("grant-created");
        expect(event.access?.grantee?.uuid).toBe(actor);
        expect(event.access?.resource?.uuid).toBe(resourceUuid);
        expect(event.access?.accessLevel?.name).toBe("Read");
        expect(event.start).toEqual(minutesIn(0));
        expect(event.end).toEqual(minutesIn(60));
      } finally {
        await created.cancel();
      }
    });
  });

  describe("handle 'ExtendAccessGrant', and", () => {
    it("extend access that began later once its start has arrived", async () => {
      const { box, scope, clock } = await givenGrant("grant-begins-later", { start: 30, end: 90 });
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        clock.advanceMinutes(30);

        await approveExtension(box, "ext-on-time", "grant-begins-later", 10);

        const event = await extended.waitFor(box, (e) => e.id?.uuid === "grant-begins-later");
        expect(event.request?.uuid).toBe("ext-on-time");
        expect(event.end).toEqual(minutesIn(100));
      } finally {
        await extended.cancel();
      }
    });

    it("reject an extension of revoked access ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-extend-revoked");
      await revokeGrant(box, "grant-extend-revoked", "primary", "Ended.");
      await awaitGrantRevoked(box, scope, "grant-extend-revoked");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-extend-revoked", "ext-late", minutesIn(90)),
      );
    });

    it("reject an extension of access that has not yet begun ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-extend-early", { start: 30, end: 90 });

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-extend-early", "ext-early", minutesIn(100)),
      );
    });

    it("reject an extension of access whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-extend-ended");
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-extend-ended", "ext-ended", minutesIn(90)),
      );
    });

    it("keep its end when an extension does not move it later", async () => {
      const given = await givenGrant("grant-not-later");
      const { box, scope } = given;
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        await postExtendAccessGrant(scope, "grant-not-later", "ext-same", minutesIn(60));
        await postExtendAccessGrant(scope, "grant-not-later", "ext-earlier", minutesIn(30));
        await fence(given, "grant-not-later");

        expect(extended.received).toHaveLength(0);
        const view = await awaitGrantIssued(box, scope, "grant-not-later");
        expect(view.end).toEqual(minutesIn(60));
      } finally {
        await extended.cancel();
      }
    });

    it("reject an extension beyond the longest access the resource permits ('AccessGrantLifetimeExceeded')", async () => {
      // The resource permits two hours in total, and the grant began at the start of the test.
      const { box, scope } = await givenGrant("grant-too-long");

      await expectRejection(box, scope, AccessGrantLifetimeExceededSchema, () =>
        postExtendAccessGrant(scope, "grant-too-long", "ext-too-long", minutesIn(121)),
      );

      const view = await awaitGrantIssued(box, scope, "grant-too-long");
      expect(view.end).toEqual(minutesIn(60));
    });

    it("extend access up to the longest the resource permits", async () => {
      const { box, scope } = await givenGrant("grant-to-limit");

      await postExtendAccessGrant(scope, "grant-to-limit", "ext-to-limit", minutesIn(120));

      const view = await awaitGrantView(
        box,
        scope,
        "grant-to-limit",
        (item) => item.end?.seconds === minutesIn(120).seconds,
      );
      expect(view.start).toEqual(minutesIn(0));
    });
  });

  describe("handle 'RevokeAccessGrant', and", () => {
    it("emit 'AccessGrantRevoked' with the revoking manager, the reason, and the time", async () => {
      const { box, scope, clock } = await givenGrant("grant-revoked");
      const revoked = await recordEvents(scope, AccessGrantRevokedSchema);
      try {
        clock.advanceMinutes(20);
        expect(
          (await revokeGrant(box, "grant-revoked", "primary", "Investigation finished.")).kind,
        ).toBe("ok");

        const event = await revoked.waitFor(box, (e) => e.id?.uuid === "grant-revoked");
        expect(event.revokedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Investigation finished.");
        expect(event.whenRevoked).toEqual(minutesIn(20));
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
        await awaitGrantRevoked(box, scope, "grant-revoked");
      } finally {
        await revoked.cancel();
      }
    });

    it("revoke access that has yet to begin", async () => {
      const { box, scope } = await givenGrant("grant-later", { start: 30, end: 90 });

      expect((await revokeGrant(box, "grant-later", "primary", "Plans changed.")).kind).toBe("ok");

      const view = await awaitGrantRevoked(box, scope, "grant-later");
      expect(view.revoked).toBe(true);
    });

    it("reject a person who does not manage the resource ('NotResourceManager')", async () => {
      const { box, scope } = await givenGrant("grant-outsider");
      await expectRejection(box, scope, NotResourceManagerSchema, () =>
        revokeGrant(box, "grant-outsider", actor, "I am done."),
      );
      const view = await awaitGrantIssued(box, scope, "grant-outsider");
      expect(view.revoked).toBe(false);
    });

    it("reject revoking access whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-revoke-ended");
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(box, "grant-revoke-ended", "primary", "Too late."),
      );
    });

    it("reject revoking access again ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-revoke-twice");
      await revokeGrant(box, "grant-revoke-twice", "primary", "No longer needed.");
      await awaitGrantRevoked(box, scope, "grant-revoke-twice");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(box, "grant-revoke-twice", "primary", "Once more."),
      );
    });

    it("reject a revocation without a reason", async () => {
      const { box, scope } = await givenGrant("grant-no-reason");

      expect((await revokeGrant(box, "grant-no-reason", "primary", "")).kind).toBe("error");

      const view = await awaitGrantIssued(box, scope, "grant-no-reason");
      expect(view.revoked).toBe(false);
    });
  });
});
