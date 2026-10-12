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
import { expect } from "vitest";
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
import { InvitationViewQuery } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_query.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import type { OrganizationMember } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import {
  eventually,
  organizationId,
  post,
  read,
  tenant,
  type Acting,
  type Running,
} from "./gateway.js";
import { enter, session, signIn, type PEOPLE, type Signed } from "./sign-in.js";

/**
 * The invitation an organization holds for an email address.
 *
 * @param organization The organization's name.
 * @param email The invited email address.
 */
export function invitationId(organization: string, email: string) {
  return create(InvitationIdSchema, {
    organization: { uuid: organization },
    invitee: { value: email },
  });
}

/**
 * Has a signed-in person accept an invitation of an organization.
 *
 * @param running The running application.
 * @param signed The signed-in person.
 * @param organization The organization's name.
 * @param claimed What the command claims instead of the truth: the email
 *   address the invitation was sent to, or the person who accepts. The
 *   signed-in person's own when left out.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function acceptInvitation(
  running: Running,
  signed: Signed,
  organization: string,
  claimed: { readonly invitee?: string; readonly person?: string } = {},
): Promise<string> {
  return post(
    running,
    signed,
    AcceptInvitationSchema,
    create(AcceptInvitationSchema, {
      id: invitationId(organization, claimed.invitee ?? signed.email),
      person: { uuid: claimed.person ?? signed.person },
      name: signed.name,
    }),
  );
}

/**
 * Has a signed-in person decline an invitation of an organization.
 *
 * @param running The running application.
 * @param signed The signed-in person.
 * @param organization The organization's name.
 * @param claimed The email address the command claims the invitation was sent
 *   to, instead of the signed-in person's own.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function declineInvitation(
  running: Running,
  signed: Signed,
  organization: string,
  claimed: { readonly invitee?: string } = {},
): Promise<string> {
  return post(
    running,
    signed,
    DeclineInvitationSchema,
    create(DeclineInvitationSchema, {
      id: invitationId(organization, claimed.invitee ?? signed.email),
      person: { uuid: signed.person },
    }),
  );
}

/**
 * Has somebody invite an email address to an organization.
 *
 * An invitation belongs to no organization's tenant, so whoever invites acts
 * in no organization, unless the test has them name one.
 *
 * @param running The running application.
 * @param as Who invites.
 * @param organization The name of the organization that invites.
 * @param email The email address to invite.
 * @param role The role the invited person is to hold. A member's when left out.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function inviteMember(
  running: Running,
  as: Acting,
  organization: string,
  email: string,
  role: OrganizationRole = OrganizationRole.MEMBER,
): Promise<string> {
  return post(
    running,
    as,
    InviteMemberSchema,
    create(InviteMemberSchema, { id: invitationId(organization, email), role }),
  );
}

/**
 * Has somebody take back an invitation of an organization.
 *
 * @param running The running application.
 * @param as Who takes it back.
 * @param organization The organization's name.
 * @param email The invited email address.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function revokeInvitation(
  running: Running,
  as: Acting,
  organization: string,
  email: string,
): Promise<string> {
  return post(
    running,
    as,
    RevokeInvitationSchema,
    create(RevokeInvitationSchema, { id: invitationId(organization, email) }),
  );
}

/**
 * Reads the invitations of an organization through the gateway as the browser client does.
 *
 * @param running The running application.
 * @param as The signed-in person who reads.
 * @param of The name of the organization whose invitations are asked for.
 * @returns The invitations, or `"refused"` when the request was not answered.
 */
export function readInvitations(
  running: Running,
  as: Signed,
  of: string,
): Promise<InvitationView[] | "refused"> {
  return read(
    running,
    as,
    InvitationViewSchema,
    InvitationViewQuery.create().organization().is(organizationId(of)).build(),
  );
}

/**
 * Reads an organization's invitation of an email address, as the application server holds it.
 *
 * @param running The running application.
 * @param organization The organization's name.
 * @param email The invited email address.
 * @returns The invitation, or `undefined` when there is none.
 */
export function invitation(running: Running, organization: string, email: string) {
  return running.identity.stand().read(InvitationViewSchema, invitationId(organization, email));
}

/**
 * Reads what an organization records about one of its members, as the application server holds it.
 *
 * @param running The running application.
 * @param organization The organization's name.
 * @param person The person's identifier.
 * @returns The membership, or `undefined` when the person is not a member.
 */
export async function member(
  running: Running,
  organization: string,
  person: string,
): Promise<OrganizationMember | undefined> {
  const view = await running.resources
    .stand()
    .read(OrganizationViewSchema, organizationId(organization), { tenantId: tenant(organization) });
  return view?.member.find((candidate) => candidate.person?.uuid === person);
}

/**
 * Has an administrator invite an email address to an organization as a
 * member, and waits until the invitation waits for an answer.
 *
 * @param running The running application.
 * @param administrator An administrator of the organization.
 * @param organization The organization's name.
 * @param email The email address to invite.
 */
export async function givenInvited(
  running: Running,
  administrator: Signed,
  organization: string,
  email: string,
): Promise<void> {
  expect(await inviteMember(running, administrator, organization, email)).toBe("ok");
  await eventually(
    () => invitation(running, organization, email),
    (invited) => invited?.status === InvitationStatus.PENDING,
  );
}

/**
 * Signs an invited person in, has them accept the invitation of the
 * organization, and has them enter it.
 *
 * @param running The running application.
 * @param person The key of one of the people of the tests, whom the organization invited.
 * @param organization The organization's name.
 * @returns The person, with a session that has entered the organization.
 */
export async function givenMember(
  running: Running,
  person: keyof typeof PEOPLE,
  organization: string,
): Promise<Signed> {
  const signed = await signIn(running, person);
  expect(await acceptInvitation(running, signed, organization)).toBe("ok");
  await eventually(
    () => session(running, signed.token),
    ({ body }) =>
      (body.organizations as { id: string; standing: string }[]).some(
        (entry) => entry.id === organization && entry.standing === "member",
      ),
  );
  return enter(running, signed, organization);
}

/**
 * Has the administrator invite `maya` to Acme, and `maya` accept and enter.
 *
 * @param running The running application.
 * @param administrator An administrator of Acme.
 * @returns `maya`, with a session that has entered Acme.
 */
export async function givenMaya(running: Running, administrator: Signed): Promise<Signed> {
  await givenInvited(running, administrator, "acme", "maya@acme.example");
  return givenMember(running, "maya", "acme");
}
