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
import type {
  AuthenticatedPrincipal,
  IncomingRequest,
  PublicSubscriptionWire,
} from "@spine-event-engine/auth";
import { Time } from "@spine-event-engine/core/time";
import type { ActorContext } from "@spine-event-engine/proto";
import { SubscriptionSchema, TopicSchema } from "@spine-event-engine/proto/client";
import { DurableSubscriptionBindings } from "@spine-event-engine/server/browser";
import type { StorageFactory } from "@spine-event-engine/storage";
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
 * A browser subscribes to read models, then opens the subscription to
 * receive every change. A subscription belongs to the session that opened it:
 *
 * 1. A browser subscribes. The gateway keeps the subscription for the
 *    session's person and organization.
 * 2. The browser opens the subscription. From then on it belongs to that
 *    session.
 * 3. The session ends, because the person signs out. Everything it opened
 *    stops at once.
 *
 * A subscription that was never opened is dropped when its session expires.
 *
 * The gateway keeps the subscriptions in its storage, so they outlast a
 * restart of the gateway until their sessions expire. Which session opened a
 * subscription is kept only in memory. After a restart, the gateway learns it
 * again when a browser opens the subscription again.
 *
 * Ending a session stops its subscriptions in two steps, because Spine fully
 * clears a subscription only when it is cancelled through the gateway:
 *
 * 1. While the session is still valid, the gateway cancels each subscription
 *    the way its browser would. That clears it in the gateway and on the
 *    application server. A cancel that fails is tried again, three times in
 *    all.
 * 2. Once the session has ended, anything still open is stopped in the
 *    gateway. The browser receives nothing more, though Spine remembers the
 *    subscription until the session would have expired.
 */
export class Watching extends DurableSubscriptionBindings implements OpenedUnderSessions {
  /** The subscriptions held now, by identifier. */
  readonly #watched: Map<string, Watched>;
  /**
   * Who asks to open a subscription the gateway does not know, and in which
   * session, by the subscription's identifier, until Spine opens it.
   */
  readonly #claimed = new Map<
    string,
    {
      readonly person: string;
      readonly organization: string | undefined;
      readonly session: string | undefined;
    }
  >();
  /** Cancels a subscription the way its browser would. */
  readonly #cancelAsBrowser: CancelAsBrowser | undefined;

  /**
   * @param storage Where the gateway keeps the subscriptions. Whoever passes
   *   it closes it.
   * @param cancelAsBrowser Cancels a subscription the way its browser would.
   *   When left out, the subscriptions of an ended session are only stopped
   *   in the gateway.
   */
  constructor(storage: StorageFactory, cancelAsBrowser?: CancelAsBrowser) {
    const watched = new Map<string, Watched>();
    super({
      storageFactory: storage,
      namespace: "access-desk-gateway",
      nextId: () => crypto.randomUUID(),
      // Spine drops a subscription when its session expires, after it has
      // stopped it on the application server.
      cleanup: (definition) => {
        const id = fromBinary(SubscriptionSchema, definition.bytes).id?.value;
        if (id !== undefined) {
          watched.delete(id);
        }
        return Promise.resolve();
      },
    });
    this.#watched = watched;
    this.#cancelAsBrowser = cancelAsBrowser;
  }

  /** Keeps a new subscription for the person and the organization it was made for. */
  override async create(
    input: Parameters<DurableSubscriptionBindings["create"]>[0],
  ): ReturnType<DurableSubscriptionBindings["create"]> {
    const context = fromBinary(TopicSchema, input.topic.bytes).context;
    const kept = await super.create(input);
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
   * it. A second opening is refused, so the attempt changes nothing.
   *
   * The gateway does not know a subscription made before it restarted. It
   * notes which session asks to open it, and learns the subscription once
   * Spine opens it for that person, in that organization.
   *
   * @param principal The person the session stands for.
   * @param request The request the gateway allowed.
   */
  claim(principal: AuthenticatedPrincipal, request: IncomingRequest): void {
    if (request.kind !== "activate") {
      return;
    }
    const id = request.subscription.id?.value ?? "";
    const watched = this.#watched.get(id);
    if (watched === undefined) {
      this.#claimed.set(id, {
        person: principal.id,
        organization: principal.attributes?.organization,
        session: principal.attributes?.[SESSION],
      });
      return;
    }
    if (
      watched.stream === undefined &&
      watched.context.actor?.value === principal.id &&
      this.#organizationOf(watched.context) === principal.attributes?.organization
    ) {
      watched.session = principal.attributes?.[SESSION];
    }
  }

  /**
   * Opens a subscription. Its changes are then sent until it is stopped.
   *
   * It is refused to anybody it was not created for, and while it is open
   * already.
   */
  override activate(
    input: Parameters<DurableSubscriptionBindings["activate"]>[0],
  ): ReturnType<DurableSubscriptionBindings["activate"]> {
    const watched = this.#watched.get(input.id);
    if (watched === undefined) {
      return this.#activateUnknown(input);
    }
    if (
      watched.stream !== undefined ||
      watched.context.actor?.value !== input.context.actor?.value ||
      this.#organizationOf(watched.context) !== this.#organizationOf(input.context)
    ) {
      // Spine would keep a second opening waiting until the first stream
      // ends, and then open it again.
      return Promise.resolve({ kind: "denied" });
    }
    const stream = new AbortController();
    watched.stream = stream;
    return super
      .activate({ ...input, signal: AbortSignal.any([input.signal, stream.signal]) })
      .finally(() => {
        // The stream is over, so there is nothing left to stop. If it failed,
        // Spine lets the subscription be opened again.
        if (watched.stream === stream) {
          watched.stream = undefined;
        }
      });
  }

  /**
   * Opens a subscription the gateway does not know, such as one made before
   * it restarted.
   *
   * Spine opens it only for the person and in the organization it keeps the
   * subscription for. Once it does, the gateway learns the subscription as
   * Spine keeps it, with the session that asked to open it.
   */
  #activateUnknown(
    input: Parameters<DurableSubscriptionBindings["activate"]>[0],
  ): ReturnType<DurableSubscriptionBindings["activate"]> {
    const claimed = this.#claimed.get(input.id);
    this.#claimed.delete(input.id);
    // Only the person who asked, in their organization, opens it in their session.
    const session =
      claimed !== undefined &&
      claimed.person === input.context.actor?.value &&
      claimed.organization === this.#organizationOf(input.context)
        ? claimed.session
        : undefined;
    const stream = new AbortController();
    let learned: Watched | undefined;
    return super
      .activate({
        ...input,
        signal: AbortSignal.any([input.signal, stream.signal]),
        onDefinition: (definition, signal) => {
          learned = {
            subscription: definition.bytes.slice(),
            context: input.context,
            session,
            stream,
          };
          this.#watched.set(input.id, learned);
          return input.onDefinition(definition, signal);
        },
      })
      .finally(() => {
        if (learned?.stream === stream) {
          learned.stream = undefined;
        }
      });
  }

  /** Stops a subscription its browser no longer wants. */
  override async cancel(
    input: Parameters<DurableSubscriptionBindings["cancel"]>[0],
  ): ReturnType<DurableSubscriptionBindings["cancel"]> {
    const outcome = await super.cancel(input);
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
        const dropped = super.cancel({
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

  /**
   * Stops every open stream, when the gateway stops.
   *
   * The subscriptions stay in the gateway's storage.
   */
  override async close(): Promise<void> {
    await super.close();
    this.#watched.clear();
    this.#claimed.clear();
  }

  /** The organization a subscription was created in, when it was created in one. */
  #organizationOf(context: ActorContext): string | undefined {
    const tenant = context.tenantId?.kind;
    return tenant?.case === "value" ? tenant.value : undefined;
  }
}
