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
import {
  ResourceClosedForRequestsSchema,
  ResourceCreatedSchema,
  ResourceDeletedSchema,
  ResourceOpenedForRequestsSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import {
  OrganizationMemberActivatedSchema,
  OrganizationMemberAddedSchema,
  OrganizationMemberDeactivatedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { type PersonId } from "@access-desk/identity-model/generated/access_desk/identity/identifiers_pb.js";
import { AccessRequestAggregate } from "./access-request-aggregate.js";
import { AccessRequestSubmissionProcessManager } from "./access-request-submission-process.js";
import { ApprovalInboxProjection, MyAccessRequestProjection } from "./access-request-projections.js";
import { OrganizationMembershipProjection } from "./organization-membership-projection.js";
import { ResourceRequestPolicyProjection } from "./resource-request-policy-projection.js";

/**
 * Builds the multitenant Access bounded context.
 *
 * @returns The assembled Access bounded context.
 */
export async function createAccessContext(): Promise<BoundedContext> {
  const policyRouting = EventRouting.create<ResourceId>()
    .route(ResourceCreatedSchema, (event) => (event.id === undefined ? [] : [event.id]))
    .route(ResourceOpenedForRequestsSchema, (event) => (event.id === undefined ? [] : [event.id]))
    .route(ResourceClosedForRequestsSchema, (event) => (event.id === undefined ? [] : [event.id]))
    .route(ResourceDeletedSchema, (event) => (event.id === undefined ? [] : [event.id]));
  const membershipRouting = EventRouting.create<PersonId>()
    .route(OrganizationMemberAddedSchema, (event) => (event.person === undefined ? [] : [event.person]))
    .route(OrganizationMemberActivatedSchema, (event) => event.person === undefined ? [] : [event.person])
    .route(OrganizationMemberDeactivatedSchema, (event) => event.person === undefined ? [] : [event.person]);
  const builder = BoundedContext.multitenant("Access")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(ResourceRequestPolicyProjection, { eventRouting: policyRouting })
    .add(OrganizationMembershipProjection, { eventRouting: membershipRouting })
    .add(AccessRequestAggregate)
    .add(AccessRequestSubmissionProcessManager)
    .add(MyAccessRequestProjection)
    .add(ApprovalInboxProjection)
  return builder.buildAsync();
}
