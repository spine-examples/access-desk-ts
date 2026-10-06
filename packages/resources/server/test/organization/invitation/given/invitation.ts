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
import {
  AcceptInvitationSchema,
  DeclineInvitationSchema,
  InviteMemberSchema,
  RevokeInvitationSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/commands_pb.js";
import {
  InvitationViewSchema,
  type InvitationView,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/invitation_pb.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import { readAll } from "../../../given/resources-context.js";

/** Posts `InviteMember` for the person with the given email address. */
export function inviteMember(
  scope: BlackBoxScope,
  invitee: string,
  role: OrganizationRole = OrganizationRole.MEMBER,
) {
  return scope.post(
    InviteMemberSchema,
    create(InviteMemberSchema, { id: { invitee: { value: invitee } }, role }),
  );
}

/** Posts `RevokeInvitation` for the invitation of the person. */
export function revokeInvitation(scope: BlackBoxScope, invitee: string) {
  return scope.post(
    RevokeInvitationSchema,
    create(RevokeInvitationSchema, { id: { invitee: { value: invitee } } }),
  );
}

/** Posts `AcceptInvitation` on behalf of the invited person. */
export function acceptInvitation(
  scope: BlackBoxScope,
  invitee: string,
  person: string,
  name: string = person,
) {
  return scope.post(
    AcceptInvitationSchema,
    create(AcceptInvitationSchema, {
      id: { invitee: { value: invitee } },
      person: { uuid: person },
      name,
    }),
  );
}

/** Posts `DeclineInvitation` on behalf of the invited person. */
export function declineInvitation(scope: BlackBoxScope, invitee: string, person: string) {
  return scope.post(
    DeclineInvitationSchema,
    create(DeclineInvitationSchema, {
      id: { invitee: { value: invitee } },
      person: { uuid: person },
    }),
  );
}

/** Waits until the invitation of the person has got as far as expected. */
export async function awaitInvitation(
  box: BlackBox,
  scope: BlackBoxScope,
  invitee: string,
  status: InvitationStatus = InvitationStatus.INVITATION_PENDING,
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
