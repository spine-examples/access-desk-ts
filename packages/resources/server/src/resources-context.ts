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
import { anyIs, anyUnpack } from "@bufbuild/protobuf/wkt";
import type { EventContext } from "@spine-event-engine/proto";
import {
  BoundedContext,
  type Clock,
  CommandRouting,
  EventRouting,
  SystemClock,
} from "@spine-event-engine/server";
import { ResourceAddedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import {
  AcceptInvitationSchema,
  DeclineInvitationSchema,
  InviteMemberSchema,
  RevokeInvitationSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/commands_pb.js";
import { ResourceDeletedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import { ResourceAlreadyExistsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/rejections_pb.js";
import { OrganizationResourceNameAlreadyUsedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections_pb.js";
import {
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovalFailedSchema,
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  InvitationIdSchema,
  type AccessGrantId,
  type AccessRequestId,
  type InvitationId,
  type ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
  RequestedAccessCheckedSchema,
  RequestedExtensionCheckedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  CheckRequestedAccessSchema,
  CheckRequestedExtensionSchema,
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import { AccessGrantNotActiveSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import {
  AccessAlreadyHeldSchema,
  RequestedDurationTooLongSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections_pb.js";
import { type PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationAggregate } from "./organization/organization-aggregate.js";
import { OrganizationViewProjection } from "./organization/organization-view-projection.js";
import { InvitationProcessManager } from "./organization/invitation/invitation-process.js";
import { InvitationViewProjection } from "./organization/invitation/invitation-view-projection.js";
import { ResourceAggregate } from "./resource/resource-aggregate.js";
import { ResourceCatalogProjection } from "./resource/resource-catalog-projection.js";
import { ResourceRegistrationProcessManager } from "./resource/resource-registration-process.js";
import { AccessRequestProcessManager } from "./access/request/access-request-process.js";
import { AccessRequestViewProjection } from "./access/request/access-request-view-projection.js";
import { AccessDecisionAssignmentProjection } from "./access/request/access-decision-assignment-projection.js";
import { ResourceAccessAggregate } from "./access/grant/resource-access-aggregate.js";
import { AccessGrantViewProjection } from "./access/grant/access-grant-view-projection.js";
import { useClock } from "./time/clock.js";

/** How the Resources context is assembled. */
export interface ResourcesContextOptions {
  /**
   * Tells the domain what time it is; defaults to the system clock.
   *
   * Supply a controllable clock to make time-dependent behavior, such as
   * whether a grant gives access now.
   */
  readonly clock?: Clock;
}

/**
 * Builds the multitenant Resources bounded context.
 *
 * The organization is the tenant: `CreateOrganization` is issued in the tenant
 * scope of the organization it creates (`OrganizationId = TenantId`).
 *
 * @param options How to assemble the context.
 * @returns The assembled Resources bounded context.
 */
export async function createResourcesContext(
  options: ResourcesContextOptions = {},
): Promise<BoundedContext> {
  useClock(options.clock ?? new SystemClock());
  const resourceRegistrationProcmanRouting = EventRouting.create<ResourceId>()
    .route(ResourceAddedSchema, (event) =>
      event.resourceId === undefined ? [] : [event.resourceId],
    )
    .route(ResourceAlreadyExistsSchema, (rejection) =>
      rejection.id === undefined ? [] : [rejection.id],
    )
    .route(OrganizationResourceNameAlreadyUsedSchema, (rejection) =>
      rejection.resourceId === undefined ? [] : [rejection.resourceId],
    )
    .route(ResourceDeletedSchema, (event) => (event.id === undefined ? [] : [event.id]));
  const decisionRouting = EventRouting.create<PersonId>()
    .route(AccessRequestSubmittedSchema, (event) => event.manager)
    .route(AccessExtensionRequestSubmittedSchema, (event) => event.manager)
    .route(AccessRequestApprovedSchema, (event) => event.manager)
    .route(AccessRequestApprovalFailedSchema, (event) => event.manager)
    .route(AccessRequestDeniedSchema, (event) => event.manager)
    .route(AccessRequestCanceledSchema, (event) => event.manager)
    .route(AccessGrantRevokedSchema, (event) => event.manager);
  const requestRouting = EventRouting.create<AccessRequestId>()
    .route(RequestedAccessCheckedSchema, (event) => requestOf(event))
    .route(RequestedExtensionCheckedSchema, (event) => requestOf(event))
    .route(AccessGrantCreatedSchema, (event) => requestOf(event))
    .route(AccessGrantExtendedSchema, (event) => requestOf(event))
    .route(AccessAlreadyHeldSchema, (_rejection, context) => requestRejected(context))
    .route(AccessGrantNotActiveSchema, (_rejection, context) => requestRejected(context))
    .route(RequestedDurationTooLongSchema, (_rejection, context) => requestRejected(context));
  const grantViewRouting = EventRouting.create<AccessGrantId>()
    .route(AccessGrantCreatedSchema, (event) => grantOf(event))
    .route(AccessGrantExtendedSchema, (event) => grantOf(event))
    .route(AccessGrantRevokedSchema, (event) => grantOf(event));
  const invitationCommands = CommandRouting.create<InvitationId>()
    .route(InviteMemberSchema, (command) => invitationOf(command.id?.invitee?.value))
    .route(RevokeInvitationSchema, (command) => invitationOf(command.id?.invitee?.value))
    .route(AcceptInvitationSchema, (command) => invitationOf(command.id?.invitee?.value))
    .route(DeclineInvitationSchema, (command) => invitationOf(command.id?.invitee?.value));
  const builder = BoundedContext.multitenant("Resources")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(OrganizationAggregate)
    .add(OrganizationViewProjection)
    .add(InvitationProcessManager, { commandRouting: invitationCommands })
    .add(InvitationViewProjection)
    .add(ResourceRegistrationProcessManager, { eventRouting: resourceRegistrationProcmanRouting })
    .add(ResourceAggregate)
    .add(ResourceCatalogProjection)
    .add(AccessRequestProcessManager, { eventRouting: requestRouting })
    .add(AccessRequestViewProjection)
    .add(AccessDecisionAssignmentProjection, { eventRouting: decisionRouting })
    .add(ResourceAccessAggregate)
    .add(AccessGrantViewProjection, { eventRouting: grantViewRouting });
  return builder.buildAsync();
}

/**
 * The request a person's access to a resource answers.
 *
 * The access answers the request that asked for a check when it was submitted,
 * or for a grant to be created or extended when it was approved.
 */
function requestOf(answer: { readonly request?: AccessRequestId | undefined }): AccessRequestId[] {
  return answer.request === undefined ? [] : [answer.request];
}

/** The commands through which a request asks something of a person's access to a resource. */
const askedByRequest = [
  CheckRequestedAccessSchema,
  CheckRequestedExtensionSchema,
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
] as const;

/**
 * The request whose command a person's access to a resource rejected.
 *
 * A rejection of anything a request did not ask for, such as a revocation or a
 * submission the request itself rejected, answers no request.
 */
function requestRejected(context: EventContext): AccessRequestId[] {
  const rejected = context.rejection?.command?.message;
  const asked =
    rejected === undefined ? undefined : askedByRequest.find((schema) => anyIs(rejected, schema));
  return rejected === undefined || asked === undefined
    ? []
    : requestOf(anyUnpack(rejected, asked) ?? {});
}

/**
 * The invitation of a person, by their email address.
 *
 * A signed-in person's address is kept in lower case, so an invitation is
 * found by the address in lower case, however it was written.
 */
function invitationOf(address: string | undefined): InvitationId {
  return create(InvitationIdSchema, {
    invitee: { value: (address ?? "").trim().toLowerCase() },
  });
}

/** The grant an event tells about. */
function grantOf(event: { readonly id?: AccessGrantId | undefined }): AccessGrantId[] {
  return event.id === undefined ? [] : [event.id];
}
