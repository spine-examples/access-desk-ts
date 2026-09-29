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
import { AnyMessages } from "@spine-event-engine/core";
import type { Any } from "@bufbuild/protobuf/wkt";
import { BoundedContext, type Clock, EventRouting, SystemClock } from "@spine-event-engine/server";
import { ResourceAddedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { ResourceDeletedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import { ResourceAlreadyExistsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/rejections_pb.js";
import { OrganizationResourceNameAlreadyUsedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections_pb.js";
import {
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
  type AccessRequestApproved,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  AccessGrantIdSchema,
  GrantCoverageIdSchema,
  type AccessGrantId,
  type GrantCoverageId,
  type ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type { GrantedAccess } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { CommandScheduledSchema } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/events_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExpiredSchema,
  AccessGrantExpiredWithoutActivationSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import { type PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationAggregate } from "./organization/organization-aggregate.js";
import { OrganizationViewProjection } from "./organization/organization-view-projection.js";
import { ResourceAggregate } from "./resource/resource-aggregate.js";
import { ResourceCatalogProjection } from "./resource/resource-catalog-projection.js";
import { ResourceRegistrationProcessManager } from "./resource/resource-registration-process.js";
import { AccessRequestProcessManager } from "./access/request/access-request-process.js";
import { AccessRequestViewProjection } from "./access/request/access-request-view-projection.js";
import { AccessDecisionAssignmentProjection } from "./access/request/access-decision-assignment-projection.js";
import { AccessGrantAggregate } from "./access/grant/access-grant-aggregate.js";
import { GrantIssuanceProcessManager } from "./access/grant/grant-issuance-process.js";
import { GrantCoverageProjection } from "./access/grant/grant-coverage-projection.js";
import { AccessGrantViewProjection } from "./access/grant/access-grant-view-projection.js";
import { SchedulingProcessManager } from "./scheduling/scheduling-process.js";
import { ActivateAccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import { useClock } from "./time/clock.js";

/** How the Resources context is assembled. */
export interface ResourcesContextOptions {
  /**
   * Tells the domain what time it is; defaults to the system clock.
   *
   * Supply a controllable clock to make time-dependent behavior, such as
   * expiration, deterministic in tests and demonstrations.
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
    .route(AccessRequestDeniedSchema, (event) => event.manager)
    .route(AccessRequestCanceledSchema, (event) => event.manager)
    .route(AccessGrantExpiredSchema, (event) => event.manager)
    .route(AccessGrantRevokedSchema, (event) => event.manager);
  const issuanceRouting = EventRouting.create<AccessGrantId>()
    .route(AccessRequestApprovedSchema, (event) => grantIssuedBy(event))
    .route(CommandScheduledSchema, (event) => grantActivatedBy(event.command));
  const coverageRouting = EventRouting.create<GrantCoverageId>()
    .route(AccessGrantCreatedSchema, (event) => coverageOf(event.access))
    .route(AccessGrantExtendedSchema, (event) => coverageOf(event.access))
    .route(AccessGrantExpiredSchema, (event) => coverageOf(event.access))
    .route(AccessGrantRevokedSchema, (event) => coverageOf(event.access))
    .route(AccessGrantExpiredWithoutActivationSchema, (event) => coverageOf(event.access));
  const builder = BoundedContext.multitenant("Resources")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(OrganizationAggregate)
    .add(OrganizationViewProjection)
    .add(ResourceRegistrationProcessManager, { eventRouting: resourceRegistrationProcmanRouting })
    .add(ResourceAggregate)
    .add(ResourceCatalogProjection)
    .add(AccessRequestProcessManager)
    .add(AccessRequestViewProjection)
    .add(AccessDecisionAssignmentProjection, { eventRouting: decisionRouting })
    .add(AccessGrantAggregate)
    .add(GrantIssuanceProcessManager, { eventRouting: issuanceRouting })
    .add(GrantCoverageProjection, { eventRouting: coverageRouting })
    .add(AccessGrantViewProjection)
    .add(SchedulingProcessManager);
  return builder.buildAsync();
}

/**
 * The grant an approved request issues or extends.
 *
 * A grant shares its identifier with the first-time request that issued it;
 * an extension request applies to the grant it names.
 */
function grantIssuedBy(approval: AccessRequestApproved): AccessGrantId[] {
  const kind = approval.snapshot?.kind;
  if (kind?.case === "extension") {
    return kind.value.grant === undefined ? [] : [kind.value.grant];
  }
  return approval.id === undefined ? [] : [create(AccessGrantIdSchema, { uuid: approval.id.uuid })];
}

/** The grant whose access a planned command begins, when it begins access. */
function grantActivatedBy(command: Any | undefined): AccessGrantId[] {
  const grant =
    command === undefined ? undefined : AnyMessages.unpack(command, ActivateAccessGrantSchema)?.id;
  return grant === undefined ? [] : [grant];
}

/** The coverage of the person and resource a grant applies to. */
function coverageOf(access: GrantedAccess | undefined): GrantCoverageId[] {
  const { grantee, resource } = access ?? {};
  return grantee === undefined || resource === undefined
    ? []
    : [create(GrantCoverageIdSchema, { grantee, resource })];
}
