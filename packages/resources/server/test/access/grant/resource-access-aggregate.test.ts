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
  RequestedAccessCheckedSchema,
  RequestedExtensionCheckedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantNotActiveSchema,
  NotResourceManagerSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import {
  AccessAlreadyHeldSchema,
  RequestedDurationTooLongSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections_pb.js";
import { eventRecording } from "../../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
import type { ManualClock } from "../../given/manual-clock.js";
import { resourceUuid } from "../request/given/access-request.js";
import {
  awaitGrantIssued,
  awaitGrantRevoked,
  awaitGrantView,
  minutesIn,
  postCheckRequestedAccess,
  postCheckRequestedExtension,
  postCreateAccessGrant,
  postExtendAccessGrant,
  readAccessHeldBy,
  revokeGrant,
  testClock,
  writeLevel,
  type GrantOptions,
} from "./given/resource-access.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The aggregate's own commands are posted directly, so each handler is
// exercised alone. All of them address the requester's access to the payroll
// resource, on a clock that stands at the start of the test until moved.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

interface Given {
  readonly box: BlackBox;
  readonly scope: BlackBoxScope;
  readonly clock: ManualClock;
}

/** Starts with the requester holding no grants to the payroll resource. */
async function givenNoGrants(): Promise<Given> {
  const clock = testClock();
  const box = await resourcesBlackBox(clock);
  return { box, scope: box.onBehalfOf(actor), clock };
}

/** Issues a grant over `[start, end)` minutes into the test, and waits until it is issued. */
async function issue(
  { box, scope }: Given,
  id: string,
  start: number,
  end: number,
  options: GrantOptions = {},
): Promise<void> {
  const created = await recordEvents(scope, AccessGrantCreatedSchema);
  try {
    await postCreateAccessGrant(scope, id, start, end, options);
    await created.waitFor(box, (event) => event.id?.uuid === id);
  } finally {
    await created.cancel();
  }
}

/** Starts with one grant, giving read access for the first hour of the test by default. */
async function givenGrant(
  id: string,
  start = 0,
  end = 60,
  options: GrantOptions = {},
): Promise<Given> {
  const given = await givenNoGrants();
  await issue(given, id, start, end, options);
  return given;
}

/** Has `primary` revoke the grant, and waits until it is revoked. */
async function revoke({ box, scope }: Given, id: string): Promise<void> {
  const revoked = await recordEvents(scope, AccessGrantRevokedSchema);
  try {
    await revokeGrant(box, id, "primary", "No longer needed.");
    await revoked.waitFor(box, (event) => event.id?.uuid === id);
  } finally {
    await revoked.cancel();
  }
}

/**
 * Proves every earlier command was handled, by waiting for the rejection of a
 * revocation from someone who does not manage the resource.
 */
async function fence({ box, scope }: Given): Promise<void> {
  await expectRejection(box, scope, NotResourceManagerSchema, () =>
    revokeGrant(box, "fence", "outsider", "Fence."),
  );
}

describe("ResourceAccessAggregate should", () => {
  describe("handle 'CheckRequestedAccess', and", () => {
    it("emit 'RequestedAccessChecked' for access the person does not hold", async () => {
      const { box, scope } = await givenNoGrants();
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        expect((await postCheckRequestedAccess(scope, "req-free", 0, 60)).kind).toBe("ok");

        const event = await checked.waitFor(box);
        expect(event.request?.uuid).toBe("req-free");
        expect(event.id?.grantee?.uuid).toBe(actor);
        expect(event.id?.resource?.uuid).toBe(resourceUuid);
      } finally {
        await checked.cancel();
      }
    });

    it("grant nothing", async () => {
      const given = await givenNoGrants();
      const { box, scope } = given;
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        await postCheckRequestedAccess(scope, "req-first", 0, 60);
        await postCheckRequestedAccess(scope, "req-second", 0, 60);

        await checked.waitFor(box, (event) => event.request?.uuid === "req-second");
        expect(await readAccessHeldBy(scope)).toHaveLength(0);
      } finally {
        await checked.cancel();
      }
    });

    it("accept access lasting exactly as long as the resource permits", async () => {
      const { box, scope } = await givenNoGrants();
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        await postCheckRequestedAccess(scope, "req-longest", 0, 120);

        await checked.waitFor(box, (event) => event.request?.uuid === "req-longest");
      } finally {
        await checked.cancel();
      }
    });

    it("reject access lasting longer than the resource permits ('RequestedDurationTooLong')", async () => {
      const { box, scope } = await givenNoGrants();

      const rejection = await expectRejection(box, scope, RequestedDurationTooLongSchema, () =>
        postCheckRequestedAccess(scope, "req-too-long", 0, 121),
      );

      expect(rejection.id?.uuid).toBe("req-too-long");
    });

    it("reject access overlapping a grant of the same level ('AccessAlreadyHeld')", async () => {
      const { box, scope } = await givenGrant("grant-held", 0, 60);

      const rejection = await expectRejection(box, scope, AccessAlreadyHeldSchema, () =>
        postCheckRequestedAccess(scope, "req-held", 59, 90),
      );

      expect(rejection.id?.uuid).toBe("req-held");
    });

    it("reject access overlapping a grant of a stronger level ('AccessAlreadyHeld')", async () => {
      const { box, scope } = await givenGrant("grant-write", 0, 60, { accessLevel: writeLevel });

      await expectRejection(box, scope, AccessAlreadyHeldSchema, () =>
        postCheckRequestedAccess(scope, "req-weaker", 10, 20),
      );
    });

    it("reject access overlapping a grant that has yet to begin ('AccessAlreadyHeld')", async () => {
      const { box, scope } = await givenGrant("grant-later", 30, 60);

      await expectRejection(box, scope, AccessAlreadyHeldSchema, () =>
        postCheckRequestedAccess(scope, "req-into-later", 20, 40),
      );
    });

    it("accept access stronger than an overlapping grant", async () => {
      const { box, scope } = await givenGrant("grant-read", 0, 60);
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        await postCheckRequestedAccess(scope, "req-stronger", 10, 20, writeLevel);

        await checked.waitFor(box, (event) => event.request?.uuid === "req-stronger");
      } finally {
        await checked.cancel();
      }
    });

    it("accept access starting when a grant ends", async () => {
      const { box, scope } = await givenGrant("grant-before", 0, 60);
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        await postCheckRequestedAccess(scope, "req-after", 60, 90);

        await checked.waitFor(box, (event) => event.request?.uuid === "req-after");
      } finally {
        await checked.cancel();
      }
    });

    it("accept access overlapping a grant that has ended", async () => {
      const { box, scope, clock } = await givenGrant("grant-over", 0, 10);
      clock.advanceMinutes(10);
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        await postCheckRequestedAccess(scope, "req-over-ended", 5, 30);

        await checked.waitFor(box, (event) => event.request?.uuid === "req-over-ended");
      } finally {
        await checked.cancel();
      }
    });

    it("accept access overlapping a grant that was revoked", async () => {
      const given = await givenGrant("grant-withdrawn", 0, 60);
      const { box, scope } = given;
      await revoke(given, "grant-withdrawn");
      const checked = await recordEvents(scope, RequestedAccessCheckedSchema);
      try {
        await postCheckRequestedAccess(scope, "req-over-revoked", 10, 20);

        await checked.waitFor(box, (event) => event.request?.uuid === "req-over-revoked");
      } finally {
        await checked.cancel();
      }
    });
  });

  describe("handle 'CheckRequestedExtension', and", () => {
    it("emit 'RequestedExtensionChecked' with the end the grant would have, extending nothing", async () => {
      const { box, scope } = await givenGrant("grant-checked", 0, 60);
      const checked = await recordEvents(scope, RequestedExtensionCheckedSchema);
      try {
        expect(
          (await postCheckRequestedExtension(scope, "grant-checked", "ext-checked", 30)).kind,
        ).toBe("ok");

        const event = await checked.waitFor(box);
        expect(event.grant?.uuid).toBe("grant-checked");
        expect(event.request?.uuid).toBe("ext-checked");
        expect(event.proposedEnd).toEqual(minutesIn(90));
        expect(event.id?.grantee?.uuid).toBe(actor);
        const view = await awaitGrantIssued(box, scope, "grant-checked");
        expect(view.end).toEqual(minutesIn(60));
      } finally {
        await checked.cancel();
      }
    });

    it("accept an extension up to the longest access the resource permits", async () => {
      const { box, scope } = await givenGrant("grant-to-limit", 0, 60);
      const checked = await recordEvents(scope, RequestedExtensionCheckedSchema);
      try {
        await postCheckRequestedExtension(scope, "grant-to-limit", "ext-to-limit", 60);

        const event = await checked.waitFor(box);
        expect(event.proposedEnd).toEqual(minutesIn(120));
      } finally {
        await checked.cancel();
      }
    });

    it("reject an extension beyond the longest access the resource permits ('RequestedDurationTooLong')", async () => {
      const { box, scope } = await givenGrant("grant-too-long", 0, 60);

      const rejection = await expectRejection(box, scope, RequestedDurationTooLongSchema, () =>
        postCheckRequestedExtension(scope, "grant-too-long", "ext-too-long", 61),
      );

      expect(rejection.id?.uuid).toBe("ext-too-long");
    });

    it("reject an extension of a grant the person does not hold ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-held", 0, 60);

      const rejection = await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postCheckRequestedExtension(scope, "grant-unknown", "ext-unknown", 10),
      );

      expect(rejection.id?.uuid).toBe("grant-unknown");
    });

    it("reject an extension of a grant that has yet to begin ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-not-begun", 30, 60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postCheckRequestedExtension(scope, "grant-not-begun", "ext-early", 10),
      );
    });

    it("reject an extension of a grant whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-ended", 0, 60);
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postCheckRequestedExtension(scope, "grant-ended", "ext-late", 10),
      );
    });

    it("reject an extension of a revoked grant ('AccessGrantNotActive')", async () => {
      const given = await givenGrant("grant-revoked", 0, 60);
      const { box, scope } = given;
      await revoke(given, "grant-revoked");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postCheckRequestedExtension(scope, "grant-revoked", "ext-revoked", 10),
      );
    });

    it("reject an extension into another grant of the same level ('AccessAlreadyHeld')", async () => {
      const given = await givenGrant("grant-first", 0, 10);
      const { box, scope } = given;
      await issue(given, "grant-next", 20, 30);

      const rejection = await expectRejection(box, scope, AccessAlreadyHeldSchema, () =>
        postCheckRequestedExtension(scope, "grant-first", "ext-into-next", 11),
      );

      expect(rejection.id?.uuid).toBe("ext-into-next");
    });

    it("accept an extension up to the start of another grant", async () => {
      const given = await givenGrant("grant-first", 0, 10);
      const { box, scope } = given;
      await issue(given, "grant-next", 20, 30);
      const checked = await recordEvents(scope, RequestedExtensionCheckedSchema);
      try {
        await postCheckRequestedExtension(scope, "grant-first", "ext-up-to-next", 10);

        const event = await checked.waitFor(box);
        expect(event.proposedEnd).toEqual(minutesIn(20));
      } finally {
        await checked.cancel();
      }
    });

    it("accept an extension into a grant of a weaker level", async () => {
      const given = await givenGrant("grant-write", 0, 10, { accessLevel: writeLevel });
      const { box, scope } = given;
      await issue(given, "grant-read", 10, 30);
      const checked = await recordEvents(scope, RequestedExtensionCheckedSchema);
      try {
        await postCheckRequestedExtension(scope, "grant-write", "ext-over-weaker", 10);

        await checked.waitFor(box, (event) => event.request?.uuid === "ext-over-weaker");
      } finally {
        await checked.cancel();
      }
    });
  });

  describe("handle 'CreateAccessGrant', and", () => {
    it("emit 'AccessGrantCreated' with the access and its period", async () => {
      const { box, scope } = await givenNoGrants();
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        expect((await postCreateAccessGrant(scope, "grant-created", 0, 60)).kind).toBe("ok");

        const event = await created.waitFor(box);
        expect(event.id?.uuid).toBe("grant-created");
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

    it("issue several grants to the same person and resource", async () => {
      const given = await givenGrant("grant-morning", 0, 30);
      const { scope } = given;

      await issue(given, "grant-afternoon", 60, 90, { accessLevel: writeLevel });

      const held = await readAccessHeldBy(scope);
      expect(held.map((grant) => grant.id?.uuid).sort()).toEqual([
        "grant-afternoon",
        "grant-morning",
      ]);
    });

    it("issue a grant only once", async () => {
      const given = await givenGrant("grant-once", 0, 60);
      const { box, scope } = given;
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        await postCreateAccessGrant(scope, "grant-once", 0, 30);
        await fence(given);

        expect(created.received).toHaveLength(0);
        const view = await awaitGrantIssued(box, scope, "grant-once");
        expect(view.end).toEqual(minutesIn(60));
      } finally {
        await created.cancel();
      }
    });

    it("issue no grant whose period does not end after it starts", async () => {
      const given = await givenNoGrants();
      const { scope } = given;
      const created = await recordEvents(scope, AccessGrantCreatedSchema);
      try {
        await postCreateAccessGrant(scope, "grant-empty", 30, 30);
        await postCreateAccessGrant(scope, "grant-reversed", 30, 20);
        await fence(given);

        expect(created.received).toHaveLength(0);
      } finally {
        await created.cancel();
      }
    });
  });

  describe("handle 'ExtendAccessGrant', and", () => {
    it("emit 'AccessGrantExtended' with the previous and the new end", async () => {
      const { box, scope } = await givenGrant("grant-extended", 0, 60);
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        expect(
          (await postExtendAccessGrant(scope, "grant-extended", "ext-1", minutesIn(90))).kind,
        ).toBe("ok");

        const event = await extended.waitFor(box);
        expect(event.id?.uuid).toBe("grant-extended");
        expect(event.request?.uuid).toBe("ext-1");
        expect(event.previousEnd).toEqual(minutesIn(60));
        expect(event.end).toEqual(minutesIn(90));
        expect(event.access?.grantee?.uuid).toBe(actor);
        expect(event.access?.resource?.uuid).toBe(resourceUuid);
        expect(event.access?.accessLevel?.name).toBe("Read");
      } finally {
        await extended.cancel();
      }
    });

    it("give access until the new end", async () => {
      const { box, scope } = await givenGrant("grant-longer", 0, 60);
      await postExtendAccessGrant(scope, "grant-longer", "ext-longer", minutesIn(90));
      await awaitGrantView(
        box,
        scope,
        "grant-longer",
        (item) => item.end?.seconds === minutesIn(90).seconds,
      );

      await expectRejection(box, scope, AccessAlreadyHeldSchema, () =>
        postCheckRequestedAccess(scope, "req-in-added-time", 70, 80),
      );
    });

    it("extend one grant, leaving the person's other grants as they are", async () => {
      const given = await givenGrant("grant-first", 0, 10);
      const { box, scope } = given;
      await issue(given, "grant-next", 20, 30);

      await postExtendAccessGrant(scope, "grant-first", "ext-first", minutesIn(15));

      await awaitGrantView(
        box,
        scope,
        "grant-first",
        (item) => item.end?.seconds === minutesIn(15).seconds,
      );
      const next = await awaitGrantIssued(box, scope, "grant-next");
      expect(next.start).toEqual(minutesIn(20));
      expect(next.end).toEqual(minutesIn(30));
    });

    it("reject an extension of a grant the person does not hold ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-held", 0, 60);

      const rejection = await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-unknown", "ext-unknown", minutesIn(90)),
      );

      expect(rejection.id?.uuid).toBe("grant-unknown");
    });

    it("reject an extension of a grant that has yet to begin ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-not-begun", 30, 60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-not-begun", "ext-early", minutesIn(90)),
      );
    });

    it("extend a grant once its start has arrived", async () => {
      const { box, scope, clock } = await givenGrant("grant-begins-later", 30, 60);
      clock.advanceMinutes(30);
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        await postExtendAccessGrant(scope, "grant-begins-later", "ext-on-time", minutesIn(90));

        const event = await extended.waitFor(box);
        expect(event.end).toEqual(minutesIn(90));
      } finally {
        await extended.cancel();
      }
    });

    it("reject an extension of a grant whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-ended", 0, 60);
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-ended", "ext-late", minutesIn(90)),
      );
    });

    it("reject an extension of a revoked grant ('AccessGrantNotActive')", async () => {
      const given = await givenGrant("grant-revoked", 0, 60);
      const { box, scope } = given;
      await revoke(given, "grant-revoked");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        postExtendAccessGrant(scope, "grant-revoked", "ext-revoked", minutesIn(90)),
      );
    });

    it("keep its end when an extension does not move it later", async () => {
      const given = await givenGrant("grant-not-later", 0, 60);
      const { box, scope } = given;
      const extended = await recordEvents(scope, AccessGrantExtendedSchema);
      try {
        await postExtendAccessGrant(scope, "grant-not-later", "ext-same", minutesIn(60));
        await postExtendAccessGrant(scope, "grant-not-later", "ext-earlier", minutesIn(30));
        await fence(given);

        expect(extended.received).toHaveLength(0);
        const view = await awaitGrantIssued(box, scope, "grant-not-later");
        expect(view.end).toEqual(minutesIn(60));
      } finally {
        await extended.cancel();
      }
    });
  });

  describe("handle 'RevokeAccessGrant', and", () => {
    it("emit 'AccessGrantRevoked' with the revoking manager, the reason, and the time", async () => {
      const { box, scope, clock } = await givenGrant("grant-revoked", 0, 60);
      clock.advanceMinutes(20);
      const revoked = await recordEvents(scope, AccessGrantRevokedSchema);
      try {
        expect(
          (await revokeGrant(box, "grant-revoked", "primary", "Investigation finished.")).kind,
        ).toBe("ok");

        const event = await revoked.waitFor(box);
        expect(event.id?.uuid).toBe("grant-revoked");
        expect(event.revokedBy?.uuid).toBe("primary");
        expect(event.reason).toBe("Investigation finished.");
        expect(event.whenRevoked).toEqual(minutesIn(20));
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary"]);
        expect(event.access?.grantee?.uuid).toBe(actor);
        expect(event.access?.resource?.uuid).toBe(resourceUuid);
        expect(event.access?.accessLevel?.name).toBe("Read");
        await awaitGrantRevoked(box, scope, "grant-revoked");
      } finally {
        await revoked.cancel();
      }
    });

    it("revoke a grant that has yet to begin", async () => {
      const { box, scope } = await givenGrant("grant-later", 30, 60);

      expect((await revokeGrant(box, "grant-later", "primary", "Plans changed.")).kind).toBe("ok");

      const view = await awaitGrantRevoked(box, scope, "grant-later");
      expect(view.revoked).toBe(true);
    });

    it("let any manager of the resource revoke", async () => {
      const { box, scope } = await givenGrant("grant-two-managers", 0, 60, {
        manager: ["primary", "second"],
      });
      const revoked = await recordEvents(scope, AccessGrantRevokedSchema);
      try {
        await revokeGrant(box, "grant-two-managers", "second", "No longer needed.");

        const event = await revoked.waitFor(box);
        expect(event.revokedBy?.uuid).toBe("second");
        expect(event.manager.map((manager) => manager.uuid)).toEqual(["primary", "second"]);
      } finally {
        await revoked.cancel();
      }
    });

    it("revoke one grant, leaving the person's other grants as they are", async () => {
      const given = await givenGrant("grant-first", 0, 30);
      const { box, scope } = given;
      await issue(given, "grant-next", 30, 60);

      await revoke(given, "grant-first");

      await expectRejection(box, scope, AccessAlreadyHeldSchema, () =>
        postCheckRequestedAccess(scope, "req-into-next", 40, 50),
      );
      const next = await awaitGrantIssued(box, scope, "grant-next");
      expect(next.revoked).toBe(false);
    });

    it("reject a person who does not manage the resource ('NotResourceManager')", async () => {
      const { box, scope } = await givenGrant("grant-outsider", 0, 60);

      const rejection = await expectRejection(box, scope, NotResourceManagerSchema, () =>
        revokeGrant(box, "grant-outsider", actor, "I am done."),
      );

      expect(rejection.id?.uuid).toBe("grant-outsider");
      const view = await awaitGrantIssued(box, scope, "grant-outsider");
      expect(view.revoked).toBe(false);
    });

    it("reject everyone while the person holds no grants ('NotResourceManager')", async () => {
      const { box, scope } = await givenNoGrants();

      await expectRejection(box, scope, NotResourceManagerSchema, () =>
        revokeGrant(box, "grant-none", "primary", "Nothing to revoke."),
      );
    });

    it("reject a grant the person does not hold ('AccessGrantNotActive')", async () => {
      const { box, scope } = await givenGrant("grant-held", 0, 60);

      const rejection = await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(box, "grant-unknown", "primary", "Wrong grant."),
      );

      expect(rejection.id?.uuid).toBe("grant-unknown");
    });

    it("reject a grant whose end has passed ('AccessGrantNotActive')", async () => {
      const { box, scope, clock } = await givenGrant("grant-revoke-ended", 0, 60);
      clock.advanceMinutes(60);

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(box, "grant-revoke-ended", "primary", "Too late."),
      );
    });

    it("reject a grant that was already revoked ('AccessGrantNotActive')", async () => {
      const given = await givenGrant("grant-revoke-twice", 0, 60);
      const { box, scope } = given;
      await revoke(given, "grant-revoke-twice");

      await expectRejection(box, scope, AccessGrantNotActiveSchema, () =>
        revokeGrant(box, "grant-revoke-twice", "primary", "Once more."),
      );
    });

    it("reject a revocation without a reason", async () => {
      const { box, scope } = await givenGrant("grant-no-reason", 0, 60);

      expect((await revokeGrant(box, "grant-no-reason", "primary", "")).kind).toBe("error");

      const view = await awaitGrantIssued(box, scope, "grant-no-reason");
      expect(view.revoked).toBe(false);
    });
  });
});
