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

import { describe, expect, it } from "vitest";
import { TestStorages } from "@access-desk/testing/storage";
import { typeRegistry } from "../../../generated/model-registry.js";
import type { AccessDesk } from "../../../src/gateway/access-desk.js";
import { routing } from "../../../src/gateway/routes/route.js";
import { signInRoutes } from "../../../src/gateway/routes/sign-in-routes.js";
import { givenSessions } from "../given/sessions.js";

describe("Gateway sign-in routes should", () => {
  it("offer only the options route when no outside provider is configured", async () => {
    const storage = await TestStorages.singleTenant(typeRegistry);
    const factory = await storage.open();
    const sessions = givenSessions();
    try {
      const signIn = await signInRoutes(
        routing(["https://app.test"], sessions),
        {} as AccessDesk,
        sessions,
        {},
        factory,
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
      await expect(signIn.close()).resolves.toBeUndefined();
    } finally {
      await sessions.close();
      await storage.drop();
    }
  });
});
