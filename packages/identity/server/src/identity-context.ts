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

import "../generated/spine-bootstrap.js";
import { create } from "@bufbuild/protobuf";
import type { EmailAddress } from "@spine-event-engine/proto";
import {
  BoundedContext,
  CommandRouting,
  EventRouting,
  type BoundedContextBuilder,
  type StandSubscriptionRegistry,
} from "@spine-event-engine/server";
import {
  MembershipIdSchema,
  type ExternalIdentityId,
  type MembershipId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { ClaimMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
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
import { ExternalIdentityProcessManager } from "./person/external-identity-process.js";
import { ExternalIdentityViewProjection } from "./person/external-identity-view-projection.js";
import { PersonAggregate } from "./person/person-aggregate.js";
import { PersonEmailAggregate } from "./person/person-email-aggregate.js";
import { PersonViewProjection } from "./person/person-view-projection.js";

/** The settings the Identity context is assembled with. */
export interface IdentityContextOptions {
  /** The store of the subscriptions to the context. */
  readonly subscriptions?: StandSubscriptionRegistry;
}

/**
 * The Identity bounded context, which says who a person is and which
 * organization they belong to.
 */
export const IdentityContext = {
  /**
   * Declares the context, for an application to build.
   *
   * @param options The settings to assemble the context with.
   * @returns The declaration of the Identity bounded context.
   */
  create(options: IdentityContextOptions = {}): BoundedContextBuilder {
    /** Finds the account an event about signing in belongs to. */
    const accountOf = (identity: ExternalIdentityId | undefined): ExternalIdentityId[] =>
      identity === undefined ? [] : [identity];
    /** Finds the account that asked to register an email address, when an account did. */
    const askingAccount = (invoker: PersonEmailRegistered["invoker"]): ExternalIdentityId[] =>
      invoker.case === "account" ? [invoker.value] : [];
    /** Finds the membership that asked to register an email address, when one did. */
    const askingMembership = (invoker: PersonEmailRegistered["invoker"]): MembershipId[] =>
      invoker.case === "membership" ? [membershipOf(invoker.value.emailAddress)] : [];
    /**
     * Finds the membership of an email address.
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
      ClaimMemberSchema,
      (command) => membershipOf(command.id?.emailAddress),
    );
    const membershipEvents = EventRouting.create<MembershipId>()
      .route(PersonEmailRegisteredSchema, (event) => askingMembership(event.invoker))
      .route(PersonEmailAlreadyRegisteredSchema, (rejection) => askingMembership(rejection.invoker))
      .route(PersonRegisteredSchema, (event) => askingMembership(event.invoker))
      .route(OrganizationJoinedSchema, (event) =>
        event.membership === undefined ? [] : [event.membership],
      );
    const context = BoundedContext.singleTenant("Identity")
      .add(ExternalIdentityProcessManager, { eventRouting: accountRouting })
      .add(ExternalIdentityViewProjection)
      .add(PersonEmailAggregate)
      .add(PersonAggregate)
      .add(PersonViewProjection)
      .add(MembershipProcessManager, {
        commandRouting: membershipCommands,
        eventRouting: membershipEvents,
      })
      .add(MembershipViewProjection);
    if (options.subscriptions !== undefined) {
      context.withSubscriptionRegistry(options.subscriptions);
    }
    return context;
  },
};
