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
import { Assign, Command, ProcessManager, React, Throws } from "@spine-event-engine/server";
import type {
  MembershipId,
  PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { ClaimMember } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  MemberClaimedSchema,
  MemberClaimStartedSchema,
  type MemberClaimed,
  type MemberClaimStarted,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import { MembershipSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import {
  MemberAlreadyClaimed,
  MemberClaimedByOtherOrganization,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections.js";
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

/**
 * A person's membership in an organization, under their email address.
 *
 * 1. An organization claims the person under the email address as a member.
 *    An address belongs to one organization at most, and the first to claim
 *    the person under it keeps it.
 * 2. The email address is registered. When nobody has signed in under it yet,
 *    a new person is registered for it, without an account. Whoever signs in
 *    under that email address later is that person.
 * 3. The person joins the organization.
 */
export class MembershipProcessManager extends ProcessManager<
  MembershipId,
  typeof MembershipSchema
> {
  /**
   * Starts claiming the person as a member.
   *
   * Once an organization started claiming the person, its claim goes on to
   * its end, and every later claim is rejected. A later claim by the same
   * organization is rejected with `MemberAlreadyClaimed`, and a claim by any
   * other organization with `MemberClaimedByOtherOrganization`.
   */
  @Assign
  @Throws(MemberAlreadyClaimed, MemberClaimedByOtherOrganization)
  claimMember(command: ClaimMember): MemberClaimStarted {
    const { organization } = command;
    const current = this.state.organization;
    if (current !== undefined && current.value === organization?.value) {
      throw MemberAlreadyClaimed.create({ id: this.id, organization });
    }
    if (current !== undefined) {
      throw MemberClaimedByOtherOrganization.create({ id: this.id, organization });
    }
    this.update((draft) => {
      draft.organization = organization;
    });
    return create(MemberClaimStartedSchema, { id: this.id, organization });
  }

  /** Registers the email address. */
  @Command
  onMemberClaimStarted(_event: MemberClaimStarted): RegisterPersonEmail {
    return create(RegisterPersonEmailSchema, {
      emailAddress: this.id.emailAddress,
      invoker: { case: "membership", value: this.id },
    });
  }

  /** Registers a new person for an email address nobody has signed in under yet. */
  @Command
  onPersonEmailRegistered(event: PersonEmailRegistered): RegisterPerson {
    return create(RegisterPersonSchema, {
      id: event.person,
      emailAddress: this.id.emailAddress,
      invoker: { case: "membership", value: this.id },
    });
  }

  /** Joins the new person to the organization. */
  @Command
  onPersonRegistered(event: PersonRegistered): JoinOrganization {
    return this.#join(event.id);
  }

  /** Joins the person who already holds the email address to the organization. */
  @Command
  onPersonEmailAlreadyRegistered(rejection: PersonEmailAlreadyRegistered): JoinOrganization {
    return this.#join(rejection.person);
  }

  /** Finishes the claim, as the person has joined the organization. */
  @React
  onOrganizationJoined(event: OrganizationJoined): MemberClaimed {
    const { id: person, organization } = event;
    return create(MemberClaimedSchema, { id: this.id, person, organization });
  }

  /** Joins a person to the organization that claims them as a member. */
  #join(person: PersonId | undefined): JoinOrganization {
    const { organization } = this.state;
    if (person === undefined || organization === undefined) {
      throw new Error("The membership knows no person or no organization to join.");
    }
    return create(JoinOrganizationSchema, { id: person, membership: this.id, organization });
  }
}
