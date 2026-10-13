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
 * Cancels a subscription the way its browser would, through the gateway's own
 * address.
 *
 * @param subscription The subscription, as the gateway handed it to the browser.
 * @param token The token of the session the subscription was opened under.
 */
export type CancelAsBrowser = (
  subscription: PublicSubscriptionWire,
  token: string,
) => Promise<void>;

/** How many times the gateway tries to cancel a subscription of a session about to end. */
const CANCEL_ATTEMPTS = 3;

/** How long the gateway waits before it tries to cancel a subscription again. */
const CANCEL_PAUSE_MS = 100;

/** One subscription a browser holds. */
interface Watched {
  /** The subscription, as the gateway handed it to the browser. */
  readonly subscription: Uint8Array;
  /** The person and the organization the subscription was created for. */
  readonly context: ActorContext;
  /** The session that opened the subscription, once one has. */
  session: string | undefined;
  /** Ends the open stream of changes, while there is one. */
  stream: AbortController | undefined;
}

/**
 * The subscriptions signed-in people hold through the gateway.
 *
 * A browser subscribes to read models, then opens the subscription to be
 * told of every change. A subscription belongs to the session that opened it:
 *
 * 1. A browser subscribes. The gateway keeps the subscription for the
 *    session's person and organization.
 * 2. The browser opens the subscription. From then on it belongs to that
 *    session.
 * 3. The session ends, because the person signs out or enters another
 *    organization. Everything it opened stops at once.
 *
 * A subscription that was never opened is dropped when its session expires.
 *
 * Ending a session stops its subscriptions in two steps, because Spine fully
 * clears a subscription only when it is cancelled through the gateway:
 *
 * 1. While the session is still valid, the gateway cancels each subscription
 *    the way its browser would. That clears it in the gateway and on the
 *    application server. A cancel that fails is tried again, three times in
 *    all.
 * 2. Once the session has ended, anything still open is stopped in the
 *    gateway. The browser is told nothing more, though Spine remembers the
 *    subscription until the gateway stops.
 */
export class Watching implements SubscriptionBindings, OpenedUnderSessions {
  /** The subscriptions held now, by identifier. */
  readonly #watched = new Map<string, Watched>();
  /** Cancels a subscription the way its browser would. */
  readonly #cancelAsBrowser: CancelAsBrowser | undefined;

  /**
   * Spine's own store of the subscriptions.
   *
   * Spine drops a subscription when its session expires, and all of them when
   * the gateway stops. It gives the gateway no way to clear what it remembers
   * of a dropped subscription, so nothing more is done then.
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
   * @param cancelAsBrowser Cancels a subscription the way its browser would.
   *   When left out, the subscriptions of an ended session are only stopped
   *   in the gateway.
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
   * Records which session opens a subscription.
   *
   * The gateway calls this for every request it allows. Only the opening of a
   * subscription matters, and only by the person and in the organization the
   * subscription was created for.
   *
   * A subscription that is open already stays with the session that opened
   * it. Spine refuses to open it a second time, so the attempt changes nothing.
   *
   * @param principal The person the session stands for.
   * @param request The request the gateway allowed.
   */
  claim(principal: AuthenticatedPrincipal, request: IncomingRequest): void {
    if (request.kind !== "activate") {
      return;
    }
    const watched = this.#watched.get(request.subscription.id?.value ?? "");
    if (
      watched?.stream === undefined &&
      watched?.context.actor?.value === principal.id &&
      this.#organizationOf(watched.context) === principal.attributes?.organization
    ) {
      watched.session = principal.attributes?.[SESSION];
    }
  }

  /** Opens a subscription. Its changes are then sent until it is stopped. */
  activate(
    input: Parameters<SubscriptionBindings["activate"]>[0],
  ): ReturnType<SubscriptionBindings["activate"]> {
    const watched = this.#watched.get(input.id);
    if (
      watched === undefined ||
      watched.stream !== undefined ||
      watched.context.actor?.value !== input.context.actor?.value ||
      this.#organizationOf(watched.context) !== this.#organizationOf(input.context)
    ) {
      // Spine's store refuses anybody the subscription was not created for,
      // and a subscription that is open already.
      return this.#kept.activate(input);
    }
    const stream = new AbortController();
    watched.stream = stream;
    return this.#kept
      .activate({ ...input, signal: AbortSignal.any([input.signal, stream.signal]) })
      .finally(() => {
        // The stream is over, so there is nothing left to stop. If it failed,
        // Spine lets the subscription be opened again.
        if (watched.stream === stream) {
          watched.stream = undefined;
        }
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
   * Cancels everything a session opened, while its token still works.
   *
   * A cancel that fails is tried again, three times in all.
   * What still cannot be canceled is left for {@link stop}.
   *
   * @param session The session that is about to end.
   */
  async closeFor(session: Session): Promise<void> {
    const cancelAsBrowser = this.#cancelAsBrowser;
    if (cancelAsBrowser === undefined) {
      return;
    }
    const opened = [...this.#watched.values()].filter((watched) => watched.session === session.id);
    const cancelled = await Promise.allSettled(
      opened.map(async ({ subscription }) => {
        for (let attempt = 1; ; attempt++) {
          try {
            await cancelAsBrowser(
              { kind: "public-subscription", bytes: subscription.slice() },
              session.credential.value,
            );
            return;
          } catch (error) {
            if (attempt === CANCEL_ATTEMPTS) {
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, CANCEL_PAUSE_MS));
          }
        }
      }),
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
   * Stops everything still open after a session has ended.
   *
   * @param session The identifier of the session.
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

  /** Drops the subscriptions of the sessions that have expired. */
  purgeExpired(nowMs: number): Promise<void> {
    return this.#kept.purgeExpired(nowMs);
  }

  /** Stops every subscription, when the gateway stops. */
  async close(): Promise<void> {
    await this.#kept.close();
    this.#watched.clear();
  }

  /** The organization a subscription was created in, when it was created in one. */
  #organizationOf(context: ActorContext): string | undefined {
    const tenant = context.tenantId?.kind;
    return tenant?.case === "value" ? tenant.value : undefined;
  }
}
