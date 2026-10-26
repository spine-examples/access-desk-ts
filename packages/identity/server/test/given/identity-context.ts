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
import { SignalMetadata } from "@spine-event-engine/server";
import { type ActorContext, UserIdSchema } from "@spine-event-engine/proto";
import { QueryIdSchema, QuerySchema, TargetSchema } from "@spine-event-engine/proto/client";
import { BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { TestStorages, type TestStorage } from "@access-desk/testing/storage";

import { typeRegistry } from "../../generated/model-registry.js";
import { eventRecording } from "./event-recording.js";

/** The gateway acting in the tests, once a provider has confirmed a person. */
export const actor = "gateway";

const signalMetadata = new SignalMetadata();

/** The actor context for reads and subscriptions. Signing in has no tenant. */
export function testActorContext(): ActorContext {
  return signalMetadata.actorContext({ actor: create(UserIdSchema, { value: actor }) });
}

/** Records events and rejections. */
export const { expectRejection, recordEvents } = eventRecording(testActorContext);

// Imported from compiled output: vitest cannot execute the handler classes'
// standard decorators from raw TypeScript source.
type IdentityModule = typeof import("../../dist/src/index.js");
let identity: IdentityModule | undefined;

/** Loads the compiled Identity context once, for a suite's `beforeAll`. */
export async function loadIdentityContext(): Promise<void> {
  identity = await import("../../dist/src/index.js");
}

/** The compiled Identity package. */
export function identityModule(): IdentityModule {
  if (identity === undefined) {
    throw new Error("Call loadIdentityContext() in beforeAll before opening a BlackBox.");
  }
  return identity;
}

/** A person the organizations were asked to add to their members. */
export interface AddedMember {
  readonly organization: string;
  readonly person: string;
  readonly email: string;
  readonly role: number;
  readonly addedBy: string;
}

/**
 * The organizations' members, standing in for the Resources context.
 *
 * It keeps who was added, and refuses to add anybody while asked.
 */
export const organizations = {
  /** Everybody the organizations were asked to add, in order. */
  added: [] as AddedMember[],
  /** Whether the organizations refuse to add anybody. */
  refusing: false,
  /** How many times the organizations refused to add somebody. */
  refused: 0,
};

const ownedBlackBoxes = new Set<BlackBox>();
const ownedStorages = new Set<TestStorage>();
const storages = new WeakMap<BlackBox, TestStorage>();

/**
 * Starts one Identity BlackBox.
 *
 * Every box is tracked so a suite's `afterEach` can close them with
 * {@link closeIdentityBlackBoxes}. So is the storage it keeps its data in.
 *
 * @param storage The storage of an earlier box to open again, as a restarted
 *   server would. New, empty storage when left out.
 */
export async function identityBlackBox(storage?: TestStorage): Promise<BlackBox> {
  const kept = storage ?? (await TestStorages.singleTenant(typeRegistry));
  ownedStorages.add(kept);
  const context = await identityModule().IdentityContext.create({
    storage: await kept.open(),
    members: {
      add: (member) => {
        if (organizations.refusing) {
          organizations.refused += 1;
          return Promise.reject(new Error("The organization did not add the person."));
        }
        organizations.added.push({
          organization: member.organization.uuid,
          person: member.person.uuid,
          email: member.email.value,
          role: member.role,
          addedBy: member.addedBy.uuid,
        });
        return Promise.resolve();
      },
    },
  });
  const box = await BlackBox.from(context, {
    timeoutMs: 20_000,
    intervalMs: 20,
  });
  ownedBlackBoxes.add(box);
  storages.set(box, kept);
  return box;
}

/**
 * The storage a BlackBox keeps its data in, for opening it again.
 *
 * @param box A BlackBox opened through {@link identityBlackBox}.
 */
export function storageOf(box: BlackBox): TestStorage {
  const storage = storages.get(box);
  if (storage === undefined) {
    throw new Error("Open the BlackBox through identityBlackBox() to reach its storage.");
  }
  return storage;
}

/**
 * Closes and forgets every BlackBox opened through {@link identityBlackBox},
 * and deletes the data they kept.
 */
export async function closeIdentityBlackBoxes(): Promise<void> {
  await Promise.all([...ownedBlackBoxes].map((box) => box.close()));
  ownedBlackBoxes.clear();
  await Promise.all([...ownedStorages].map((storage) => storage.drop()));
  ownedStorages.clear();
  organizations.added = [];
  organizations.refusing = false;
  organizations.refused = 0;
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
  const response = await scope.send(
    create(QuerySchema, {
      id: create(QueryIdSchema, { value: queryId }),
      target: create(TargetSchema, {
        type: TypeUrls.derive(schema),
        criterion: { case: "includeAll", value: true },
      }),
      context: testActorContext(),
    }),
  );
  return response.message.map(({ state }) => {
    const value = state === undefined ? undefined : AnyMessages.unpack(state, schema);
    if (value === undefined) {
      throw new Error(`Expected a ${schema.typeName} query state.`);
    }
    return value;
  });
}
