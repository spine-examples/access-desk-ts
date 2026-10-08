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
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  loadIdentityContext,
  identityBlackBox,
} from "../given/identity-context.js";
import {
  acceptInvitation,
  awaitInvitation,
  inviteMember,
  revokeInvitation,
  declineInvitation,
} from "./given/invitation.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("InvitationViewProjection should", () => {
  describe("react on 'MemberInvited', and", () => {
    it("list the invitation as waiting to be accepted", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      expect((await inviteMember(scope, "noah", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");

      const view = await awaitInvitation(box, scope, "noah");
      expect(view.role).toBe(OrganizationRole.ADMINISTRATOR);
      expect(view.invitee?.value).toBe("noah");
      expect(view.acceptedBy).toBeUndefined();
    });
  });

  describe("react on 'InvitationRevoked', and", () => {
    it("show the invitation as taken back", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");

      await awaitInvitation(box, scope, "noah", InvitationStatus.REVOKED);
    });
  });

  describe("react on 'InvitationAccepted', and", () => {
    it("show the invitation as accepted, and by whom", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      expect((await acceptInvitation(box, "noah", "person-noah")).kind).toBe("ok");

      const view = await awaitInvitation(box, scope, "noah", InvitationStatus.ACCEPTED);
      expect(view.acceptedBy?.uuid).toBe("person-noah");
    });
  });

  describe("react on 'InvitationDeclined', and", () => {
    it("mark the invitation as declined, with nobody having accepted it", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await inviteMember(scope, "noah")).kind).toBe("ok");

      expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");

      const view = await awaitInvitation(box, scope, "noah", InvitationStatus.DECLINED);
      expect(view.acceptedBy).toBeUndefined();
    });
  });
});
