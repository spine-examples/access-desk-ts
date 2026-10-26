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

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EndedSessions } from "../../../src/gateway/ended-sessions.js";
import { routing } from "../../../src/gateway/routes/route.js";
import { Sessions } from "../../../src/gateway/sessions.js";

let sessions: Sessions;
beforeEach(async () => {
  sessions = new Sessions({
    key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
    ended: await EndedSessions.open({ kind: "memory" }),
  });
});
afterEach(async () => {
  await sessions.close();
});

function incoming(body: string, authorization?: string): Request {
  return new Request("https://gateway.test/sample", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body,
  });
}

describe("Gateway route construction should", () => {
  it("configure a bounded JSON POST route with the allowed origins", () => {
    const route = routing(["https://app.test"], sessions)("/sample", () =>
      Promise.resolve([200, {}]),
    );

    expect(route).toMatchObject({
      method: "POST",
      path: "/sample",
      origins: ["https://app.test"],
      maxRequestBytes: 16_384,
      timeoutMs: 20_000,
    });
  });

  it("pass a JSON body and a typed session to its handler, and prevent caching", async () => {
    const created = await sessions.create({
      id: "p-1",
      attributes: { email: "maya@example.com", name: "Maya" },
    });
    expect(created.kind).toBe("issued");
    if (created.kind !== "issued") {
      return;
    }
    const route = routing(["https://app.test"], sessions)("/sample", (body, session) =>
      Promise.resolve([200, { value: body.value, person: session?.person.id.uuid }]),
    );

    const response = await route.onRequest(
      incoming('{"value":7}', `Bearer ${created.credential.value}`),
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ value: 7, person: "p-1" });
  });

  it.each(["", "not-json", "null", "true", "7", '"word"', "[]"])(
    "refuse a body that is not a JSON object: %s",
    async (body) => {
      const route = routing(["https://app.test"], sessions)("/sample", () =>
        Promise.resolve([200, {}]),
      );

      const response = await route.onRequest(incoming(body), new AbortController().signal);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "refused" });
    },
  );
});
