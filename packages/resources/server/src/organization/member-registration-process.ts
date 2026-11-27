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

import { create, isMessage } from "@bufbuild/protobuf";
import {
  Assign,
  Command,
  ProcessManager,
  React,
  Throws,
  type EntityOptions,
} from "@spine-event-engine/server";
import type { MembershipId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { ClaimMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import { MemberClaimedByOtherOrganizationSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections_pb.js";
import {
  AddMemberSchema,
  type AddMember,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import type { MemberAdded } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import type { MemberAlreadyAdded } from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections_pb.js";
import {
  ResolveMemberSchema,
  type ResolveMember,
  type RegisterMember,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_commands_pb.js";
import {
  MemberRegisteredSchema,
  MemberRegistrationFailedSchema,
  MemberRegistrationStartedSchema,
  MemberResolvedSchema,
  type MemberRegistered,
  type MemberRegistrationFailed,
  type MemberRegistrationStarted,
  type MemberResolved,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_events_pb.js";
import { MemberRegistrationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_pb.js";
import type { MemberOfOtherOrganization as MemberOfOtherOrganizationRejection } from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_rejections_pb.js";
import {
  MemberAlreadyRegistered,
  MemberOfOtherOrganization,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_rejections.js";
import type { Memberships } from "./memberships.js";

/**
 * The registration of a person as a member of an organization, by their email
 * address.
 *
 * 1. An organization administrator registers a person in the organization by
 *    their email address, and chooses the role the person holds.
 * 2. The person under the address is claimed as a member of the organization.
 *    When another organization claimed the person, the registration fails.
 * 3. The organization lists the person among its members, as added by the
 *    organization administrator.
 */
export class MemberRegistrationProcessManager extends ProcessManager<
  MembershipId,
  typeof MemberRegistrationSchema
> {
  /** The memberships of people in organizations. */
  readonly #memberships: Memberships;

  /**
   * @param options What Spine gives every registration it constructs.
   * @param memberships The memberships of people in organizations.
   */
  constructor(
    options: EntityOptions<MembershipId, typeof MemberRegistrationSchema>,
    memberships: Memberships,
  ) {
    super(options);
    this.#memberships = memberships;
  }

  /**
   * Starts registering the person.
   *
   * Registering a person the organization lists already is rejected with
   * `MemberAlreadyRegistered`.
   */
  @Assign
  @Throws(MemberAlreadyRegistered)
  registerMember(command: RegisterMember): MemberRegistrationStarted {
    const { organization, role, registeredBy } = command;
    if (organization === undefined) {
      throw new Error("`RegisterMember` names no organization.");
    }
    const { person: registered } = this.state;
    if (registered !== undefined) {
      throw MemberAlreadyRegistered.create({ id: this.id, organization, person: registered });
    }
    this.update((draft) => {
      draft.organization = organization;
      draft.role = role;
      draft.registeredBy = registeredBy;
    });
    return create(MemberRegistrationStartedSchema, { id: this.id, organization, role, registeredBy });
  }

  /** Resolves the member, as their registration started. */
  @Command
  onMemberRegistrationStarted(_event: MemberRegistrationStarted): ResolveMember {
    return create(ResolveMemberSchema, { id: this.id });
  }

  /**
   * Resolves the email address to the person it belongs to, as a member of
   * the organization.
   *
   * Resolving a person of another organization is rejected with
   * `MemberOfOtherOrganization`.
   */
  @Assign
  @Throws(MemberOfOtherOrganization)
  async resolveMember(_command: ResolveMember): Promise<MemberResolved> {
    const { organization, registeredBy } = this.state;
    if (organization === undefined) {
      throw new Error("The registration names no organization, as it has not started.");
    }
    const answer = await this.#memberships.claim(
      create(ClaimMemberSchema, { id: this.id, organization }),
    );
    if (isMessage(answer, MemberClaimedByOtherOrganizationSchema)) {
      throw MemberOfOtherOrganization.create({ id: this.id, organization });
    }
    const { person } = answer;
    return create(MemberResolvedSchema, { id: this.id, organization, person, registeredBy });
  }

  /** Adds the person to the organization's members, as they were resolved. */
  @Command
  onMemberResolved(event: MemberResolved): AddMember {
    const { organization, person } = event;
    return create(AddMemberSchema, {
      id: organization,
      person,
      emailAddress: this.id.emailAddress,
      role: this.state.role,
      addedBy: this.state.registeredBy ?? person,
    });
  }

  /** Records that the registration failed, as another organization claimed the person. */
  @React
  onMemberOfOtherOrganization(
    rejection: MemberOfOtherOrganizationRejection,
  ): MemberRegistrationFailed {
    return create(MemberRegistrationFailedSchema, {
      id: this.id,
      organization: rejection.organization,
      registeredBy: this.state.registeredBy,
    });
  }

  /** Finishes registering the person, as the organization lists them. */
  @React
  onMemberAdded(event: MemberAdded): MemberRegistered | undefined {
    if (this.state.organization === undefined) {
      return undefined;
    }
    const { id: organization, person, role, addedBy } = event;
    this.update((draft) => {
      draft.person = person;
      draft.registeredBy = addedBy;
    });
    return create(MemberRegisteredSchema, {
      id: this.id,
      organization,
      person,
      role,
      registeredBy: addedBy,
    });
  }

  /**
   * Finishes registering the person, as the organization lists them already,
   * under another email address that names the same person.
   */
  @React
  onMemberAlreadyAdded(rejection: MemberAlreadyAdded): MemberRegistered {
    const { person } = rejection;
    if (person === undefined) {
      throw new Error("`MemberAlreadyAdded` names no person.");
    }
    const { organization, role } = this.state;
    const registeredBy = this.state.registeredBy ?? person;
    this.update((draft) => {
      draft.person = person;
      draft.registeredBy = registeredBy;
    });
    return create(MemberRegisteredSchema, {
      id: this.id,
      organization,
      person,
      role,
      registeredBy,
    });
  }
}
