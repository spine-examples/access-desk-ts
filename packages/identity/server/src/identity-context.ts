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
import type { ExternalIdentityId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { PersonEmailRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import { PersonEmailAlreadyRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections_pb.js";
import {
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import { ExternalIdentityProcessManager } from "./person/external-identity-process.js";
import { ExternalIdentityViewProjection } from "./person/external-identity-view-projection.js";
import { PersonAggregate } from "./person/person-aggregate.js";
import { PersonEmailAggregate } from "./person/person-email-aggregate.js";
import { PersonViewProjection } from "./person/person-view-projection.js";

/**
 * Builds the Identity bounded context, which says who a person is.
 *
 * @returns The assembled Identity bounded context.
 */
export async function createIdentityContext(): Promise<BoundedContext> {
  const accountRouting = EventRouting.create<ExternalIdentityId>()
    .route(PersonEmailRegisteredSchema, (event) => accountOf(event.invoker))
    .route(PersonEmailAlreadyRegisteredSchema, (rejection) => accountOf(rejection.invoker))
    .route(PersonRegisteredSchema, (event) => accountOf(event.account))
    .route(SignInAccountAddedSchema, (event) => accountOf(event.account));
  return BoundedContext.singleTenant("Identity")
    .withGeneratedRegistryRoot(new URL("..", import.meta.url))
    .add(ExternalIdentityProcessManager, { eventRouting: accountRouting })
    .add(ExternalIdentityViewProjection)
    .add(PersonEmailAggregate)
    .add(PersonAggregate)
    .add(PersonViewProjection)
    .buildAsync();
}

function accountOf(identity: ExternalIdentityId | undefined): ExternalIdentityId[] {
  return identity === undefined ? [] : [identity];
}
