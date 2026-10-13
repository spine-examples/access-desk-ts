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
import type { OrganizationId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import {
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  TopicIdSchema,
  TopicSchema,
} from "@spine-event-engine/proto/client";

/** A client of the application server for one organization, or for what belongs to none. */
export type ServerClient = ReturnType<typeof Client.usingTransport>;

/**
 * The one connection a program keeps to the application server.
 *
 * Each organization has a client of its own, and all clients share this
 * connection.
 */
export class ServerConnection {
  /** Returns the address of the application server. */
  readonly #address: () => string;
  /** The connection, once the first client was made. */
  #open:
    | { sessions: Http2SessionManager; transport: ReturnType<typeof createGrpcTransport> }
    | undefined;
  /**
   * The client of each organization, by the organization's identifier.
   * The client for what belongs to no organization is kept under `undefined`.
   */
  readonly #clients = new Map<string | undefined, ServerClient>();

  /**
   * @param address Returns the address of the application server. It is called
   *   when the connection is first needed, so the server need not listen
   *   before then.
   */
  constructor(address: () => string) {
    this.#address = address;
  }

  /**
   * The client for one organization, or for what belongs to none.
   *
   * @param organization The organization, or nothing for what belongs to none.
   * @throws When an organization has an empty UUID, which cannot name a tenant.
   */
  in(organization?: OrganizationId): ServerClient {
    if (organization?.uuid === "") {
      throw new Error("OrganizationId UUID must not be empty.");
    }
    const key = organization?.uuid;
    let client = this.#clients.get(key);
    if (client === undefined) {
      client = Client.usingTransport(
        this.#transport(),
        organization === undefined ? {} : { tenant: organization.uuid },
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

/** A client that acts as one person or program. */
export type ServerRequest = ReturnType<ServerClient["onBehalfOf"]>;

/** How long to wait for the event by default. */
export const PATIENCE_MS = 10_000; // 10 seconds.

/** A command and the event it is expected to cause. */
export interface Awaited<Command extends GenMessage<Message>, Event extends GenMessage<Message>> {
  /** The type of the command. */
  readonly command: Command;
  /** The command to post. */
  readonly message: MessageShape<Command>;
  /** The type of the event to wait for. */
  readonly event: Event;
  /** Whether an event is the one this command caused. */
  readonly answers: (event: MessageShape<Event>) => boolean;
}

/**
 * Posts a command and waits for the event it causes.
 *
 * @param request The client that posts the command.
 * @param awaited The command and the event to wait for.
 * @param patienceMs How long to wait for the event. Ten seconds by default.
 * @returns The event, or `undefined` if the command was not accepted or the
 *   event did not come in time.
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
  answered.catch(() => undefined);
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
 * @param request The client that reads.
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
 * @param request The client that reads.
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
