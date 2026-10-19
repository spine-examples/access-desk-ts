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
import { AnyMessages, SignalEnvelopes, TypeUrls } from "@spine-event-engine/core";
import { Time } from "@spine-event-engine/core/time";
import {
  CommandIdSchema,
  EventContextSchema,
  MessageIdSchema,
  type MessageId,
} from "@spine-event-engine/proto";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import {
  AuditEntrySchema,
  type AuditEntry,
} from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
import { ResourceIdSchema } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import { ResourceRegisteredSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";
import { contextOf, readAll, readWhere, testActorContext } from "../../given/resources-context.js";

/**
 * Reads the whole history of the organization.
 *
 * @param reader The actor scope that reads.
 * @returns Every entry of the history.
 */
export function readHistory(reader: BlackBoxScope): Promise<AuditEntry[]> {
  return readAll(reader, AuditEntrySchema, "history");
}

/**
 * Reads the history of one resource.
 *
 * @param reader The actor scope that reads.
 * @param resource The identifier of the resource.
 * @returns The entries about what happened to the resource.
 */
export function readHistoryOf(reader: BlackBoxScope, resource: string): Promise<AuditEntry[]> {
  return readWhere(
    reader,
    AuditEntrySchema,
    "history-of-resource",
    "resource",
    ResourceIdSchema,
    create(ResourceIdSchema, { uuid: resource }),
  );
}

/** An entry of the history, with the fact it keeps. */
export interface Recorded<Schema extends GenMessage<Message>> {
  /** The entry. */
  readonly entry: AuditEntry;
  /** The fact the entry keeps. */
  readonly fact: MessageShape<Schema>;
}

/**
 * The names of the facts some entries keep, such as `AccessGrantRevoked`.
 *
 * @param entries The entries.
 * @returns The name of each entry's fact, in the order of the entries.
 */
export function factsOf(entries: readonly AuditEntry[]): string[] {
  return entries.map((entry) => {
    const url = entry.event?.typeUrl ?? "";
    return url.slice(url.lastIndexOf(".") + 1);
  });
}

function recordedOf<Schema extends GenMessage<Message>>(
  rows: readonly AuditEntry[],
  schema: Schema,
): Recorded<Schema>[] {
  return rows.flatMap((entry) => {
    const fact = entry.event === undefined ? undefined : AnyMessages.unpack(entry.event, schema);
    return fact === undefined ? [] : [{ entry, fact }];
  });
}

/**
 * Waits until the history holds an entry of an event.
 *
 * @param box The BlackBox whose bounded waiting backs the read.
 * @param reader The actor scope that reads.
 * @param schema The kind of the fact.
 * @param accept Whether an entry of that kind is the awaited one. Any, when left out.
 * @returns The entry, and the fact it keeps.
 */
export async function awaitEntry<Schema extends GenMessage<Message>>(
  box: BlackBox,
  reader: BlackBoxScope,
  schema: Schema,
  accept: (fact: MessageShape<Schema>) => boolean = () => true,
): Promise<Recorded<Schema>> {
  const matching = (rows: AuditEntry[]): Recorded<Schema>[] =>
    recordedOf(rows, schema).filter(({ fact }) => accept(fact));
  const [found] = matching(
    await box.eventually(
      () => readHistory(reader),
      (rows) => matching(rows).length > 0,
    ),
  );
  if (found === undefined) {
    throw new Error(`The history holds no entry of ${schema.typeName}.`);
  }
  return found;
}

/**
 * Waits until the history holds a number of entries of one kind of event.
 *
 * @param box The BlackBox whose bounded waiting backs the read.
 * @param reader The actor scope that reads.
 * @param schema The kind of the facts.
 * @param times How many entries of that kind to wait for.
 * @returns The entries of that kind.
 */
export async function awaitEntries(
  box: BlackBox,
  reader: BlackBoxScope,
  schema: GenMessage<Message>,
  times: number,
): Promise<AuditEntry[]> {
  const of = (rows: AuditEntry[]): AuditEntry[] =>
    recordedOf(rows, schema).map(({ entry }) => entry);
  return of(
    await box.eventually(
      () => readHistory(reader),
      (rows) => of(rows).length >= times,
    ),
  );
}

/**
 * A command to register a resource, to use as what led to an action.
 *
 * @param uuid The identifier of the command.
 */
export function registrationCommand(uuid: string): MessageId {
  return create(MessageIdSchema, {
    id: AnyMessages.pack(CommandIdSchema, create(CommandIdSchema, { uuid })),
    typeUrl: TypeUrls.derive(RegisterResourceSchema),
  });
}

/** Which change of which resource an action records. */
export interface Recording {
  /** The identifier of the resource that changed. */
  readonly by: string;
  /** How many times the resource had changed before. */
  readonly version: number;
  /** What led to the change. */
  readonly cause: MessageId;
}

/**
 * Records that a resource was registered, as its registration would.
 *
 * The test picks the change and its cause, to set up cases the real flow
 * never produces.
 *
 * @param box The BlackBox whose context records the fact.
 * @param resource The identifier of the registered resource.
 * @param recording Which change records the fact.
 */
export async function recordRegistered(
  box: BlackBox,
  resource: string,
  recording: Recording,
): Promise<void> {
  const producer = create(ResourceIdSchema, { uuid: recording.by });
  await contextOf(box)
    .eventBus()
    .post(
      SignalEnvelopes.event({
        context: create(EventContextSchema, {
          timestamp: Time.currentTime(),
          producerId: AnyMessages.pack(ResourceIdSchema, producer),
          version: { number: recording.version },
          origin: {
            case: "pastMessage",
            value: { message: recording.cause, actorContext: testActorContext() },
          },
        }),
        schema: ResourceRegisteredSchema,
        message: create(ResourceRegisteredSchema, { id: { uuid: resource } }),
      }),
    );
}
