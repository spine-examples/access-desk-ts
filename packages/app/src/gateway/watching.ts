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

import { fromBinary } from "@bufbuild/protobuf";
import {
  InMemorySubscriptionBindings,
  type AuthenticatedPrincipal,
  type IncomingRequest,
  type PublicSubscriptionWire,
  type SubscriptionBindings,
} from "@spine-event-engine/auth";
import { Time } from "@spine-event-engine/core/time";
import type { ActorContext } from "@spine-event-engine/proto";
import { SubscriptionSchema, TopicSchema } from "@spine-event-engine/proto/client";
import { SESSION, type OpenedUnderSessions, type Session } from "./sessions.js";

/**
 * Cancels a subscription as the browser that holds a session would, through
 * the gateway's own address.
 *
 * @param subscription The subscription, as the gateway handed it to the browser.
 * @param token The token of the session the subscription was opened under.
 */
export type CancelAsBrowser = (
  subscription: PublicSubscriptionWire,
  token: string,
) => Promise<void>;

/** One thing a browser watches. */
interface Watched {
  /** The subscription, as the gateway handed it to the browser. */
  readonly subscription: Uint8Array;
  /** Who watches, and in which organization, as the gateway said when the watching began. */
  readonly context: ActorContext;
  /** The session the watching was last opened under, once it was opened. */
  session: string | undefined;
  /** Ends the stream of changes the watching was last opened with, once it was opened. */
  stream: AbortController | undefined;
}

/** The organization somebody watches in, when they watch in one. */
function organizationOf(context: ActorContext): string | undefined {
  const tenant = context.tenantId?.kind;
  return tenant?.case === "value" ? tenant.value : undefined;
}

/**
 * What the signed-in people watch through the gateway.
 *
 * A browser watches read models by subscribing to them, and then opens the
 * subscription to be told of every change. What it watches belongs to the
 * session it opened the subscription under:
 *
 * 1. A browser subscribes. The gateway keeps the subscription for the person
 *    and the organization the session names.
 * 2. The browser opens the subscription. From then on it belongs to that
 *    session.
 * 3. The session ends, because the person signs out or enters another
 *    organization. Everything opened under it stops at once, so nothing more
 *    is told to a browser that is no longer signed in.
 *
 * A subscription that was never opened tells nobody anything. It is dropped
 * when the time of the session it was made under runs out.
 *
 * Everything is kept in memory, so all watching ends when the gateway stops.
 *
 * Ending a session stops what it opened in two steps, because Spine gives a
 * gateway only one way to clear a subscription everywhere it is kept:
 *
 * 1. While the session is still good, the gateway cancels each subscription
 *    in the session's own name, as its browser would. That clears it in the
 *    gateway and at the application server alike.
 * 2. Once the session has ended, whatever is still open under it is stopped
 *    where the gateway keeps it. The browser is told nothing more, though
 *    Spine remembers the subscription until the gateway stops.
 */
export class Watching implements SubscriptionBindings, OpenedUnderSessions {
  /** What is watched now, by the identifier of each subscription. */
  readonly #watched = new Map<string, Watched>();
  /** Cancels a subscription as the browser that holds its session would. */
  readonly #cancelAsBrowser: CancelAsBrowser | undefined;

  /**
   * The subscriptions themselves, as Spine keeps them for a gateway.
   *
   * Spine drops a subscription whose session's time ran out, and every one
   * when the gateway stops. It does not let a gateway of its own program
   * clear what it remembers of a dropped subscription, so nothing more is
   * done when one is dropped.
   */
  readonly #kept = new InMemorySubscriptionBindings({
    nextId: () => crypto.randomUUID(),
    dispose: (definition) => {
      const id = fromBinary(SubscriptionSchema, definition.bytes).id?.value;
      if (id !== undefined) {
        this.#watched.delete(id);
      }
      return Promise.resolve();
    },
  });

  /**
   * @param cancelAsBrowser Cancels a subscription as the browser that holds
   *   its session would. When left out, an ended session's subscriptions are
   *   only stopped where the gateway keeps them.
   */
  constructor(cancelAsBrowser?: CancelAsBrowser) {
    this.#cancelAsBrowser = cancelAsBrowser;
  }

  /** Keeps a new subscription for the person and the organization it was made for. */
  async create(
    input: Parameters<SubscriptionBindings["create"]>[0],
  ): ReturnType<SubscriptionBindings["create"]> {
    const context = fromBinary(TopicSchema, input.topic.bytes).context;
    const kept = await this.#kept.create(input);
    const id = fromBinary(SubscriptionSchema, kept.bytes).id?.value;
    if (id !== undefined && context !== undefined) {
      this.#watched.set(id, {
        subscription: kept.bytes.slice(),
        context,
        session: undefined,
        stream: undefined,
      });
    }
    return kept;
  }

  /**
   * Notes the session a subscription is being opened under.
   *
   * The gateway calls this for every request it has just allowed. Only the
   * opening of a subscription matters, and only by the person, in the
   * organization, the subscription was made for.
   *
   * @param principal Whoever the session stands for.
   * @param request The request the gateway allowed.
   */
  claim(principal: AuthenticatedPrincipal, request: IncomingRequest): void {
    if (request.kind !== "activate") {
      return;
    }
    const watched = this.#watched.get(request.subscription.id?.value ?? "");
    if (
      watched?.context.actor?.value === principal.id &&
      organizationOf(watched.context) === principal.attributes?.organization
    ) {
      watched.session = principal.attributes?.[SESSION];
    }
  }

  /** Opens a subscription, so its changes are told until it is stopped. */
  activate(
    input: Parameters<SubscriptionBindings["activate"]>[0],
  ): ReturnType<SubscriptionBindings["activate"]> {
    const watched = this.#watched.get(input.id);
    if (
      watched === undefined ||
      watched.context.actor?.value !== input.context.actor?.value ||
      organizationOf(watched.context) !== organizationOf(input.context)
    ) {
      // Somebody the subscription was not made for is refused where it is kept.
      return this.#kept.activate(input);
    }
    const stream = new AbortController();
    watched.stream = stream;
    return this.#kept.activate({
      ...input,
      signal: AbortSignal.any([input.signal, stream.signal]),
    });
  }

  /** Stops a subscription its browser no longer wants. */
  async cancel(
    input: Parameters<SubscriptionBindings["cancel"]>[0],
  ): ReturnType<SubscriptionBindings["cancel"]> {
    const outcome = await this.#kept.cancel(input);
    if (outcome.kind === "closed") {
      this.#watched.delete(input.id);
    }
    return outcome;
  }

  /**
   * Cancels everything opened under a session that is about to end, in the
   * session's own name.
   *
   * What cannot be cancelled this way is left for {@link stop}.
   *
   * @param session The session, while its token still works.
   */
  async closeFor(session: Session): Promise<void> {
    const cancelAsBrowser = this.#cancelAsBrowser;
    if (cancelAsBrowser === undefined) {
      return;
    }
    const opened = [...this.#watched.values()].filter((watched) => watched.session === session.id);
    const cancelled = await Promise.allSettled(
      opened.map(({ subscription }) =>
        cancelAsBrowser(
          { kind: "public-subscription", bytes: subscription.slice() },
          session.credential.value,
        ),
      ),
    );
    for (const outcome of cancelled) {
      if (outcome.status === "rejected") {
        console.warn(
          "The gateway could not cancel a subscription of a session about to end.",
          outcome.reason,
        );
      }
    }
  }

  /**
   * Stops everything still open under a session that has ended.
   *
   * @param session What the gateway knows the session by.
   */
  async stop(session: string): Promise<void> {
    const opened = [...this.#watched].filter(([, watched]) => watched.session === session);
    const stopped = await Promise.allSettled(
      opened.map(async ([id, { context, stream }]) => {
        const dropped = this.#kept.cancel({
          id,
          context,
          nowMs: Time.currentTimeMillis(),
          onDefinition: () => Promise.resolve(),
        });
        // A stream that was only about to open is ended as well, so the
        // subscription is not left waiting for it.
        stream?.abort();
        await dropped;
        this.#watched.delete(id);
      }),
    );
    for (const outcome of stopped) {
      if (outcome.status === "rejected") {
        console.warn(
          "The gateway could not stop a subscription of an ended session.",
          outcome.reason,
        );
      }
    }
  }

  /** Drops the subscriptions whose sessions' time has run out. */
  purgeExpired(nowMs: number): Promise<void> {
    return this.#kept.purgeExpired(nowMs);
  }

  /** Stops all watching, when the gateway stops. */
  async close(): Promise<void> {
    await this.#kept.close();
    this.#watched.clear();
  }
}
