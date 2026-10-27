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
import { describe, expect, it } from "vitest";
import type { AccessDesk } from "../../../src/gateway/access-desk.js";
import { RevokedTokens } from "../../../src/gateway/revoked-tokens.js";
import { routing } from "../../../src/gateway/routes/route.js";
import { signInRoutes } from "../../../src/gateway/routes/sign-in-routes.js";
import { Sessions } from "../../../src/gateway/sessions.js";

describe("Gateway sign-in routes should", () => {
  it("offer only the options route when no outside provider is configured", async () => {
    const sessions = new Sessions({
      key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      revoked: await RevokedTokens.open({ kind: "memory" }),
    });
    try {
      const signIn = signInRoutes(
        routing(["https://app.test"], sessions),
        {} as AccessDesk,
        sessions,
        {},
      );
      expect(signIn.routes.map((route) => route.path)).toEqual(["/auth/options"]);
      const [options] = signIn.routes;
      if (options === undefined) {
        throw new Error("Options route is missing.");
      }

      const response = await options.onRequest(
        new Request("https://gateway.test/auth/options", { method: "POST", body: "{}" }),
        new AbortController().signal,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ external: [] });
      expect(() => {
        signIn.close();
      }).not.toThrow();
    } finally {
      await sessions.close();
    }
  });
});
