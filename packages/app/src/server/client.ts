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

/** How long to wait for a command's effect by default. */
export const PATIENCE_MS = 10_000; // 10 seconds.

/** A command, and the read model that shows what it changed. */
export interface AwaitedView<
  Command extends GenMessage<Message>,
  View extends GenMessage<Message>,
  IdSchema extends GenMessage<Message>,
  Shown,
> {
  /** The type of the command. */
  readonly command: Command;
  /** The command to post. */
  readonly message: MessageShape<Command>;
  /** The kind of read model that shows what the command changed. */
  readonly view: View;
  /** The kind of the read model's identifier. */
  readonly idSchema: IdSchema;
  /** The identifier of the read model. */
  readonly id: MessageShape<IdSchema>;
  /**
   * What the read model shows once the command has had its effect.
   *
   * @returns What it shows, or `undefined` while it does not show it yet.
   */
  readonly shows: (view: MessageShape<View>) => Shown | undefined;
}

/** The read models a program asks the application server about. */
const Targets = {
  /**
   * The one read model of a kind with an identifier.
   *
   * @param schema The kind of read model.
   * @param idSchema The kind of its identifier.
   * @param id The identifier.
   */
  byId<IdSchema extends GenMessage<Message>>(
    schema: GenMessage<Message>,
    idSchema: IdSchema,
    id: MessageShape<IdSchema>,
  ) {
    return create(TargetSchema, {
      type: TypeUrls.derive(schema),
      criterion: {
        case: "filters",
        value: { idFilter: { id: [AnyMessages.pack(idSchema, id)] } },
      },
    });
  },
};

/** The requests a program makes to the application server. */
export const ServerRequests = {
  /**
   * Reads one read model by its identifier.
   *
   * @param request The client that reads.
   * @param schema The kind of read model.
   * @param idSchema The kind of its identifier.
   * @param id The identifier.
   * @returns The read model, or `undefined` when there is none under that identifier.
   */
  async readById<Schema extends GenMessage<Message>, IdSchema extends GenMessage<Message>>(
    request: ServerRequest,
    schema: Schema,
    idSchema: IdSchema,
    id: MessageShape<IdSchema>,
  ): Promise<MessageShape<Schema> | undefined> {
    const type = TypeUrls.derive(schema);
    const response = await request.send(
      create(QuerySchema, {
        id: create(QueryIdSchema, { value: `read-${type}-${crypto.randomUUID()}` }),
        target: Targets.byId(schema, idSchema, id),
      }),
    );
    const state = response.message[0]?.state;
    return state === undefined ? undefined : AnyMessages.unpack(state, schema);
  },

  /**
   * Posts a command and waits until a read model shows what it changed.
   *
   * It suits a command whose effect comes later in a chain of steps, which
   * no single event of the command tells:
   *
   * 1. It subscribes to the read model, and opens the subscription.
   * 2. It posts the command.
   * 3. It waits for an update of the read model that shows the effect.
   * 4. When no such update comes in time, it reads the read model once more.
   *    The read model may have shown the effect before the subscription
   *    opened, as when another sign-in of the same account linked it first.
   *
   * @param request The client that posts the command.
   * @param awaited The command, and the read model that shows its effect.
   * @param patienceMs How long to wait for the update. Ten seconds by default.
   * @returns What the read model shows, or `undefined` if the command was not
   *   accepted or the read model did not show its effect in time.
   */
  async postAndAwaitView<
    Command extends GenMessage<Message>,
    View extends GenMessage<Message>,
    IdSchema extends GenMessage<Message>,
    Shown,
  >(
    request: ServerRequest,
    awaited: AwaitedView<Command, View, IdSchema, Shown>,
    patienceMs: number = PATIENCE_MS,
  ): Promise<Shown | undefined> {
    const target = Targets.byId(awaited.view, awaited.idSchema, awaited.id);
    const type = TypeUrls.derive(awaited.view);
    const watching = await request.createSubscription(
      create(TopicSchema, {
        id: create(TopicIdSchema, { value: `awaited-${type}-${crypto.randomUUID()}` }),
        target,
      }),
      {
        kind: "entity",
        authoritativeQuery: () =>
          create(QuerySchema, {
            id: create(QueryIdSchema, { value: `awaited-${type}-${crypto.randomUUID()}` }),
            target,
          }),
      },
    );
    /** What a state of the read model shows, when it shows the effect. */
    const shownBy = (state: Parameters<typeof AnyMessages.unpack>[0] | undefined) => {
      const view = state === undefined ? undefined : AnyMessages.unpack(state, awaited.view);
      return view === undefined ? undefined : awaited.shows(view);
    };
    const shown = (async (): Promise<Shown | undefined> => {
      for await (const delivery of watching.updates) {
        const states =
          delivery.kind === "resynchronization"
            ? delivery.response.message.map(({ state }) => state)
            : delivery.update.update.case === "entityUpdates"
              ? delivery.update.update.value.update.map(({ kind }) =>
                  kind.case === "state" ? kind.value : undefined,
                )
              : [];
        for (const state of states) {
          const result = shownBy(state);
          if (result !== undefined) {
            return result;
          }
        }
      }
      return undefined;
    })();
    shown.catch(() => undefined);
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const tooLate = new Promise<undefined>((resolve) => {
      giveUp = setTimeout(() => {
        resolve(undefined);
      }, patienceMs);
    });
    try {
      await watching.activate();
      const given = await request.post(awaited.command, awaited.message);
      if (given.kind !== "ok") {
        return undefined;
      }
      const result = await Promise.race([shown, tooLate]);
      if (result !== undefined) {
        return result;
      }
      const last = await ServerRequests.readById(
        request,
        awaited.view,
        awaited.idSchema,
        awaited.id,
      );
      return last === undefined ? undefined : awaited.shows(last);
    } finally {
      clearTimeout(giveUp);
      await watching.cancel();
    }
  },

  /**
   * Finds the read models of one kind that a query describes.
   *
   * @param request The client that reads.
   * @param schema The kind of read model.
   * @param query What to look for, built from the read model's generated query.
   * @returns Those that match.
   */
  async find<Schema extends GenMessage<Message>>(
    request: ServerRequest,
    schema: Schema,
    query: Parameters<ServerRequest["send"]>[0],
  ): Promise<MessageShape<Schema>[]> {
    const response = await request.send(query);
    return response.message.flatMap(({ state }) => {
      const item = state === undefined ? undefined : AnyMessages.unpack(state, schema);
      return item === undefined ? [] : [item];
    });
  },
};
