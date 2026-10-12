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
import { SubscriptionSchema, TopicSchema } from "@spine-event-engine/proto/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import type { Session } from "../../src/gateway/sessions.js";
import { Watching } from "../../src/gateway/watching.js";

let watching = new Watching();
afterEach(async () => {
  await watching.close();
  watching = new Watching();
});

/**
 * Who watches, and in which organization.
 *
 * @param person The identifier of the person who watches.
 * @param organization The identifier of the organization they watch in.
 */
function watcher(person: string, organization: string): ActorContext {
  return create(ActorContextSchema, {
    actor: { value: person },
    tenantId: { kind: { case: "value", value: organization } },
  });
}

/**
 * Whoever a session stands for.
 *
 * @param person The identifier of the signed-in person.
 * @param organization The identifier of the organization the session has entered.
 * @param session What the gateway knows the session by.
 */
function principal(person: string, organization: string, session: string): AuthenticatedPrincipal {
  return {
    id: person,
    attributes: { email: `${person}@example.com`, organization, session },
  };
}

/**
 * Has a person subscribe to their organization.
 *
 * @param context Who subscribes, and in which organization.
 * @returns The identifier of the subscription.
 */
async function subscribed(context: ActorContext): Promise<string> {
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
  return fromBinary(SubscriptionSchema, kept.bytes).id?.value ?? "";
}

/**
 * The gateway's word that it allowed a subscription to be opened.
 *
 * @param id The identifier of the subscription.
 */
function opening(id: string): IncomingRequest {
  return {
    kind: "activate",
    subscription: create(SubscriptionSchema, { id: { value: id } }),
  } as IncomingRequest;
}

/** A subscription that was opened, with whether it has stopped since. */
interface Opened {
  /** Whether the stream of changes has ended. */
  stopped: boolean;
  /** How the opening ended, once the stream of changes has ended. */
  readonly ending: Promise<{ readonly kind: string } | "failed">;
}

/**
 * Opens a subscription, so it streams until it is stopped.
 *
 * @param id The identifier of the subscription.
 * @param context Who opens it, and in which organization.
 * @returns The opened subscription, once its stream of changes has begun.
 */
async function opened(id: string, context: ActorContext): Promise<Opened> {
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

describe("What people watch through the gateway should", () => {
  it("stop when the session it was opened under ends", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(id, maya);

    await watching.stop("session-1");

    await stream.ending;
    expect(stream.stopped).toBe(true);
    // The subscription is gone, so it cannot be opened again.
    expect(
      await watching.activate({
        id,
        context: maya,
        nowMs: Date.now(),
        signal: new AbortController().signal,
        onDefinition: () => Promise.resolve(),
      }),
    ).toEqual({ kind: "denied" });
  });

  it("stop a subscription that was only about to open", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    let begun = false;
    const beginning = watching.activate({
      id,
      context: maya,
      nowMs: Date.now(),
      signal: new AbortController().signal,
      onDefinition: () => {
        begun = true;
        return new Promise<void>(() => undefined);
      },
    });

    // The session ends before the stream has begun.
    await watching.stop("session-1");

    expect(await beginning).toEqual({ kind: "denied" });
    expect(begun).toBe(false);
  });

  it("go on when another session of the same person ends", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(id, maya);

    await watching.stop("session-2");

    expect(stream.stopped).toBe(false);
  });

  it("stop everything a session opened, and nothing it did not", async () => {
    const maya = watcher("maya", "acme");
    const noah = watcher("noah", "acme");
    const [first, second, others] = [
      await subscribed(maya),
      await subscribed(maya),
      await subscribed(noah),
    ];
    watching.claim(principal("maya", "acme", "session-1"), opening(first));
    watching.claim(principal("maya", "acme", "session-1"), opening(second));
    watching.claim(principal("noah", "acme", "session-9"), opening(others));
    const streams = [
      await opened(first, maya),
      await opened(second, maya),
      await opened(others, noah),
    ];

    await watching.stop("session-1");

    expect(streams.map((stream) => stream.stopped)).toEqual([true, true, false]);
  });

  it("belong to the session that opened it last", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    watching.claim(principal("maya", "acme", "session-2"), opening(id));
    const stream = await opened(id, maya);

    await watching.stop("session-1");
    expect(stream.stopped).toBe(false);

    await watching.stop("session-2");
    expect(stream.stopped).toBe(true);
  });

  it("not be taken over by somebody it was not made for", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(id, maya);

    // Another person, and the same person in another organization, try to open it.
    watching.claim(principal("noah", "acme", "session-9"), opening(id));
    watching.claim(principal("maya", "globex", "session-8"), opening(id));
    await watching.stop("session-9");
    await watching.stop("session-8");

    expect(stream.stopped).toBe(false);
    await watching.stop("session-1");
    expect(stream.stopped).toBe(true);
  });

  it("be cancelled in the name of a session about to end, as its browser would", async () => {
    const cancelled: { readonly id: string | undefined; readonly token: string }[] = [];
    await watching.close();
    watching = new Watching((subscription, token) => {
      cancelled.push({ id: fromBinary(SubscriptionSchema, subscription.bytes).id?.value, token });
      return Promise.resolve();
    });
    const maya = watcher("maya", "acme");
    const [hers, alsoHers, unopened] = [
      await subscribed(maya),
      await subscribed(maya),
      await subscribed(maya),
    ];
    watching.claim(principal("maya", "acme", "session-1"), opening(hers));
    watching.claim(principal("maya", "acme", "session-2"), opening(alsoHers));
    const ending = { id: "session-1", credential: { kind: "cookie", value: "token-1" } };

    await watching.closeFor(ending as Session);

    // Only what the session opened is cancelled, with the session's own token.
    expect(cancelled).toEqual([{ id: hers, token: "token-1" }]);
    expect(unopened).not.toBe(hers);
  });

  it("leave a session's subscriptions to be stopped when they cannot be cancelled", async () => {
    await watching.close();
    watching = new Watching(() => Promise.reject(new Error("The gateway cannot be called.")));
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(id, maya);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await watching.closeFor({
      id: "session-1",
      credential: { kind: "cookie", value: "token-1" },
    } as Session);
    expect(stream.stopped).toBe(false);
    await watching.stop("session-1");

    expect(warned).toHaveBeenCalled();
    expect(stream.stopped).toBe(true);
    warned.mockRestore();
  });

  it("stop when its browser cancels it, and forget it", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(id, maya);
    let cancelledAtServer = 0;

    const outcome = await watching.cancel({
      id,
      context: maya,
      nowMs: Date.now(),
      onDefinition: () => {
        cancelledAtServer += 1;
        return Promise.resolve();
      },
    });

    expect(outcome).toEqual({ kind: "closed" });
    expect(stream.stopped).toBe(true);
    expect(cancelledAtServer).toBe(1);
    // Nothing is left for the session's end to stop.
    await expect(watching.stop("session-1")).resolves.toBeUndefined();
  });
});
