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

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  actor,
  closeIdentityBlackBoxes,
  identityBlackBox,
  loadIdentityContext,
} from "../given/identity-context.js";
import { account, awaitLinked, github, linkExternalIdentity } from "./given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("ExternalIdentityViewProjection should", () => {
  describe("react on 'ExternalIdentityLinked', and", () => {
    it("list the account with the person it belongs to", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");

      const linked = await awaitLinked(box, scope, account(github, "1001"));
      expect(linked.person?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
