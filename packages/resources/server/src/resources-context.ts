/*
 * Copyright 2026, TeamDev. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Redistribution and use in source and/or binary forms, with or without
 * modification, must retain the above copyright notice and the following
 * disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { BoundedContext, EventRouting } from "@spine-event-engine/server";
import { ResourceAddedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_events_pb.js";
import { ResourceDeletedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_events_pb.js";
import { ResourceAlreadyExistsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_rejections_pb.js";
import { OrganizationResourceNameAlreadyUsedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_rejections_pb.js";
import {
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_events_pb.js";
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
