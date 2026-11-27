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
import type { Any } from "@bufbuild/protobuf/wkt";
import { Http2SessionManager, createGrpcTransport } from "@connectrpc/connect-node";
import {
  Client,
  type Subscription,
  type SubscriptionDelivery,
} from "@spine-event-engine/client-node";
import type { OrganizationId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AnyPacker, TypeUrls } from "@spine-event-engine/core";
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
 * Each organization has a separate client, and all clients share this
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
   * Returns the client for one organization, or for what belongs to none.
   *
   * @param organization The organization, or nothing for what belongs to none.
   * @throws Error When an organization's identifier is empty, which cannot name a tenant.
   */
  in(organization?: OrganizationId): ServerClient {
    if (organization?.value === "") {
      throw new Error("An organization identifier must not be empty.");
    }
    const key = organization?.value;
    let client = this.#clients.get(key);
    if (client === undefined) {
      client = Client.usingTransport(
        this.#transport(),
        organization === undefined ? {} : { tenant: organization.value },
      );
      this.#clients.set(key, client);
    }
    return client;
  }

  /**
   * Closes the connection, with everything that was open on it.
   *
   * The connection ends even when the server does not cancel the
   * subscriptions of its clients, as when it stopped already.
   *
   * @throws Error When the server did not cancel the subscriptions.
   */
  async close(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      this.#open?.sessions.abort();
      this.#open = undefined;
    }
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

/** The time to wait for a command's effect by default. */
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
   * Picks out what the read model shows once the command has had its effect.
   *
   * @returns What it shows, or `undefined` while it does not show it yet.
   */
  readonly shows: (view: MessageShape<View>) => Shown | undefined;
}

/** The read models a program asks the application server about. */
const Targets = {
  /**
   * Targets the one read model of a kind with an identifier.
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
        value: { idFilter: { id: [AnyPacker.pack(idSchema, id)] } },
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
    return state === undefined ? undefined : AnyPacker.tryUnpack(state, schema);
  },

  /**
   * Posts a command and waits until a read model shows what it changed.
   *
   * It suits a command whose effect comes later in a chain of steps, which
   * no single event of the command tells:
   *
   * 1. It subscribes to the read model.
   * 2. It posts the command.
   * 3. It waits for an update that shows the effect.
   *
   * A command that changes nothing brings no update, and so returns nothing.
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
    const shown = Promise.withResolvers<Shown | undefined>();
    const timer = setTimeout(() => {
      shown.resolve(undefined);
    }, patienceMs);
    let subscription: Subscription | undefined;
    try {
      subscription = await ServerRequests.subscribeTo(
        request,
        awaited.view,
        awaited.idSchema,
        awaited.id,
        (view) => {
          const effect = awaited.shows(view);
          if (effect !== undefined) {
            shown.resolve(effect);
          }
        },
      );
      const given = await request.post(awaited.command, awaited.message);
      return given.kind === "ok" ? await shown.promise : undefined;
    } finally {
      clearTimeout(timer);
      await subscription?.cancel();
    }
  },

  /**
   * Subscribes to the state of one entity, such as a projection, by its ID.
   *
   * The subscription brings the state each time it changes, from the moment
   * the subscription is active. What the entity held before is read with
   * `readById`.
   *
   * @param request The client that subscribes.
   * @param schema The type of the entity state.
   * @param idSchema The type of the entity ID.
   * @param id The entity ID.
   * @param observe Takes each state the subscription brings.
   * @returns The active subscription, which the caller cancels.
   */
  async subscribeTo<Schema extends GenMessage<Message>, IdSchema extends GenMessage<Message>>(
    request: ServerRequest,
    schema: Schema,
    idSchema: IdSchema,
    id: MessageShape<IdSchema>,
    observe: (state: MessageShape<Schema>) => void,
  ): Promise<Subscription> {
    const target = Targets.byId(schema, idSchema, id);
    const type = TypeUrls.derive(schema);
    const subscription = await request.createSubscription(
      create(TopicSchema, {
        id: create(TopicIdSchema, { value: `subscribed-${type}-${crypto.randomUUID()}` }),
        target,
      }),
      {
        kind: "entity",
        authoritativeQuery: () =>
          create(QuerySchema, {
            id: create(QueryIdSchema, { value: `subscribed-${type}-${crypto.randomUUID()}` }),
            target,
          }),
      },
    );
    void (async () => {
      for await (const delivery of subscription.updates) {
        for (const state of statesOf(delivery)) {
          const unpacked = state === undefined ? undefined : AnyPacker.tryUnpack(state, schema);
          if (unpacked !== undefined) {
            observe(unpacked);
          }
        }
      }
    })().catch(() => {
      // The subscription ends with its updates.
    });
    try {
      await subscription.activate();
    } catch (error) {
      await subscription.cancel();
      throw error;
    }
    return subscription;
  },

  /**
   * Posts a command, and subscribes to the events and rejections its handler emits.
   *
   * The subscription brings only what the handler emits for the command, not
   * what other entities emit later in reaction. Such later steps show in an
   * entity the caller subscribes to with `subscribeTo`.
   *
   * @param request The client that posts the command.
   * @param schema The type of the command.
   * @param message The command.
   * @param outcomes The types of the events and rejections to subscribe to.
   * @param observe Takes each event or rejection, packed.
   * @returns The subscription, which the caller cancels, or `undefined` when
   *   the server did not take the command.
   */
  async postAndSubscribe<Schema extends GenMessage<Message>>(
    request: ServerRequest,
    schema: Schema,
    message: MessageShape<Schema>,
    outcomes: readonly GenMessage<Message>[],
    observe: (outcome: Any) => void,
  ): Promise<Subscription | undefined> {
    const posted = await request.postAndSubscribe(schema, message, { events: [...outcomes] });
    if (posted.kind !== "accepted") {
      return undefined;
    }
    void (async () => {
      for await (const delivery of posted.subscription.updates) {
        if (delivery.kind === "update" && delivery.update.update.case === "eventUpdates") {
          for (const event of delivery.update.update.value.event) {
            if (event.message !== undefined) {
              observe(event.message);
            }
          }
        }
      }
    })().catch(() => {
      // The subscription ends with its updates.
    });
    return posted.subscription;
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
      const item = state === undefined ? undefined : AnyPacker.tryUnpack(state, schema);
      return item === undefined ? [] : [item];
    });
  },
};

/**
 * Gives the states of a read model that one delivery of its subscription brings.
 *
 * @param delivery The delivery.
 * @returns The packed states, with `undefined` for an update that carries none.
 */
function statesOf(delivery: SubscriptionDelivery): (Any | undefined)[] {
  if (delivery.kind === "resynchronization") {
    return delivery.response.message.map(({ state }) => state);
  }
  return delivery.update.update.case === "entityUpdates"
    ? delivery.update.update.value.update.map(({ kind }) =>
        kind.case === "state" ? kind.value : undefined,
      )
    : [];
}
