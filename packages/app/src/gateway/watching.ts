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

/**
 * How long the leave to open a subscription waits for the opening.
 *
 * The opening follows its leave at once, within the same request. Leave that
 * is not used, because Spine refused the request after the gateway allowed it,
 * is dropped once this has passed.
 */
const LEAVE_MS = 5_000;

/** One subscription a browser holds. */
interface Watched {
  /**
   * The subscription, as the gateway handed it to the browser. The gateway
   * has it once the subscription is made, or, for one made before the
   * gateway restarted, once it opens.
   */
  subscription: Uint8Array | undefined;
  /** The person and the organization the subscription was created for. */
  readonly context: ActorContext;
  /** The session that opened the subscription, while it is open or was last opened. */
  session: string | undefined;
  /** Ends the open stream of changes, while there is one. */
  stream: AbortController | undefined;
}

/** The leave one session got from the gateway to open one subscription. */
interface Leave {
  /** The person the session stands for. */
  readonly person: string;
  /** The organization the session works in. */
  readonly organization: string | undefined;
  /** The session. */
  readonly session: string | undefined;
  /** Until when the leave holds, in milliseconds. */
  readonly untilMs: number;
}

/**
 * The subscriptions signed-in people hold through the gateway.
 *
 * A browser subscribes to read models, then opens the subscription to
 * receive every change. A subscription belongs to the session that opened it:
 *
 * 1. A browser subscribes. The gateway keeps the subscription for the
 *    session's person and organization.
 * 2. The gateway allows the browser to open the subscription, and gives that
 *    one request leave to open it. No other request gets leave while the
 *    subscription opens or is open.
 * 3. The request opens the subscription with its leave. From then on the
 *    subscription belongs to the request's session.
 * 4. The session ends, because the person signs out. Everything it opened
 *    stops at once.
 *
 * A subscription that was never opened is dropped when its session expires.
 *
 * The gateway keeps the subscriptions in its storage, so they outlast a
 * restart of the gateway until their sessions expire. A subscription made
 * before a restart opens the same way, with the leave of the request that
 * opens it.
 *
 * Ending a session stops its subscriptions in two steps, because Spine fully
 * clears a subscription only when it is cancelled through the gateway:
 *
 * 1. While the session is still valid, the gateway cancels each subscription
 *    the way its browser would. That clears it in the gateway and on the
 *    application server. A cancel that fails is tried again, three times in
 *    all.
 * 2. Once the session has ended, anything still open or opening is stopped in
 *    the gateway. The browser receives nothing more. The gateway keeps the
 *    subscription until the session would have expired, when Spine clears it
 *    on the application server as well.
 */
export class Watching extends DurableSubscriptionBindings implements OpenedUnderSessions {
  /** The subscriptions held now, by identifier. */
  readonly #watched: Map<string, Watched>;
  /** The leave given to open a subscription and not used yet, by the subscription's identifier. */
  readonly #leave = new Map<string, Leave>();
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
   * Gives a request leave to open a subscription, for the session it comes in.
   *
   * The gateway asks for every request it allows, and refuses the request
   * when this refuses it. Only the opening of a subscription needs leave:
   *
   * - A subscription that opens or is open already gets no more. Spine would
   *   keep a second opening waiting until the first stream ends, and then
   *   open it for whoever asked.
   * - A subscription the gateway knows gets leave only for the person and in
   *   the organization it was created for. One made before the gateway
   *   restarted is checked by Spine when it opens.
   *
   * The leave is used by the opening of this request alone, and dropped if
   * the opening does not come.
   *
   * @param principal The person the session stands for.
   * @param request The request the gateway allows.
   * @returns Whether the request may go on.
   */
  claim(principal: AuthenticatedPrincipal, request: IncomingRequest): boolean {
    if (request.kind !== "activate") {
      return true;
    }
    const nowMs = Time.currentTimeMillis();
    for (const [id, leave] of this.#leave) {
      if (leave.untilMs <= nowMs) {
        this.#leave.delete(id);
      }
    }
    const id = request.subscription.id?.value ?? "";
    const watched = this.#watched.get(id);
    const person = principal.id;
    const organization = principal.attributes?.organization;
    if (
      this.#leave.has(id) ||
      watched?.stream !== undefined ||
      (watched !== undefined &&
        (watched.context.actor?.value !== person ||
          this.#organizationOf(watched.context) !== organization))
    ) {
      return false;
    }
    this.#leave.set(id, {
      person,
      organization,
      session: principal.attributes?.[SESSION],
      untilMs: nowMs + LEAVE_MS,
    });
    return true;
  }

  /**
   * Opens a subscription. Its changes are then sent until it is stopped.
   *
   * It opens only with the leave {@link claim} gave the request, for the
   * person and in the organization the leave was given to. The subscription
   * then belongs to the session the leave was given in.
   */
  override activate(
    input: Parameters<DurableSubscriptionBindings["activate"]>[0],
  ): ReturnType<DurableSubscriptionBindings["activate"]> {
    const leave = this.#leave.get(input.id);
    this.#leave.delete(input.id);
    const known = this.#watched.get(input.id);
    if (
      leave === undefined ||
      leave.untilMs <= Time.currentTimeMillis() ||
      leave.person !== input.context.actor?.value ||
      leave.organization !== this.#organizationOf(input.context) ||
      known?.stream !== undefined
    ) {
      return Promise.resolve({ kind: "denied" });
    }
    // A subscription made before the gateway restarted is learned as it
    // opens. Until Spine hands it over, the gateway knows only who opens it.
    const watched: Watched = known ?? {
      subscription: undefined,
      context: input.context,
      session: undefined,
      stream: undefined,
    };
    const stream = new AbortController();
    watched.session = leave.session;
    watched.stream = stream;
    this.#watched.set(input.id, watched);
    return super
      .activate({
        ...input,
        signal: AbortSignal.any([input.signal, stream.signal]),
        onDefinition: (definition, signal) => {
          watched.subscription ??= definition.bytes.slice();
          return input.onDefinition(definition, signal);
        },
      })
      .finally(() => {
        // The stream is over, so there is nothing left to stop. If it failed,
        // Spine lets the subscription be opened again.
        if (watched.stream === stream) {
          watched.stream = undefined;
        }
        // A subscription Spine did not open for this person is not one of theirs.
        if (watched.subscription === undefined && this.#watched.get(input.id) === watched) {
          this.#watched.delete(input.id);
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
    const opened = [...this.#watched.values()].flatMap(({ session: openedIn, subscription }) =>
      openedIn === session.id && subscription !== undefined ? [subscription] : [],
    );
    const cancelled = await Promise.allSettled(
      opened.map(async (subscription) => {
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
   * Stops everything still open or opening after a session has ended.
   *
   * The leave the session got to open a subscription is withdrawn. Each
   * stream the session opened ends. The gateway keeps the subscriptions until
   * the session would have expired: Spine then clears them on the application
   * server, which it does not do for a subscription the gateway forgets
   * before.
   *
   * @param session The identifier of the session.
   */
  stop(session: string): Promise<void> {
    for (const [id, leave] of this.#leave) {
      if (leave.session === session) {
        this.#leave.delete(id);
      }
    }
    for (const watched of this.#watched.values()) {
      if (watched.session === session) {
        watched.session = undefined;
        watched.stream?.abort();
      }
    }
    return Promise.resolve();
  }

  /**
   * Stops every open stream, when the gateway stops.
   *
   * The subscriptions stay in the gateway's storage.
   */
  override async close(): Promise<void> {
    await super.close();
    this.#watched.clear();
    this.#leave.clear();
  }

  /** The organization a subscription was created in, when it was created in one. */
  #organizationOf(context: ActorContext): string | undefined {
    const tenant = context.tenantId?.kind;
    return tenant?.case === "value" ? tenant.value : undefined;
  }
}
