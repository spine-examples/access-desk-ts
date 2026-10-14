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
import type { EmailAddress } from "@spine-event-engine/proto";
import { BoundedContext, CommandRouting, EventRouting } from "@spine-event-engine/server";
import {
  MembershipIdSchema,
  type ExternalIdentityId,
  type MembershipId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  PersonEmailRegisteredSchema,
  type PersonEmailRegistered,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import { PersonEmailAlreadyRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections_pb.js";
import {
  OrganizationJoinedSchema,
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import { MembershipProcessManager } from "./membership/membership-process.js";
import { MembershipViewProjection } from "./membership/membership-view-projection.js";
import type { OrganizationMembers } from "./membership/organization-members.js";
import { ExternalIdentityProcessManager } from "./person/external-identity-process.js";
import { ExternalIdentityViewProjection } from "./person/external-identity-view-projection.js";
import { PersonAggregate } from "./person/person-aggregate.js";
import { PersonEmailAggregate } from "./person/person-email-aggregate.js";
import { PersonViewProjection } from "./person/person-view-projection.js";

/** How the Identity context is assembled. */
export interface IdentityContextOptions {
  /** The service that adds a person to the members of an organization. */
  readonly members: OrganizationMembers;
}

/**
 * The Identity bounded context, which says who a person is and which
 * organization they belong to.
 */
export const IdentityContext = {
  /**
   * Builds the context.
   *
   * @param options How to assemble the context.
   * @returns The assembled Identity bounded context.
   */
  async create(options: IdentityContextOptions): Promise<BoundedContext> {
    /** The account an event about signing in belongs to. */
    const accountOf = (identity: ExternalIdentityId | undefined): ExternalIdentityId[] =>
      identity === undefined ? [] : [identity];
    /** The account that asked for an email address to be registered, when an account did. */
    const askingAccount = (invoker: PersonEmailRegistered["invoker"]): ExternalIdentityId[] =>
      invoker.case === "account" ? [invoker.value] : [];
    /** The membership that asked for an email address to be registered, when one did. */
    const askingMembership = (invoker: PersonEmailRegistered["invoker"]): MembershipId[] =>
      invoker.case === "membership" ? [membershipOf(invoker.value.emailAddress)] : [];
    /**
     * The membership of an email address.
     *
     * Email addresses are kept in lower case. So the address is put in lower
     * case before its membership is looked up, however it was written.
     */
    const membershipOf = (address: EmailAddress | undefined): MembershipId =>
      create(MembershipIdSchema, {
        emailAddress: { value: (address?.value ?? "").trim().toLowerCase() },
      });

    const accountRouting = EventRouting.create<ExternalIdentityId>()
      .route(PersonEmailRegisteredSchema, (event) => askingAccount(event.invoker))
      .route(PersonEmailAlreadyRegisteredSchema, (rejection) => askingAccount(rejection.invoker))
      .route(PersonRegisteredSchema, (event) => askingAccount(event.invoker))
      .route(SignInAccountAddedSchema, (event) => accountOf(event.account));
    const membershipCommands = CommandRouting.create<MembershipId>().route(
      AddMemberSchema,
      (command) => membershipOf(command.id?.emailAddress),
    );
    const membershipEvents = EventRouting.create<MembershipId>()
      .route(PersonEmailRegisteredSchema, (event) => askingMembership(event.invoker))
      .route(PersonEmailAlreadyRegisteredSchema, (rejection) => askingMembership(rejection.invoker))
      .route(PersonRegisteredSchema, (event) => askingMembership(event.invoker))
      .route(OrganizationJoinedSchema, (event) =>
        event.membership === undefined ? [] : [event.membership],
      );
    return BoundedContext.singleTenant("Identity")
      .withGeneratedRegistryRoot(new URL("..", import.meta.url))
      .add(ExternalIdentityProcessManager, { eventRouting: accountRouting })
      .add(ExternalIdentityViewProjection)
      .add(PersonEmailAggregate)
      .add(PersonAggregate)
      .add(PersonViewProjection)
      .add(MembershipProcessManager, {
        commandRouting: membershipCommands,
        eventRouting: membershipEvents,
        onCreate: (entity) => new MembershipProcessManager(entity, options.members),
      })
      .add(MembershipViewProjection)
      .buildAsync();
  },
};
