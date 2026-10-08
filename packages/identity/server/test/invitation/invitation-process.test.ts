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

import { create } from "@bufbuild/protobuf";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  InvitationAcceptedSchema,
  InvitationDeclinedSchema,
  InvitationRevokedSchema,
  MemberInvitedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/events_pb.js";
import {
  NotInvitedPersonSchema,
  InvitationNotPendingSchema,
  MemberAlreadyInvitedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/rejections_pb.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  loadIdentityContext,
  expectRejection,
  identityBlackBox,
  recordEvents,
} from "../given/identity-context.js";
import {
  acceptInvitation,
  awaitInvitation,
  declineInvitation,
  invitationId,
  inviteMember,
  revokeInvitation,
} from "./given/invitation.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

const administrator = OrganizationRole.ADMINISTRATOR;

describe("InvitationProcessManager should", () => {
  describe("handle 'InviteMember', and", () => {
    it("emit 'MemberInvited' with the role the administrator named", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const events = await recordEvents(scope, MemberInvitedSchema);

      expect((await inviteMember(scope, "noah", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(MemberInvitedSchema, {
          id: invitationId("noah"),
          role: administrator,
        }),
      );
      await events.cancel();
    });

    it("reject a person already invited with 'MemberAlreadyInvited'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      await expectRejection(box, scope, MemberAlreadyInvitedSchema, () =>
        inviteMember(scope, "noah"),
      );
    });

    it("find the invitation by the email address in lower case, however it is written", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, " Noah@Acme.example ")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah@acme.example", InvitationStatus.PENDING);

      await expectRejection(box, scope, MemberAlreadyInvitedSchema, () =>
        inviteMember(scope, "NOAH@ACME.EXAMPLE"),
      );
    });

    it("invite again a person whose invitation was taken back", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah", InvitationStatus.REVOKED);

      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      await awaitInvitation(box, scope, "noah", InvitationStatus.PENDING);
    });
  });

  describe("handle 'RevokeInvitation', and", () => {
    it("emit 'InvitationRevoked'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      const events = await recordEvents(scope, InvitationRevokedSchema);

      expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(InvitationRevokedSchema, {
          id: invitationId("noah"),
        }),
      );
      await events.cancel();
    });

    it("reject an invitation that is not waiting with 'InvitationNotPending'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        revokeInvitation(scope, "noah"),
      );
    });
  });

  describe("handle 'AcceptInvitation', and", () => {
    it("emit 'InvitationAccepted' with the role the invitation gives", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah", administrator)).kind).toBe("ok");
      const events = await recordEvents(scope, InvitationAcceptedSchema);

      expect((await acceptInvitation(box, "noah", "person-noah", "Noah Reyes")).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(InvitationAcceptedSchema, {
          id: invitationId("noah"),
          person: { uuid: "person-noah" },
          name: "Noah Reyes",
          role: administrator,
        }),
      );
      await events.cancel();
    });

    it("reject an answer somebody else gives for the person with 'NotInvitedPerson'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah", administrator)).kind).toBe("ok");

      const rejection = await expectRejection(box, scope, NotInvitedPersonSchema, () =>
        acceptInvitation(box, "noah", "person-noah", "Noah Reyes", "person-mallory"),
      );

      expect(rejection).toEqual(
        create(NotInvitedPersonSchema, {
          id: invitationId("noah"),
          person: { uuid: "person-noah" },
        }),
      );
      await awaitInvitation(box, scope, "noah", InvitationStatus.PENDING);
    });

    it("reject an invitation nobody issued with 'InvitationNotPending'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        acceptInvitation(box, "mallory", "person-mallory"),
      );
    });

    it("reject an invitation already accepted with 'InvitationNotPending'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await acceptInvitation(box, "noah", "person-noah")).kind).toBe("ok");

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        acceptInvitation(box, "noah", "person-somebody-else"),
      );
    });
  });

  describe("handle 'DeclineInvitation', and", () => {
    it("emit 'InvitationDeclined' with the person who declined", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      const events = await recordEvents(scope, InvitationDeclinedSchema);

      expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(InvitationDeclinedSchema, {
          id: invitationId("noah"),
          person: { uuid: "person-noah" },
        }),
      );
      await events.cancel();
    });

    it("reject an answer somebody else gives for the person with 'NotInvitedPerson'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      const rejection = await expectRejection(box, scope, NotInvitedPersonSchema, () =>
        declineInvitation(box, "noah", "person-noah", "person-mallory"),
      );

      expect(rejection.person?.uuid).toBe("person-noah");
      await awaitInvitation(box, scope, "noah", InvitationStatus.PENDING);
    });

    it("reject an invitation nobody issued with 'InvitationNotPending'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        declineInvitation(box, "noah", "person-noah"),
      );
    });

    it("reject an invitation already declined with 'InvitationNotPending'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah", InvitationStatus.DECLINED);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        declineInvitation(box, "noah", "person-noah"),
      );
    });

    it("let an administrator invite again a person who declined", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah", InvitationStatus.DECLINED);

      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      await awaitInvitation(box, scope, "noah", InvitationStatus.PENDING);
    });
  });
});
