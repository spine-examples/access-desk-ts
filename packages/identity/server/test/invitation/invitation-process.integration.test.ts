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
import { InvitationNotPendingSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/rejections_pb.js";
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
  organizations,
} from "../given/identity-context.js";
import {
  acceptInvitation,
  awaitInvitation,
  declineInvitation,
  inviteMember,
  organizationId,
  revokeInvitation,
} from "./given/invitation.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("InvitationProcessManager should", () => {
  it("make the invited person a member with the role they were invited to", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await inviteMember(scope, "noah", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");

    expect((await acceptInvitation(box, "noah", "person-noah", "Noah Reyes")).kind).toBe("ok");

    await awaitInvitation(box, scope, "noah", InvitationStatus.ACCEPTED);
    expect(organizations.added).toEqual([
      {
        organization: organizationId,
        person: "person-noah",
        name: "Noah Reyes",
        role: OrganizationRole.ADMINISTRATOR,
      },
    ]);
  });

  it("keep the invitation waiting when the organization does not add the person", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");
    await awaitInvitation(box, scope, "noah", InvitationStatus.PENDING);
    organizations.refusing = true;

    await acceptInvitation(box, "noah", "person-noah").catch(() => undefined);

    organizations.refusing = false;
    expect((await acceptInvitation(box, "noah", "person-noah", "Noah Reyes")).kind).toBe("ok");
    await awaitInvitation(box, scope, "noah", InvitationStatus.ACCEPTED);
    expect(organizations.added.map((member) => member.person)).toEqual(["person-noah"]);
  });

  it("add nobody for an invitation that was taken back", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");
    expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");

    await expectRejection(box, scope, InvitationNotPendingSchema, () =>
      acceptInvitation(box, "noah", "person-noah"),
    );

    expect(organizations.added).toEqual([]);
  });

  it("add nobody for an invitation the invited person declined", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");

    expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");

    await awaitInvitation(box, scope, "noah", InvitationStatus.DECLINED);
    await expectRejection(box, scope, InvitationNotPendingSchema, () =>
      acceptInvitation(box, "noah", "person-noah"),
    );
    expect(organizations.added).toEqual([]);
  });

  it("make a person a member who declined a first invitation and accepted a second", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");
    expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");
    await awaitInvitation(box, scope, "noah", InvitationStatus.DECLINED);

    expect((await inviteMember(scope, "noah", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");
    await awaitInvitation(box, scope, "noah", InvitationStatus.PENDING);
    expect((await acceptInvitation(box, "noah", "person-noah", "Noah Reyes")).kind).toBe("ok");

    const invitation = await awaitInvitation(box, scope, "noah", InvitationStatus.ACCEPTED);
    expect(invitation.acceptedBy?.uuid).toBe("person-noah");
    expect(organizations.added).toEqual([
      {
        organization: organizationId,
        person: "person-noah",
        name: "Noah Reyes",
        role: OrganizationRole.ADMINISTRATOR,
      },
    ]);
  });
});
