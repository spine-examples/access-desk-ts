/*
 * Copyright 2026, TeamDev. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Redistribution and use in source and/or binary forms, with or without
 * modification, must retain the above copyright notice and the following
 * disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { TopicIdSchema, TopicSchema, TargetSchema } from "@spine-event-engine/proto/client";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { expect } from "vitest";

import { testActorContext } from "./access-context.js";

/**
 * A live recording of one event type, delivered to a client subscription.
 *
 * A rejection is an event too. A rejection a command handler declares with
 * `@Throws` is a first-class produced signal, so it is subscribable on its own
 * without a read-side consumer, just like any domain event.
 */
export interface EventRecorder<Event> {
  /** Every event received so far, in delivery order. */
  readonly received: readonly Event[];
  /** Waits until an event matching the predicate arrives, then returns it. */
  waitFor(box: BlackBox, accept?: (event: Event) => boolean): Promise<Event>;
  /** Cancels the underlying subscription. */
  cancel(): Promise<void>;
}

/**
 * Subscribes to one event type and records each delivery.
 *
 * Await this (it activates the subscription) before triggering the event, so the
 * live subscription is in place when the event is published.
 *
 * @param scope The actor scope that owns the subscription.
 * @param schema The event (or rejection) schema to observe.
 * @returns A recorder of the delivered events.
 */
export async function recordEvents<Schema extends GenMessage<Message>>(
  scope: BlackBoxScope,
  schema: Schema,
): Promise<EventRecorder<MessageShape<Schema>>> {
  const topic = create(TopicSchema, {
    id: create(TopicIdSchema, { value: `topic-${TypeUrls.derive(schema)}` }),
    target: create(TargetSchema, {
      type: TypeUrls.derive(schema),
      criterion: { case: "includeAll", value: true },
    }),
    context: testActorContext(),
  });
  const subscription = await scope.createSubscription(topic, { kind: "event" });
  const received: MessageShape<Schema>[] = [];
  void (async () => {
    for await (const delivery of subscription.updates) {
      if (delivery.kind !== "update" || delivery.update.update.case !== "eventUpdates") {
        continue;
      }
      for (const event of delivery.update.update.value.event) {
        const message =
          event.message === undefined ? undefined : AnyMessages.unpack(event.message, schema);
        if (message !== undefined) {
          received.push(message);
        }
      }
    }
  })();
  await subscription.activate();

  return {
    received,
    async waitFor(box, accept = () => true) {
      const all = await box.eventually(
        () => received,
        (events) => events.some(accept),
      );
      const found = all.find(accept);
      if (found === undefined) {
        throw new Error(`No ${schema.typeName} event was recorded.`);
      }
      return found;
    },
    cancel: () => subscription.cancel(),
  };
}

/**
 * Posts a command expected to be rejected, and returns the rejection it produced.
 *
 * Subscribes to the rejection type first (a `@Throws`-declared rejection is a
 * subscribable produced signal), then runs `act`, then waits for the rejection.
 * The command is acknowledged as `ok`; the refusal is the published rejection,
 * so this is how a rejection is asserted rather than through the post outcome.
 *
 * @param box The BlackBox whose eventual reads back the wait.
 * @param scope The actor scope that owns the subscription and the command.
 * @param schema The expected rejection schema.
 * @param act Triggers the command under test.
 * @returns The recorded rejection message.
 */
export async function expectRejection<Schema extends GenMessage<Message>>(
  box: BlackBox,
  scope: BlackBoxScope,
  schema: Schema,
  act: () => Promise<unknown>,
): Promise<MessageShape<Schema>> {
  const recorder = await recordEvents(scope, schema);
  try {
    const outcome = await act();
    expect(outcome).toMatchObject({ kind: "ok" });
    return await recorder.waitFor(box);
  } finally {
    await recorder.cancel();
  }
}
