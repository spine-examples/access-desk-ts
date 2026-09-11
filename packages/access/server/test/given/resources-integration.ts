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

import { create, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { SignalMetadata, ThirdPartyContext } from "@spine-event-engine/server";
import { type ActorContext, TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";

import { AccessLevel } from "@access-desk/resources-model/generated/access_desk/resources/access_level_pb.js";
import {
  ResourcePolicySchema,
  Sensitivity,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";

import { organizationId } from "./access-context.js";

const signalMetadata = new SignalMetadata();

/**
 * The identity under which Resources imports its facts into Access. It carries
 * the organization as its tenant, so each external event reaches the multitenant
 * Access context in-tenant.
 */
export function importingActor(): ActorContext {
  return signalMetadata.actorContext({
    actor: create(UserIdSchema, { value: "resources-system" }),
    tenantId: create(TenantIdSchema, { kind: { case: "value", value: organizationId } }),
  });
}

/** The complete access policy in force for a resource, restricted and read-only by default. */
export function resourcePolicy(
  overrides: Partial<Omit<ResourcePolicy, "$typeName" | "$unknown">> = {},
): ResourcePolicy {
  return create(ResourcePolicySchema, {
    openForRequests: false,
    sensitivity: Sensitivity.RESTRICTED,
    owner: { uuid: "owner" },
    accessLevel: [AccessLevel.READ],
    maximumDuration: { seconds: 3600n },
    primaryApprover: { uuid: "primary" },
    fallbackApprover: { uuid: "fallback" },
    policyVersion: 1n,
    ...overrides,
  });
}

const ownedSources = new Set<ThirdPartyContext>();

/** Opens a multitenant Resources source that publishes facts into Access. */
export async function openResourcesSource(): Promise<ThirdPartyContext> {
  const source = await ThirdPartyContext.multitenant("Resources");
  ownedSources.add(source);
  return source;
}

/** Closes and forgets every source opened through {@link openResourcesSource}. */
export async function closeResourcesSources(): Promise<void> {
  await Promise.all([...ownedSources].map((source) => source.close()));
  ownedSources.clear();
}

/** Publishes one Resources event into Access as an external fact. */
export function publishResourceFact<Schema extends GenMessage<Message>>(
  source: ThirdPartyContext,
  schema: Schema,
  fact: MessageInitShape<Schema>,
): Promise<void> {
  return source.emittedEvent(create(schema, fact), importingActor());
}
