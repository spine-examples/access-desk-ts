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
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/events_pb.js";
import {
  InvitationNotPendingSchema,
  MemberAlreadyInvitedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/rejections_pb.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import { eventRecording } from "../../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../../given/resources-context.js";
import {
  acceptInvitation,
  awaitInvitation,
  declineInvitation,
  inviteMember,
  revokeInvitation,
} from "./given/invitation.js";
import { createOrganization } from "../given/organization.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

const administrator = OrganizationRole.ADMINISTRATOR;

describe("InvitationProcessManager should", () => {
  describe("handle 'InviteMember', and", () => {
    it("emit 'MemberInvited' for the name in lower case, with the role the administrator named", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const events = await recordEvents(scope, MemberInvitedSchema);

      expect((await inviteMember(scope, " Noah ", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(MemberInvitedSchema, { id: { invitee: { value: "noah" } }, role: administrator }),
      );
      await events.cancel();
    });

    it("reject a person already invited, in any case, with 'MemberAlreadyInvited'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      await expectRejection(box, scope, MemberAlreadyInvitedSchema, () =>
        inviteMember(scope, "NOAH"),
      );
    });

    it("invite again a person whose invitation was taken back", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_REVOKED);

      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_PENDING);
    });
  });

  describe("handle 'RevokeInvitation', and", () => {
    it("emit 'InvitationRevoked'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      const events = await recordEvents(scope, InvitationRevokedSchema);

      expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");

      expect((await events.waitFor(box)).id?.invitee?.value).toBe("noah");
      await events.cancel();
    });

    it("reject an invitation that is not waiting with 'InvitationNotPending'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        revokeInvitation(scope, "noah"),
      );
    });
  });

  describe("handle 'AcceptInvitation', and", () => {
    it("emit 'InvitationAccepted' with the role the invitation gives", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await inviteMember(scope, "noah", administrator)).kind).toBe("ok");
      const events = await recordEvents(scope, InvitationAcceptedSchema);

      expect((await acceptInvitation(scope, "Noah", "person-noah", "Noah Reyes")).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(InvitationAcceptedSchema, {
          id: { invitee: { value: "noah" } },
          person: { uuid: "person-noah" },
          name: "Noah Reyes",
          role: administrator,
        }),
      );
      await events.cancel();
    });

    it("reject an invitation nobody issued with 'InvitationNotPending'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        acceptInvitation(scope, "mallory", "person-mallory"),
      );
    });

    it("reject an invitation already accepted with 'InvitationNotPending'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await acceptInvitation(scope, "noah", "person-noah")).kind).toBe("ok");

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        acceptInvitation(scope, "noah", "person-somebody-else"),
      );
    });
  });

  describe("handle 'DeclineInvitation', and", () => {
    it("emit 'InvitationDeclined' with the person who declined", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      const events = await recordEvents(scope, InvitationDeclinedSchema);

      expect((await declineInvitation(scope, "Noah", "person-noah")).kind).toBe("ok");

      expect(await events.waitFor(box)).toEqual(
        create(InvitationDeclinedSchema, {
          id: { invitee: { value: "noah" } },
          person: { uuid: "person-noah" },
        }),
      );
      await events.cancel();
    });

    it("reject an invitation nobody issued with 'InvitationNotPending'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        declineInvitation(scope, "noah", "person-noah"),
      );
    });

    it("reject an invitation already declined with 'InvitationNotPending'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await declineInvitation(scope, "noah", "person-noah")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_DECLINED);

      await expectRejection(box, scope, InvitationNotPendingSchema, () =>
        declineInvitation(scope, "noah", "person-noah"),
      );
    });

    it("let an administrator invite again a person who declined", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");
      expect((await declineInvitation(scope, "noah", "person-noah")).kind).toBe("ok");
      await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_DECLINED);

      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_PENDING);
    });
  });
});
