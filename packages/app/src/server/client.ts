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
import { Http2SessionManager, createGrpcTransport } from "@connectrpc/connect-node";
import { Client } from "@spine-event-engine/client-node";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import {
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  TopicIdSchema,
  TopicSchema,
} from "@spine-event-engine/proto/client";

/**
 * A client of the application server that sends commands, queries, and
 * subscriptions to one organization, or to what belongs to no organization.
 */
export type ServerClient = ReturnType<typeof Client.usingTransport>;

/**
 * The one connection a program keeps to the application server.
 *
 * Every command, query, and subscription names the organization it concerns, or
 * none. All of them share this one connection, however many organizations there are.
 */
export class ServerConnection {
  /** Tells the address of the application server, such as `http://127.0.0.1:8090`. */
  readonly #address: () => string;
  /** The connection, once the first client was made. */
  #open:
    | { sessions: Http2SessionManager; transport: ReturnType<typeof createGrpcTransport> }
    | undefined;
  /** The client for what belongs to no organization, and the client of each organization. */
  readonly #clients = new Map<string, ServerClient>();

  /**
   * @param address Tells the address of the application server.
   *   It is read when the connection is first
   *   needed, so the server need not listen before then.
   */
  constructor(address: () => string) {
    this.#address = address;
  }

  /**
   * The client for one organization, or for what belongs to none.
   *
   * @param organization The organization, or nothing for what belongs to none.
   */
  in(organization?: string): ServerClient {
    const key = organization ?? "";
    let client = this.#clients.get(key);
    if (client === undefined) {
      client = Client.usingTransport(
        this.#transport(),
        organization === undefined ? {} : { tenant: organization },
      );
      this.#clients.set(key, client);
    }
    return client;
  }

  /** Closes the connection, with everything that was open on it. */
  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((client) => client.close()));
    this.#open?.sessions.abort();
    this.#open = undefined;
  }

  #transport() {
    if (this.#open === undefined) {
      const baseUrl = this.#address();
      const sessions = new Http2SessionManager(baseUrl);
      this.#open = {
        sessions,
        transport: createGrpcTransport({ baseUrl, sessionManager: sessions }),
      };
    }
    return this.#open.transport;
  }
}

/**
 * A client of the application server acting as one person or program, which
 * sends their commands, queries, and subscriptions.
 */
export type ServerRequest = ReturnType<ServerClient["onBehalfOf"]>;

/** How long the application server has to say that a command took effect, unless told otherwise. */
export const PATIENCE_MS = 10_000; // 10 seconds.

/** A command and the event that tells it took effect. */
export interface Awaited<Command extends GenMessage<Message>, Event extends GenMessage<Message>> {
  /** The kind of command to give. */
  readonly command: Command;
  /** The command. */
  readonly message: MessageShape<Command>;
  /** The kind of event that tells the command took effect. */
  readonly event: Event;
  /** Whether an event of that kind is the one this command caused. */
  readonly answers: (event: MessageShape<Event>) => boolean;
}

/**
 * Gives a command and waits for the event that tells it took effect.
 *
 * A command is only accepted when it is given. What it led to shows in an
 * event a moment later.
 *
 * 1. It starts watching for the event.
 * 2. It gives the command.
 * 3. It waits for an event that answers the command.
 *
 * @param request The client that gives the command, as one actor in one
 *   organization.
 * @param awaited The command, and the event that tells it took effect.
 * @param patienceMs How long to wait for the event. Ten seconds when left out.
 * @returns The event, or `undefined` when the command was not accepted or no
 *   such event came in time.
 */
export async function postAndAwait<
  Command extends GenMessage<Message>,
  Event extends GenMessage<Message>,
>(
  request: ServerRequest,
  awaited: Awaited<Command, Event>,
  patienceMs: number = PATIENCE_MS,
): Promise<MessageShape<Event> | undefined> {
  const watching = await request.createSubscription(
    create(TopicSchema, {
      id: create(TopicIdSchema, { value: `awaited-${crypto.randomUUID()}` }),
      target: create(TargetSchema, {
        type: TypeUrls.derive(awaited.event),
        criterion: { case: "includeAll", value: true },
      }),
    }),
    { kind: "event" },
  );
  const answered = (async (): Promise<MessageShape<Event> | undefined> => {
    for await (const delivery of watching.updates) {
      if (delivery.kind !== "update" || delivery.update.update.case !== "eventUpdates") {
        continue;
      }
      for (const event of delivery.update.update.value.event) {
        const fact =
          event.message === undefined
            ? undefined
            : AnyMessages.unpack(event.message, awaited.event);
        if (fact !== undefined && awaited.answers(fact)) {
          return fact;
        }
      }
    }
    return undefined;
  })();
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const tooLate = new Promise<undefined>((resolve) => {
    giveUp = setTimeout(() => {
      resolve(undefined);
    }, patienceMs);
  });
  try {
    await watching.activate();
    const given = await request.post(awaited.command, awaited.message);
    return given.kind === "ok" ? await Promise.race([answered, tooLate]) : undefined;
  } finally {
    clearTimeout(giveUp);
    await watching.cancel();
  }
}

/**
 * Reads one read model by its identifier.
 *
 * @param request The client that reads, as one actor in one organization.
 * @param schema The kind of read model.
 * @param idSchema The kind of its identifier.
 * @param id The identifier.
 * @returns The read model, or `undefined` when there is none under that identifier.
 */
export async function readById<
  Schema extends GenMessage<Message>,
  IdSchema extends GenMessage<Message>,
>(
  request: ServerRequest,
  schema: Schema,
  idSchema: IdSchema,
  id: MessageShape<IdSchema>,
): Promise<MessageShape<Schema> | undefined> {
  const type = TypeUrls.derive(schema);
  const response = await request.send(
    create(QuerySchema, {
      id: create(QueryIdSchema, { value: `read-${type}-${crypto.randomUUID()}` }),
      target: create(TargetSchema, {
        type,
        criterion: {
          case: "filters",
          value: { idFilter: { id: [AnyMessages.pack(idSchema, id)] } },
        },
      }),
    }),
  );
  const state = response.message[0]?.state;
  return state === undefined ? undefined : AnyMessages.unpack(state, schema);
}

/**
 * Finds the read models of one kind that a query describes.
 *
 * @param request The client that reads, as one actor in one organization.
 * @param schema The kind of read model.
 * @param query What to look for, built from the read model's generated query.
 * @returns Those that match.
 */
export async function find<Schema extends GenMessage<Message>>(
  request: ServerRequest,
  schema: Schema,
  query: Parameters<ServerRequest["send"]>[0],
): Promise<MessageShape<Schema>[]> {
  const response = await request.send(query);
  return response.message.flatMap(({ state }) => {
    const item = state === undefined ? undefined : AnyMessages.unpack(state, schema);
    return item === undefined ? [] : [item];
  });
}
