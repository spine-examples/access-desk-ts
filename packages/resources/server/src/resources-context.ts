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

import { BoundedContext, EventRouting } from "@spine-event-engine/server";
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
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { type PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationAggregate } from "./organization/organization-aggregate.js";
import { OrganizationViewProjection } from "./organization/organization-view-projection.js";
import { ResourceAggregate } from "./resource/resource-aggregate.js";
import { ResourceCatalogProjection } from "./resource/resource-catalog-projection.js";
import { ResourceRegistrationProcessManager } from "./resource/resource-registration-process.js";
import { AccessRequestProcessManager } from "./access/request/access-request-process.js";
import { AccessRequestViewProjection } from "./access/request/access-request-view-projection.js";
import { AccessDecisionAssignmentProjection } from "./access/request/access-decision-assignment-projection.js";

/**
 * Builds the multitenant Resources bounded context.
 *
 * The organization is the tenant: `CreateOrganization` is issued in the tenant
 * scope of the organization it creates (`OrganizationId = TenantId`).
 *
 * @returns The assembled Resources bounded context.
 */
export async function createResourcesContext(): Promise<BoundedContext> {
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
    .route(AccessRequestCanceledSchema, (event) => event.manager);
  const builder = BoundedContext.multitenant("Resources")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(OrganizationAggregate)
    .add(OrganizationViewProjection)
    .add(ResourceRegistrationProcessManager, { eventRouting: resourceRegistrationProcmanRouting })
    .add(ResourceAggregate)
    .add(ResourceCatalogProjection)
    .add(AccessRequestProcessManager)
    .add(AccessRequestViewProjection)
    .add(AccessDecisionAssignmentProjection, { eventRouting: decisionRouting });
  return builder.buildAsync();
}
