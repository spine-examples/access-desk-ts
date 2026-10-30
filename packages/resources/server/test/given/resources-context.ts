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

import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { Time, type TimeProvider } from "@spine-event-engine/core/time";
import { SignalMetadata, type BoundedContext } from "@spine-event-engine/server";
import { type ActorContext, TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import {
  CompositeFilter_CompositeOperator,
  Filter_Operator,
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  type Query,
  type Target,
} from "@spine-event-engine/proto/client";
import { BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { TestStorages, type TestStorage } from "@access-desk/testing/storage";

import { typeRegistry } from "../../generated/model-registry.js";

// The organization is its own tenant, so its id doubles as the tenant.
export const organizationId = "acme";
export const actor = "resources-user";

const signalMetadata = new SignalMetadata();

/** Builds the tenant the organization keeps its state in. */
function tenant() {
  return create(TenantIdSchema, { kind: { case: "value", value: organizationId } });
}

/** Builds the actor context for reads and subscriptions in the organization's tenant. */
export function testActorContext(): ActorContext {
  return signalMetadata.actorContext({
    actor: create(UserIdSchema, { value: actor }),
    tenantId: tenant(),
  });
}

// Imported from compiled output: vitest cannot execute the handler classes'
// standard decorators from raw TypeScript source.
type ResourcesModule = typeof import("../../dist/src/index.js");
let resources: ResourcesModule | undefined;

/**
 * Loads the compiled Resources context once, for a suite's `beforeAll`.
 */
export async function loadResourcesContext(): Promise<void> {
  resources = await import("../../dist/src/index.js");
}

function loaded(): ResourcesModule {
  if (resources === undefined) {
    throw new Error("Call loadResourcesContext() in beforeAll before opening a BlackBox.");
  }
  return resources;
}

const ownedBlackBoxes = new Set<BlackBox>();
const ownedStorages = new Set<TestStorage>();
const contexts = new WeakMap<BlackBox, BoundedContext>();
const storages = new WeakMap<BlackBox, TestStorage>();

/**
 * Starts one Resources BlackBox bound to the organization's tenant.
 *
 * Every box is tracked so a suite's `afterEach` can close them with
 * {@link closeResourcesBlackBoxes}. So is the storage it keeps its data in.
 *
 * @param clock Tells what time it is until the boxes are closed; the system
 *   clock by default.
 * @param storage The storage of an earlier box to open again, as a restarted
 *   server would. New, empty storage when left out.
 */
export async function resourcesBlackBox(
  clock?: TimeProvider,
  storage?: TestStorage,
): Promise<BlackBox> {
  if (clock !== undefined) {
    Time.setProvider(clock);
  }
  const kept = storage ?? (await TestStorages.multitenant(typeRegistry, [tenant()]));
  ownedStorages.add(kept);
  // Subscriptions belong to no organization, so they need storage of their own.
  const subscriptions = await TestStorages.singleTenant(typeRegistry);
  ownedStorages.add(subscriptions);
  // Grant flows cross several entities before a read model settles, so waits
  // get generous headroom; they still return as soon as the outcome is visible.
  const context = await loaded().ResourcesContext.create({
    storage: await kept.open(),
    subscriptions: await subscriptions.open(),
  });
  const box = await BlackBox.from(context, {
    tenant: organizationId,
    timeoutMs: 20_000,
    intervalMs: 20,
  });
  ownedBlackBoxes.add(box);
  contexts.set(box, context);
  storages.set(box, kept);
  return box;
}

/**
 * Finds the storage a BlackBox keeps its data in, for opening it again.
 *
 * @param box A BlackBox opened through {@link resourcesBlackBox}.
 */
export function storageOf(box: BlackBox): TestStorage {
  const storage = storages.get(box);
  if (storage === undefined) {
    throw new Error("Open the BlackBox through resourcesBlackBox() to reach its storage.");
  }
  return storage;
}

/**
 * Finds the Resources context behind a BlackBox, for tests that post events
 * directly.
 *
 * @param box A BlackBox opened through {@link resourcesBlackBox}.
 */
export function contextOf(box: BlackBox): BoundedContext {
  const context = contexts.get(box);
  if (context === undefined) {
    throw new Error("Open the BlackBox through resourcesBlackBox() to reach its context.");
  }
  return context;
}

/**
 * Closes and forgets every BlackBox opened through {@link resourcesBlackBox},
 * deletes the data they kept, and puts the system clock back.
 */
export async function closeResourcesBlackBoxes(): Promise<void> {
  await Promise.all([...ownedBlackBoxes].map((box) => box.close()));
  ownedBlackBoxes.clear();
  await Promise.all([...ownedStorages].map((storage) => storage.drop()));
  ownedStorages.clear();
  Time.resetProvider();
}

// Builds a query for one entity type in the organization's tenant.
function query(target: Target, queryId: string): Query {
  return create(QuerySchema, {
    id: create(QueryIdSchema, { value: queryId }),
    target,
    context: testActorContext(),
  });
}

// Builds an include-all query for one entity type in the organization's tenant.
function includeAll(schema: GenMessage<Message>, queryId: string): Query {
  return query(
    create(TargetSchema, {
      type: TypeUrls.derive(schema),
      criterion: { case: "includeAll", value: true },
    }),
    queryId,
  );
}

// Unpacks the entity states a query returned.
function statesOf<Schema extends GenMessage<Message>>(
  schema: Schema,
  states: readonly { state?: Parameters<typeof AnyMessages.unpack>[0] | undefined }[],
): MessageShape<Schema>[] {
  return states.map(({ state }) => {
    const value = state === undefined ? undefined : AnyMessages.unpack(state, schema);
    if (value === undefined) {
      throw new Error(`Expected a ${schema.typeName} query state.`);
    }
    return value;
  });
}

/**
 * Reads every current state of one projection type through the public client.
 *
 * @param scope The actor scope issuing the query.
 * @param schema The projection state schema to read.
 * @param queryId An identifier for the query.
 * @returns The unpacked projection states.
 */
export async function readAll<Schema extends GenMessage<Message>>(
  scope: BlackBoxScope,
  schema: Schema,
  queryId: string,
): Promise<MessageShape<Schema>[]> {
  const response = await scope.send(includeAll(schema, queryId));
  return statesOf(schema, response.message);
}

/**
 * Reads the projection states whose column equals a value, through the public client.
 *
 * @param scope The actor scope issuing the query.
 * @param schema The projection state schema to read.
 * @param queryId An identifier for the query.
 * @param column The name of the queried column.
 * @param valueSchema The schema of the column's value.
 * @param value The value the column must equal.
 * @returns The unpacked matching projection states.
 */
export async function readWhere<
  Schema extends GenMessage<Message>,
  ValueSchema extends GenMessage<Message>,
>(
  scope: BlackBoxScope,
  schema: Schema,
  queryId: string,
  column: string,
  valueSchema: ValueSchema,
  value: MessageShape<ValueSchema>,
): Promise<MessageShape<Schema>[]> {
  const target = create(TargetSchema, {
    type: TypeUrls.derive(schema),
    criterion: {
      case: "filters",
      value: {
        filter: [
          {
            operator: CompositeFilter_CompositeOperator.ALL,
            filter: [
              {
                fieldPath: { fieldName: [column] },
                value: AnyMessages.pack(valueSchema, value),
                operator: Filter_Operator.EQUAL,
              },
            ],
          },
        ],
      },
    },
  });
  const response = await scope.send(query(target, queryId));
  return statesOf(schema, response.message);
}
