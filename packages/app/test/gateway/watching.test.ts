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
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Time } from "@spine-event-engine/core/time";
import { SubscriptionSchema } from "@spine-event-engine/proto/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestStorages, type TestStorage } from "@access-desk/testing/storage";
import { typeRegistry } from "../../generated/model-registry.js";
import type { Watching } from "../../src/gateway/watching.js";
import {
  ending,
  opened,
  opening,
  principal,
  subscribed,
  subscription,
  watcher,
  watchingOver,
} from "./given/watching.js";

let storage: TestStorage;
let watching: Watching;

beforeEach(async () => {
  storage = await TestStorages.singleTenant(typeRegistry);
  watching = await watchingOver(storage);
});

afterEach(async () => {
  await watching.close();
  await storage.drop();
});

describe("What people watch through the gateway should", () => {
  it("stop when the session it was opened under ends", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(watching, id, maya);

    await watching.stop("session-1");

    await stream.ending;
    expect(stream.stopped).toBe(true);
    // Nothing opens it unless the gateway allowed it.
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

  it("stay once its session ends, so its person can open it again in another session", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const first = await opened(watching, id, maya);
    await watching.stop("session-1");
    await first.ending;

    expect(watching.claim(principal("maya", "acme", "session-2"), opening(id))).toBe(true);
    const again = await opened(watching, id, maya);
    await watching.stop("session-2");

    await again.ending;
    expect(again.stopped).toBe(true);
  });

  it("stop a subscription that was only about to open", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
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

    await beginning;
    expect(begun).toBe(false);
  });

  it("not open for a session that has ended since the gateway allowed it", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));

    await watching.stop("session-1");

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

  it("outlast a restart of the gateway, and stop when the session that opens it again ends", async () => {
    const maya = watcher("maya", "acme");
    const made = await subscription(watching, maya);
    const id = made.id?.value ?? "";
    await watching.close();
    watching = await watchingOver(storage);

    watching.claim(principal("maya", "acme", "session-1"), opening(made));
    const stream = await opened(watching, id, maya);
    await watching.stop("session-1");

    await stream.ending;
    expect(stream.stopped).toBe(true);
  });

  it("after a restart, belong to the session whose request opens it, when two sessions ask at once", async () => {
    const maya = watcher("maya", "acme");
    const made = await subscription(watching, maya);
    const id = made.id?.value ?? "";
    await watching.close();
    watching = await watchingOver(storage);

    expect(watching.claim(principal("maya", "acme", "session-1"), opening(made))).toBe(true);
    expect(watching.claim(principal("maya", "acme", "session-2"), opening(made))).toBe(false);
    const stream = await opened(watching, id, maya);

    await watching.stop("session-2");
    expect(stream.stopped).toBe(false);
    await watching.stop("session-1");
    await stream.ending;
    expect(stream.stopped).toBe(true);
  });

  it("after a restart, refuse a second opening while the first opens, and leave nothing open once the session ends", async () => {
    let tries = 0;
    const maya = watcher("maya", "acme");
    const made = await subscription(watching, maya);
    const id = made.id?.value ?? "";
    await watching.close();
    watching = await watchingOver(storage, () => {
      tries += 1;
      return Promise.reject(new Error("The gateway cannot be called."));
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    watching.claim(principal("maya", "acme", "session-1"), opening(made));
    const stream = await opened(watching, id, maya);
    const second = await watching.activate({
      id,
      context: maya,
      nowMs: Date.now(),
      signal: new AbortController().signal,
      onDefinition: () => Promise.resolve(),
    });
    await watching.closeFor(ending("session-1", "token-1"));
    await watching.stop("session-1");

    expect(second).toEqual({ kind: "denied" });
    expect(tries).toBe(3);
    await stream.ending;
    expect(stream.stopped).toBe(true);
    expect(watching.claim(principal("maya", "acme", "session-2"), opening(made))).toBe(true);
    warned.mockRestore();
  });

  it("drop an allowed opening that did not come, so the subscription can be opened later", async () => {
    let nowMs = Date.now();
    Time.setProvider({ currentTime: () => timestampFromMs(nowMs) });
    try {
      const maya = watcher("maya", "acme");
      const id = await subscribed(watching, maya);
      expect(watching.claim(principal("maya", "acme", "session-1"), opening(id))).toBe(true);
      expect(watching.claim(principal("maya", "acme", "session-1"), opening(id))).toBe(false);

      nowMs += 5_001;

      expect(watching.claim(principal("maya", "acme", "session-1"), opening(id))).toBe(true);
      const stream = await opened(watching, id, maya);
      await watching.stop("session-1");
      await stream.ending;
      expect(stream.stopped).toBe(true);
    } finally {
      Time.resetProvider();
    }
  });

  it("not open once the time to open it has passed", async () => {
    let nowMs = Date.now();
    Time.setProvider({ currentTime: () => timestampFromMs(nowMs) });
    try {
      const maya = watcher("maya", "acme");
      const id = await subscribed(watching, maya);
      watching.claim(principal("maya", "acme", "session-1"), opening(id));

      nowMs += 5_001;

      expect(
        await watching.activate({
          id,
          context: maya,
          nowMs,
          signal: new AbortController().signal,
          onDefinition: () => Promise.resolve(),
        }),
      ).toEqual({ kind: "denied" });
    } finally {
      Time.resetProvider();
    }
  });

  it("go on when another session of the same person ends", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(watching, id, maya);

    await watching.stop("session-2");

    expect(stream.stopped).toBe(false);
  });

  it("stop everything a session opened, and nothing it did not", async () => {
    const maya = watcher("maya", "acme");
    const noah = watcher("noah", "acme");
    const [first, second, others] = [
      await subscribed(watching, maya),
      await subscribed(watching, maya),
      await subscribed(watching, noah),
    ];
    watching.claim(principal("maya", "acme", "session-1"), opening(first));
    watching.claim(principal("maya", "acme", "session-1"), opening(second));
    watching.claim(principal("noah", "acme", "session-9"), opening(others));
    const streams = [
      await opened(watching, first, maya),
      await opened(watching, second, maya),
      await opened(watching, others, noah),
    ];

    await watching.stop("session-1");

    expect(streams.map((stream) => stream.stopped)).toEqual([true, true, false]);
  });

  it("belong to the session allowed to open it, and allow no other session meanwhile", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    expect(watching.claim(principal("maya", "acme", "session-1"), opening(id))).toBe(true);
    expect(watching.claim(principal("maya", "acme", "session-2"), opening(id))).toBe(false);
    const stream = await opened(watching, id, maya);

    await watching.stop("session-2");
    expect(stream.stopped).toBe(false);

    await watching.stop("session-1");
    expect(stream.stopped).toBe(true);
  });

  it("stay with the session that opened it, when another session tries to open it again", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(watching, id, maya);

    // The same person, in a second session, tries to open what is open already.
    // The gateway does not allow it, and the opening is refused at once.
    expect(watching.claim(principal("maya", "acme", "session-2"), opening(id))).toBe(false);
    const again = watching.activate({
      id,
      context: maya,
      nowMs: Date.now(),
      signal: new AbortController().signal,
      onDefinition: () => Promise.resolve(),
    });

    expect(await again).toEqual({ kind: "denied" });
    await watching.stop("session-2");
    expect(stream.stopped).toBe(false);

    await watching.stop("session-1");
    expect(stream.stopped).toBe(true);
  });

  it("not be taken over by somebody it was not made for", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(watching, id, maya);

    // Another person, and the same person in another organization, try to open it.
    expect(watching.claim(principal("noah", "acme", "session-9"), opening(id))).toBe(false);
    expect(watching.claim(principal("maya", "globex", "session-8"), opening(id))).toBe(false);
    await watching.stop("session-9");
    await watching.stop("session-8");

    expect(stream.stopped).toBe(false);
    await watching.stop("session-1");
    expect(stream.stopped).toBe(true);
  });

  it("be cancelled in the name of a session about to end, as its browser would", async () => {
    const cancelled: { readonly id: string | undefined; readonly token: string }[] = [];
    await watching.close();
    watching = await watchingOver(storage, (subscription, token) => {
      cancelled.push({ id: fromBinary(SubscriptionSchema, subscription.bytes).id?.value, token });
      return Promise.resolve();
    });
    const maya = watcher("maya", "acme");
    const [hers, alsoHers, unopened] = [
      await subscribed(watching, maya),
      await subscribed(watching, maya),
      await subscribed(watching, maya),
    ];
    watching.claim(principal("maya", "acme", "session-1"), opening(hers));
    await opened(watching, hers, maya);
    watching.claim(principal("maya", "acme", "session-2"), opening(alsoHers));
    await opened(watching, alsoHers, maya);

    await watching.closeFor(ending("session-1", "token-1"));

    // Only what the session opened is cancelled, with the session's own token.
    expect(cancelled).toEqual([{ id: hers, token: "token-1" }]);
    expect(unopened).not.toBe(hers);
  });

  it("be cancelled on a later try, when the first one fails", async () => {
    let tries = 0;
    await watching.close();
    watching = await watchingOver(storage, () => {
      tries += 1;
      return tries < 3 ? Promise.reject(new Error("Not this time.")) : Promise.resolve();
    });
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    await opened(watching, id, maya);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await watching.closeFor(ending("session-1", "token-1"));

    expect(tries).toBe(3);
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it("leave a session's subscriptions to be stopped when they cannot be cancelled", async () => {
    let tries = 0;
    await watching.close();
    watching = await watchingOver(storage, () => {
      tries += 1;
      return Promise.reject(new Error("The gateway cannot be called."));
    });
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(watching, id, maya);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await watching.closeFor(ending("session-1", "token-1"));
    expect(stream.stopped).toBe(false);
    await watching.stop("session-1");

    // The cancel was tried three times before it was given up.
    expect(tries).toBe(3);
    expect(warned).toHaveBeenCalled();
    expect(stream.stopped).toBe(true);
    warned.mockRestore();
  });

  it("stop when its browser cancels it, and forget it", async () => {
    const maya = watcher("maya", "acme");
    const id = await subscribed(watching, maya);
    watching.claim(principal("maya", "acme", "session-1"), opening(id));
    const stream = await opened(watching, id, maya);
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
