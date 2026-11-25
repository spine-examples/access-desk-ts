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

import type { SignedSessions } from "@spine-event-engine/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routing, type Session } from "../../../src/gateway/routes/route.js";
import { givenSessions, tokenOf } from "../given/sessions.js";

let sessions: SignedSessions;
beforeEach(() => {
  sessions = givenSessions();
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
      // A session comes as a bearer token, so no cookie or CSRF header is read.
      admission: { csrfHeaderNames: [], credentialCookieNames: [], stateCookieNames: [] },
    });
  });

  it("pass a JSON body and a typed session to its handler, and prevent caching", async () => {
    const token = await tokenOf(sessions);
    const route = routing(["https://app.test"], sessions)("/sample", (body, session) =>
      Promise.resolve([200, { value: body.value, person: session?.person.id.uuid }]),
    );

    const response = await route.onRequest(
      incoming('{"value":7}', `Bearer ${token}`),
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ value: 7, person: "person-1" });
  });

  it("read the person and the organization a session stands for as typed values", async () => {
    const token = await tokenOf(sessions, {
      email: "maya@example.com",
      name: "Maya Chen",
      organization: "acme",
    });

    const session = await sessionIn(`Bearer ${token}`);

    expect(session?.person).toMatchObject({
      id: { uuid: "person-1" },
      email: { value: "maya@example.com" },
      name: "Maya Chen",
    });
    expect(session?.organization?.value).toBe("acme");
  });

  it("read a session of a person in no organization", async () => {
    const session = await sessionIn(`Bearer ${await tokenOf(sessions)}`);

    expect(session).toBeDefined();
    expect(session?.organization).toBeUndefined();
  });

  it.each([undefined, "Basic opaque", "bearer opaque", "Bearer ", "Bearer unknown"])(
    "pass no session for the authorization %s",
    async (authorization) => {
      expect(await sessionIn(authorization)).toBeUndefined();
    },
  );

  it("pass no session that names no email address, and name a person by their email when the session names nobody", async () => {
    const nameless = await tokenOf(sessions, { email: "unnamed@example.com" });
    const emailless = await tokenOf(sessions, { name: "Maya Chen" });

    expect((await sessionIn(`Bearer ${nameless}`))?.person.name).toBe("unnamed@example.com");
    expect(await sessionIn(`Bearer ${emailless}`)).toBeUndefined();
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

/**
 * Finds the session a route's handler receives for a request.
 *
 * @param authorization The `Authorization` header of the request. None when left out.
 * @returns The session, or `undefined` when the handler receives none.
 */
async function sessionIn(authorization?: string): Promise<Session | undefined> {
  let received: Session | undefined;
  const route = routing(["https://app.test"], sessions)("/sample", (_body, session) => {
    received = session;
    return Promise.resolve([200, {}]);
  });
  await route.onRequest(incoming("{}", authorization), new AbortController().signal);
  return received;
}
