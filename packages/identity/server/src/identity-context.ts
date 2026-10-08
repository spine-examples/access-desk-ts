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
import { BoundedContext, CommandRouting, EventRouting } from "@spine-event-engine/server";
import {
  InvitationIdSchema,
  type ExternalIdentityId,
  type InvitationId,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { PersonEmailRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import { PersonEmailAlreadyRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections_pb.js";
import {
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import {
  AcceptInvitationSchema,
  DeclineInvitationSchema,
  InviteMemberSchema,
  RevokeInvitationSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/commands_pb.js";
import { InvitationAcceptedSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/events_pb.js";
import { InvitationProcessManager } from "./invitation/invitation-process.js";
import { InvitationViewProjection } from "./invitation/invitation-view-projection.js";
import type { OrganizationMembers } from "./invitation/organization-members.js";
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
 * Builds the Identity bounded context, which says who a person is, which
 * organizations invited them, and which they are a member of.
 *
 * @param options How to assemble the context.
 * @returns The assembled Identity bounded context.
 */
export async function createIdentityContext(
  options: IdentityContextOptions,
): Promise<BoundedContext> {
  const accountRouting = EventRouting.create<ExternalIdentityId>()
    .route(PersonEmailRegisteredSchema, (event) => accountOf(event.invoker))
    .route(PersonEmailAlreadyRegisteredSchema, (rejection) => accountOf(rejection.invoker))
    .route(PersonRegisteredSchema, (event) => accountOf(event.account))
    .route(SignInAccountAddedSchema, (event) => accountOf(event.account));
  const invitationCommands = CommandRouting.create<InvitationId>()
    .route(InviteMemberSchema, (command) => invitationOf(command.id))
    .route(RevokeInvitationSchema, (command) => invitationOf(command.id))
    .route(AcceptInvitationSchema, (command) => invitationOf(command.id))
    .route(DeclineInvitationSchema, (command) => invitationOf(command.id));
  const personRouting = EventRouting.create<PersonId>()
    .route(InvitationAcceptedSchema, (event) => event.person === undefined ? [] : [event.person]);
  return BoundedContext.singleTenant("Identity")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(ExternalIdentityProcessManager, { eventRouting: accountRouting })
    .add(ExternalIdentityViewProjection)
    .add(PersonEmailAggregate)
    .add(PersonAggregate)
    .add(PersonViewProjection, { eventRouting: personRouting })
    .add(InvitationProcessManager, {
      commandRouting: invitationCommands,
      onCreate: (entity) => new InvitationProcessManager(entity, options.members),
    })
    .add(InvitationViewProjection)
    .buildAsync();
}

/**
 * The account a fact about signing in is for.
 */
function accountOf(identity: ExternalIdentityId | undefined): ExternalIdentityId[] {
  return identity === undefined ? [] : [identity];
}

/**
 * The invitation a command is about.
 *
 * A signed-in person's email address is kept in lower case. So an invitation
 * is found by the organization and the invited address in lower case, however
 * the address was written.
 */
function invitationOf(id: InvitationId | undefined): InvitationId {
  return create(InvitationIdSchema, {
    ...(id?.organization === undefined ? {} : { organization: id.organization }),
    invitee: { value: (id?.invitee?.value ?? "").trim().toLowerCase() },
  });
}
