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
import { MembershipIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  MembershipViewSchema,
  type MembershipView,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { MembershipViewQuery } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_query.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { AddOrganizationMemberSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
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
import { session, signIn, type PEOPLE, type Signed } from "./sign-in.js";

/**
 * Has somebody add a person to an organization by their email address.
 *
 * @param running The running application.
 * @param as Who adds the person.
 * @param organization The organization's name.
 * @param email The email address of the person to add.
 * @param role The role the person is to hold. A member's when left out.
 * @param addedBy The identifier of the administrator the command names as the
 *   one who adds. Whoever adds when left out, so any other person here is one
 *   the gateway must refuse.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function addMember(
  running: Running,
  as: Acting,
  organization: string,
  email: string,
  role: OrganizationRole = OrganizationRole.MEMBER,
  addedBy: string = as.person,
): Promise<string> {
  return post(
    running,
    as,
    AddMemberSchema,
    create(AddMemberSchema, {
      id: { emailAddress: { value: email } },
      organization: organizationId(organization),
      role,
      addedBy: { uuid: addedBy },
    }),
  );
}

/**
 * Tries to add a person to an organization's members in Resources, through
 * the gateway.
 *
 * People are not allowed to do that. Identity adds a member itself, once the
 * person joins.
 *
 * @param running The running application.
 * @param as Who adds the person.
 * @param organization The organization's name.
 * @param person The identifier of the person to add.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function addOrganizationMember(
  running: Running,
  as: Acting,
  organization: string,
  person: string,
): Promise<string> {
  return post(
    running,
    as,
    AddOrganizationMemberSchema,
    create(AddOrganizationMemberSchema, {
      organizationId: organizationId(organization),
      person: { uuid: person },
      emailAddress: { value: "somebody@acme.example" },
      role: OrganizationRole.ADMINISTRATOR,
    }),
  );
}

/**
 * Reads who was added to an organization through the gateway, as the browser
 * client does.
 *
 * @param running The running application.
 * @param as The signed-in person who reads.
 * @param of The name of the organization whose memberships are asked for.
 * @returns The memberships, or `"refused"` when the request was not answered.
 */
export function readMemberships(
  running: Running,
  as: Signed,
  of: string,
): Promise<MembershipView[] | "refused"> {
  return read(
    running,
    as,
    MembershipViewSchema,
    MembershipViewQuery.create().organization().is(organizationId(of)).build(),
  );
}

/**
 * Reads the membership of an email address, as the application server holds it.
 *
 * @param running The running application.
 * @param email The email address, in lower case.
 * @returns The membership, or `undefined` when the address was added to no organization.
 */
export function membership(running: Running, email: string) {
  return running.identity
    .stand()
    .read(MembershipViewSchema, create(MembershipIdSchema, { emailAddress: { value: email } }));
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
 * Has an administrator add an email address to their organization as a
 * member, and waits until the address is listed.
 *
 * @param running The running application.
 * @param administrator An administrator of the organization.
 * @param organization The organization's name.
 * @param email The email address to add.
 */
export async function givenAdded(
  running: Running,
  administrator: Signed,
  organization: string,
  email: string,
): Promise<void> {
  expect(await addMember(running, administrator, organization, email)).toBe("ok");
  await eventually(
    () => membership(running, email),
    (added) => added?.organization?.uuid === organization,
  );
}

/**
 * Signs in a person who was added to an organization, and checks that the
 * session works in it.
 *
 * @param running The running application.
 * @param person The key of one of the people of the tests, who was added to the organization.
 * @param organization The organization's name.
 * @returns The person, with a session in the organization.
 */
export async function givenMember(
  running: Running,
  person: keyof typeof PEOPLE,
  organization: string,
): Promise<Signed> {
  const signed = await signIn(running, person);
  const { body } = await session(running, signed.token);
  expect((body.organization as { id: string } | null)?.id).toBe(organization);
  return signed;
}

/**
 * Has the administrator add `maya` to Acme, and `maya` sign in.
 *
 * @param running The running application.
 * @param administrator An administrator of Acme.
 * @returns `maya`, with a session in Acme.
 */
export async function givenMaya(running: Running, administrator: Signed): Promise<Signed> {
  await givenAdded(running, administrator, "acme", "maya@acme.example");
  return givenMember(running, "maya", "acme");
}
