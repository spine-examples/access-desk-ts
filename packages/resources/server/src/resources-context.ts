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
import { ResourceAddedSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { OrganizationAggregate } from "./organization-aggregate.js";
import { OrganizationViewProjection } from "./organization-view-projection.js";
import { ResourceAggregate } from "./resource-aggregate.js";
import { ResourceCatalogueProjection } from "./resource-view-projection.js";
import { ResourceCreationProcessManager } from "./resource-creation-process.js";

/**
 * Builds the multitenant Resources bounded context.
 *
 * The organization is the tenant: `CreateOrganization` is issued in the tenant
 * scope of the organization it creates (`OrganizationId = TenantId`).
 *
 * @returns The assembled Resources bounded context.
 */
export async function createResourcesContext(): Promise<BoundedContext> {
  const resourceCreationProcmanRouting = EventRouting.create<ResourceId>()
    .route(ResourceAddedSchema, (event) => {
      return event.resourceId === undefined ? [] : [event.resourceId]
    });
  const builder = BoundedContext.multitenant("Resources")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(OrganizationAggregate)
    .add(OrganizationViewProjection)
    .add(ResourceCreationProcessManager, { eventRouting: resourceCreationProcmanRouting })
    .add(ResourceAggregate)
    .add(ResourceCatalogueProjection);
  return builder.buildAsync();
}
