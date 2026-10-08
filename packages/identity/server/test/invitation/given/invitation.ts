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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { InvitationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AcceptInvitationSchema,
  DeclineInvitationSchema,
  InviteMemberSchema,
  RevokeInvitationSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/commands_pb.js";
import {
  InvitationViewSchema,
  type InvitationView,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import { readAll } from "../../given/identity-context.js";

/** The organization that invites people in these tests. */
export const organizationId = "acme";

/** The invitation the organization issues to the email address. */
export function invitationId(invitee: string, organization: string = organizationId) {
  return create(InvitationIdSchema, {
    organization: { uuid: organization },
    invitee: { value: invitee },
  });
}

/** Posts `InviteMember` for the person with the given email address. */
export function inviteMember(
  scope: BlackBoxScope,
  invitee: string,
  role: OrganizationRole = OrganizationRole.MEMBER,
  organization: string = organizationId,
) {
  return scope.post(
    InviteMemberSchema,
    create(InviteMemberSchema, { id: invitationId(invitee, organization), role }),
  );
}

/** Posts `RevokeInvitation` for the invitation of the person. */
export function revokeInvitation(
  scope: BlackBoxScope,
  invitee: string,
  organization: string = organizationId,
) {
  return scope.post(
    RevokeInvitationSchema,
    create(RevokeInvitationSchema, { id: invitationId(invitee, organization) }),
  );
}

/**
 * Posts `AcceptInvitation` for the person, who acts for themselves unless
 * somebody else is named as acting.
 */
export function acceptInvitation(
  box: BlackBox,
  invitee: string,
  person: string,
  name: string = person,
  acting: string = person,
  organization: string = organizationId,
) {
  return box.onBehalfOf(acting).post(
    AcceptInvitationSchema,
    create(AcceptInvitationSchema, {
      id: invitationId(invitee, organization),
      person: { uuid: person },
      name,
    }),
  );
}

/**
 * Posts `DeclineInvitation` for the person, who acts for themselves unless
 * somebody else is named as acting.
 */
export function declineInvitation(
  box: BlackBox,
  invitee: string,
  person: string,
  acting: string = person,
  organization: string = organizationId,
) {
  return box.onBehalfOf(acting).post(
    DeclineInvitationSchema,
    create(DeclineInvitationSchema, {
      id: invitationId(invitee, organization),
      person: { uuid: person },
    }),
  );
}

/** Waits until the invitation of the person has got as far as expected. */
export async function awaitInvitation(
  box: BlackBox,
  scope: BlackBoxScope,
  invitee: string,
  status: InvitationStatus = InvitationStatus.PENDING,
): Promise<InvitationView> {
  const matches = (view: InvitationView): boolean =>
    view.id?.invitee?.value === invitee && view.status === status;
  const views = await box.eventually(
    () => readAll(scope, InvitationViewSchema, "query-invitation-view"),
    (rows) => rows.some(matches),
  );
  const found = views.find(matches);
  if (found === undefined) {
    throw new Error(`Invitation of "${invitee}" not found.`);
  }
  return found;
}
