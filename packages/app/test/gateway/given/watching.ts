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

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { AuthenticatedPrincipal, IncomingRequest } from "@spine-event-engine/auth";
import { TypeUrls } from "@spine-event-engine/core";
import { ActorContextSchema, type ActorContext } from "@spine-event-engine/proto";
import {
  SubscriptionSchema,
  TopicSchema,
  type Subscription,
} from "@spine-event-engine/proto/client";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import type { TestStorage } from "@access-desk/testing/storage";
import type { Session } from "../../../src/gateway/sessions.js";
import { Watching, type CancelAsBrowser } from "../../../src/gateway/watching.js";

/** A subscription that was opened, with whether it has stopped since. */
export interface Opened {
  /** Whether the stream of changes has ended. */
  stopped: boolean;
  /** How the opening ended, once the stream of changes has ended. */
  readonly ending: Promise<{ readonly kind: string } | "failed">;
}

/**
 * Opens what people watch through a gateway, over the subscriptions the
 * storage keeps. A second one over the same storage stands for the gateway
 * after a restart.
 *
 * @param storage The storage of the subscriptions.
 * @param cancelAsBrowser Cancels a subscription the way its browser would.
 */
export async function watchingOver(
  storage: TestStorage,
  cancelAsBrowser?: CancelAsBrowser,
): Promise<Watching> {
  return new Watching(await storage.open(), cancelAsBrowser);
}

/**
 * Names who watches, and in which organization.
 *
 * @param person The identifier of the person who watches.
 * @param organization The identifier of the organization they watch in.
 */
export function watcher(person: string, organization: string): ActorContext {
  return create(ActorContextSchema, {
    actor: { value: person },
    tenantId: { kind: { case: "value", value: organization } },
  });
}

/**
 * Names whoever a session stands for.
 *
 * @param person The identifier of the signed-in person.
 * @param organization The identifier of the organization the session has entered.
 * @param session What the gateway knows the session by.
 */
export function principal(
  person: string,
  organization: string,
  session: string,
): AuthenticatedPrincipal {
  return {
    id: person,
    attributes: { email: `${person}@example.com`, organization, session },
  };
}

/**
 * Builds a session about to end, as the gateway hands it over.
 *
 * @param id What the gateway knows the session by.
 * @param token The session's token.
 */
export function ending(id: string, token: string): Session {
  return { id, credential: { kind: "bearer", value: token } } as Session;
}

/**
 * Has a person subscribe to their organization.
 *
 * @param watching What people watch through the gateway.
 * @param context Who subscribes, and in which organization.
 * @returns The identifier of the subscription.
 */
export async function subscribed(watching: Watching, context: ActorContext): Promise<string> {
  return (await subscription(watching, context)).id?.value ?? "";
}

/**
 * Has a person subscribe to their organization.
 *
 * @param watching What people watch through the gateway.
 * @param context Who subscribes, and in which organization.
 * @returns The subscription, as the gateway hands it to the browser.
 */
export async function subscription(
  watching: Watching,
  context: ActorContext,
): Promise<Subscription> {
  const topic = create(TopicSchema, {
    id: { value: crypto.randomUUID() },
    target: {
      type: TypeUrls.derive(OrganizationViewSchema),
      criterion: { case: "includeAll", value: true },
    },
    context,
  });
  const kept = await watching.create({
    topic: { kind: "subscription-topic", bytes: toBinary(TopicSchema, topic) },
    whenExpires: Date.now() + 60_000,
  });
  return fromBinary(SubscriptionSchema, kept.bytes);
}

/**
 * Returns the gateway's word that it allowed a subscription to be opened.
 *
 * @param id The identifier of the subscription, or the whole subscription as
 *   the browser sends it.
 */
export function opening(id: string | Subscription): IncomingRequest {
  return {
    kind: "activate",
    subscription: typeof id === "string" ? create(SubscriptionSchema, { id: { value: id } }) : id,
  } as IncomingRequest;
}

/**
 * Opens a subscription, so it streams until it is stopped.
 *
 * @param watching What people watch through the gateway.
 * @param id The identifier of the subscription.
 * @param context Who opens it, and in which organization.
 * @returns The opened subscription, once its stream of changes has begun.
 */
export async function opened(
  watching: Watching,
  id: string,
  context: ActorContext,
): Promise<Opened> {
  let begun = (): void => undefined;
  const beginning = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const stream: { stopped: boolean; ending: Opened["ending"] } = {
    stopped: false,
    ending: Promise.resolve("failed"),
  };
  stream.ending = watching
    .activate({
      id,
      context,
      nowMs: Date.now(),
      signal: new AbortController().signal,
      onDefinition: (_definition, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            stream.stopped = true;
            resolve();
          });
          begun();
        }),
    })
    // A stream still open when the gateway stops ends as a failure.
    .catch(() => "failed" as const);
  await beginning;
  return stream;
}
