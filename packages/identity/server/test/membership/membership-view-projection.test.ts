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
import { awaitMembership, claimMember, organizationId } from "./given/membership.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("MembershipViewProjection should", () => {
  describe("react on 'MemberClaimed', and", () => {
    it("list the address with its organization and person", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");

      const membership = await awaitMembership(box, scope, "noah@acme.example");
      expect(membership).toMatchObject({ organization: { value: organizationId } });
      expect(membership.person?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
