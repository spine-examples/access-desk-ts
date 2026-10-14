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
import {
  Assign,
  Command,
  ProcessManager,
  React,
  Throws,
  type EntityOptions,
} from "@spine-event-engine/server";
import type {
  MembershipId,
  PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { AddMember } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  MemberAddedSchema,
  MemberAddingStartedSchema,
  type MemberAdded,
  type MemberAddingStarted,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import { MembershipSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { EmailAddressAlreadyMember } from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections.js";
import {
  JoinOrganizationSchema,
  RegisterPersonSchema,
  type JoinOrganization,
  type RegisterPerson,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/commands_pb.js";
import type {
  OrganizationJoined,
  PersonRegistered,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import {
  RegisterPersonEmailSchema,
  type RegisterPersonEmail,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_commands_pb.js";
import type { PersonEmailRegistered } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import type { PersonEmailAlreadyRegistered } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections_pb.js";
import type { OrganizationMembers } from "./organization-members.js";

/**
 * A person's membership in an organization, under their email address.
 *
 * 1. An administrator adds the address, and says which role the person holds.
 *    An address belongs to at most one organization.
 * 2. The address is registered. When nobody has signed in under it yet, a new
 *    person is registered for it, without an account. Whoever signs in under
 *    the address later is that person.
 * 3. The person joins the organization.
 *
 * Adding the address to the same organization again runs the adding again,
 * which also finishes one the organization refused before.
 */
export class MembershipProcessManager extends ProcessManager<
  MembershipId,
  typeof MembershipSchema
> {
  /** The service that adds a person to the members of an organization. */
  readonly #members: OrganizationMembers;

  /**
   * @param options What Spine gives every membership it constructs.
   * @param members The service that adds a person to the members of an organization.
   */
  constructor(
    options: EntityOptions<MembershipId, typeof MembershipSchema>,
    members: OrganizationMembers,
  ) {
    super(options);
    this.#members = members;
  }

  /**
   * Starts adding the address, unless it belongs to another organization
   * already.
   */
  @Assign
  @Throws(EmailAddressAlreadyMember)
  addMember(command: AddMember): MemberAddingStarted {
    const { organization, role } = command;
    const current = this.state.organization;
    if (current !== undefined && current.uuid !== organization?.uuid) {
      throw EmailAddressAlreadyMember.create({ id: this.id });
    }
    this.update((draft) => {
      draft.organization = organization;
      draft.role = role;
    });
    return create(MemberAddingStartedSchema, { id: this.id, organization, role });
  }

  /** Registers the address. */
  @Command
  onMemberAddingStarted(_event: MemberAddingStarted): RegisterPersonEmail {
    return create(RegisterPersonEmailSchema, {
      emailAddress: this.id.emailAddress,
      invoker: { case: "membership", value: this.id },
    });
  }

  /** Registers the new person the address was registered for. */
  @Command
  onPersonEmailRegistered(event: PersonEmailRegistered): RegisterPerson {
    return create(RegisterPersonSchema, {
      id: event.person,
      emailAddress: this.id.emailAddress,
      invoker: { case: "membership", value: this.id },
    });
  }

  /** Has the organization list the new person, then has them join it. */
  @Command
  onPersonRegistered(event: PersonRegistered): Promise<JoinOrganization> {
    return this.#join(event.id);
  }

  /**
   * Has the organization list the person the address already belongs to, then
   * has them join it.
   */
  @Command
  onPersonEmailAlreadyRegistered(
    rejection: PersonEmailAlreadyRegistered,
  ): Promise<JoinOrganization> {
    return this.#join(rejection.person);
  }

  /** Finishes adding the address, as the person has joined the organization. */
  @React
  onOrganizationJoined(event: OrganizationJoined): MemberAdded {
    const { id: person, organization } = event;
    return create(MemberAddedSchema, { id: this.id, person, organization, role: this.state.role });
  }

  /**
   * Has the organization list the person among its members, waits until it
   * does, and has the person join it.
   */
  async #join(person: PersonId | undefined): Promise<JoinOrganization> {
    const { organization, role } = this.state;
    if (person === undefined || organization === undefined) {
      throw new Error("A person is added to the organization the address was added to.");
    }
    const email = this.id.emailAddress;
    if (email === undefined) {
      throw new Error("A membership names an email address.");
    }
    await this.#members.add({ organization, person, email, role });
    return create(JoinOrganizationSchema, { id: person, membership: this.id, organization });
  }
}
