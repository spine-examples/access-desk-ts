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

import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { AnyMessages, TypeRegistry, TypeUrls } from "@spine-event-engine/core";
import { EnvironmentType, ServerEnvironment, SignalMetadata } from "@spine-event-engine/server";
import { resetServerEnvironmentForTest } from "@spine-event-engine/server/testing";
import { type ActorContext, TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import {
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  type Query,
} from "@spine-event-engine/proto/client";
import { BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";

import { resourcesProtoModule } from "@access-desk/resources-model";
import { accessProtoModule } from "@access-desk/access-model";

// The organization is its own tenant, so its id doubles as the tenant.
export const organizationId = "acme";
export const actor = "access-user";

const signalMetadata = new SignalMetadata();

/** The actor context for reads in the organization's tenant. */
export function testActorContext(): ActorContext {
  return signalMetadata.actorContext({
    actor: create(UserIdSchema, { value: actor }),
    tenantId: create(TenantIdSchema, { kind: { case: "value", value: organizationId } }),
  });
}

// Imported from compiled output: vitest cannot execute the handler classes'
// standard decorators from raw TypeScript source.
type AccessModule = typeof import("../../dist/src/index.js");
let createAccessContext: AccessModule["createAccessContext"] | undefined;

/** Loads the compiled Access context factory once, for a suite's `beforeAll`. */
export async function loadAccessContext(): Promise<void> {
  ({ createAccessContext } = await import("../../dist/src/index.js"));
}

/**
 * Registers the Resources and Access contracts in the local environment so a
 * `ThirdPartyContext` can resolve the external event schemas it emits.
 */
export async function configureAccessEnvironment(): Promise<void> {
  await resetServerEnvironmentForTest();
  ServerEnvironment.when(EnvironmentType.Local).use({
    typeRegistry: TypeRegistry.from(resourcesProtoModule, accessProtoModule),
  });
}

/** Clears the environment registered by {@link configureAccessEnvironment}. */
export function resetAccessEnvironment(): Promise<void> {
  return resetServerEnvironmentForTest();
}

const ownedBlackBoxes = new Set<BlackBox>();

/** Starts one Access BlackBox bound to the organization's tenant. */
export async function accessBlackBox(): Promise<BlackBox> {
  if (createAccessContext === undefined) {
    throw new Error("Call loadAccessContext() in beforeAll before opening a BlackBox.");
  }
  const box = await BlackBox.from(await createAccessContext(), { tenant: organizationId });
  ownedBlackBoxes.add(box);
  return box;
}

/** Closes and forgets every BlackBox opened through {@link accessBlackBox}. */
export async function closeAccessBlackBoxes(): Promise<void> {
  await Promise.all([...ownedBlackBoxes].map((box) => box.close()));
  ownedBlackBoxes.clear();
}

// Builds an include-all query for one entity type in the organization's tenant.
function includeAll(schema: GenMessage<Message>, queryId: string): Query {
  return create(QuerySchema, {
    id: create(QueryIdSchema, { value: queryId }),
    target: create(TargetSchema, {
      type: TypeUrls.derive(schema),
      criterion: { case: "includeAll", value: true },
    }),
    context: testActorContext(),
  });
}

/**
 * Reads every current state of one projection type through the public client.
 *
 * @param scope The actor scope issuing the query.
 * @param schema The projection state schema to read.
 * @param queryId A stable identifier for the query.
 * @returns The unpacked projection states.
 */
export async function readAll<Schema extends GenMessage<Message>>(
  scope: BlackBoxScope,
  schema: Schema,
  queryId: string,
): Promise<MessageShape<Schema>[]> {
  const response = await scope.send(includeAll(schema, queryId));
  return response.message.map(({ state }) => {
    const value = state === undefined ? undefined : AnyMessages.unpack(state, schema);
    if (value === undefined) {
      throw new Error(`Expected a ${schema.typeName} query state.`);
    }
    return value;
  });
}
