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
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { SignalMetadata } from "@spine-event-engine/server";
import { type ActorContext, TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import {
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  type Query,
} from "@spine-event-engine/proto/client";
import { BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";

// The organization is its own tenant, so its id doubles as the tenant.
export const organizationId = "acme";
export const actor = "resources-user";

const signalMetadata = new SignalMetadata();

/** The actor context for reads and subscriptions in the organization's tenant. */
export function testActorContext(): ActorContext {
  return signalMetadata.actorContext({
    actor: create(UserIdSchema, { value: actor }),
    tenantId: create(TenantIdSchema, { kind: { case: "value", value: organizationId } }),
  });
}

// Imported from compiled output: vitest cannot execute the handler classes'
// standard decorators from raw TypeScript source.
type ResourcesModule = typeof import("../../dist/src/index.js");
let createResourcesContext: ResourcesModule["createResourcesContext"] | undefined;

/**
 * Loads the compiled Resources context factory once, for a suite's `beforeAll`.
 */
export async function loadResourcesContext(): Promise<void> {
  ({ createResourcesContext } = await import("../../dist/src/index.js"));
}

const ownedBlackBoxes = new Set<BlackBox>();

/**
 * Starts one Resources BlackBox bound to the organization's tenant.
 *
 * Every box is tracked so a suite's `afterEach` can close them with
 * {@link closeResourcesBlackBoxes}.
 */
export async function resourcesBlackBox(): Promise<BlackBox> {
  if (createResourcesContext === undefined) {
    throw new Error("Call loadResourcesContext() in beforeAll before opening a BlackBox.");
  }
  const box = await BlackBox.from(await createResourcesContext(), { tenant: organizationId });
  ownedBlackBoxes.add(box);
  return box;
}

/**
 * Closes and forgets every BlackBox opened through {@link resourcesBlackBox}.
 */
export async function closeResourcesBlackBoxes(): Promise<void> {
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
