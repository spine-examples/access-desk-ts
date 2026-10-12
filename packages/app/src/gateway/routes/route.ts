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

import type { BrowserAuthRoute } from "@spine-event-engine/server/browser";
import type { Session, Sessions } from "../sessions.js";

/** A status and the JSON that goes with it. */
export type Answer = readonly [status: number, body: object];

/** The answer to a request the person may not make. */
export const REFUSED: Answer = [403, { error: "refused" }];
/** The answer to a request that needs a session and carries none. */
export const UNAUTHENTICATED: Answer = [401, { error: "not signed in" }];
/** The answer when the gateway cannot do what was asked just now. */
export const UNAVAILABLE: Answer = [503, { error: "try again" }];

/**
 * Makes one address of the gateway that takes JSON and answers JSON.
 *
 * @param path The address.
 * @param answer Answers a request, given what it sent and the session it carries.
 */
export type Route = (
  path: string,
  answer: (body: Record<string, unknown>, session: Session | undefined) => Promise<Answer>,
) => BrowserAuthRoute;

/**
 * Tells how the gateway's own addresses are made.
 *
 * Every address works the same way:
 *
 * - It takes `POST` with a JSON object as the body, `{}` when there is
 *   nothing to send, of at most 16 KiB.
 * - It answers only the pages allowed to call the gateway, by their `Origin`.
 * - Where it needs a session, the session comes as `Authorization: Bearer
 *   <token>`.
 * - It answers JSON, which is never to be cached. A refusal is `403` with
 *   `{ error: "refused" }`, a missing session `401` with `{ error: "not
 *   signed in" }`, and a passing failure `503` with `{ error: "try again" }`.
 *   A body that is not a JSON object is refused.
 *
 * @param origins The addresses of the pages that may call the gateway.
 * @param sessions The sessions of the people who have signed in.
 */
export function routing(origins: string[], sessions: Sessions): Route {
  return (path, answer) => ({
    method: "POST",
    path,
    origins,
    maxRequestBytes: 16_384,
    timeoutMs: 20_000,
    onRequest: async (request) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
      const [status, value] =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? await answer(body as Record<string, unknown>, await sessions.of(request))
          : REFUSED;
      return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  });
}
