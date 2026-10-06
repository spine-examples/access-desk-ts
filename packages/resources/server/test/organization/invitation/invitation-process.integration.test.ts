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
import { InvitationNotPendingSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/rejections_pb.js";
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
import { awaitMember, createOrganization, readOrganizationViews } from "../given/organization.js";

const { expectRejection } = eventRecording(testActorContext);

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("InvitationProcessManager should", () => {
  it("make the invited person a member with the role they were invited to", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    expect((await inviteMember(scope, "noah", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");

    expect((await acceptInvitation(box, "noah", "person-noah", "Noah Reyes")).kind).toBe("ok");

    const member = await awaitMember(box, scope, "person-noah");
    expect(member).toMatchObject({
      name: "Noah Reyes",
      role: OrganizationRole.ADMINISTRATOR,
    });
    await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_ACCEPTED);
  });

  it("add nobody for an invitation that was taken back", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");
    expect((await revokeInvitation(scope, "noah")).kind).toBe("ok");

    await expectRejection(box, scope, InvitationNotPendingSchema, () =>
      acceptInvitation(box, "noah", "person-noah"),
    );

    const [view] = await readOrganizationViews(scope);
    expect(view?.member).toEqual([]);
  });

  it("add nobody for an invitation the invited person declined", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");

    expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");

    await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_DECLINED);
    await expectRejection(box, scope, InvitationNotPendingSchema, () =>
      acceptInvitation(box, "noah", "person-noah"),
    );
    const [view] = await readOrganizationViews(scope);
    expect(view?.member).toEqual([]);
  });

  it("make a person a member who declined a first invitation and accepted a second", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    expect((await inviteMember(scope, "noah")).kind).toBe("ok");
    expect((await declineInvitation(box, "noah", "person-noah")).kind).toBe("ok");
    await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_DECLINED);

    expect((await inviteMember(scope, "noah", OrganizationRole.ADMINISTRATOR)).kind).toBe("ok");
    await awaitInvitation(box, scope, "noah", InvitationStatus.INVITATION_PENDING);
    expect((await acceptInvitation(box, "noah", "person-noah", "Noah Reyes")).kind).toBe("ok");

    const member = await awaitMember(box, scope, "person-noah");
    expect(member).toMatchObject({
      name: "Noah Reyes",
      role: OrganizationRole.ADMINISTRATOR,
    });
    const invitation = await awaitInvitation(
      box,
      scope,
      "noah",
      InvitationStatus.INVITATION_ACCEPTED,
    );
    expect(invitation.acceptedBy?.uuid).toBe("person-noah");
    const [view] = await readOrganizationViews(scope);
    expect(view?.member).toHaveLength(1);
  });
});
