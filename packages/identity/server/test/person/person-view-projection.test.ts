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
import {
  account,
  awaitLinked,
  awaitPerson,
  google,
  linkExternalIdentity,
  registerPerson,
} from "./given/person.js";
import { addMember, awaitMembership } from "../membership/given/membership.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("PersonViewProjection should", () => {
  describe("react on 'PersonRegistered', and", () => {
    it("list the person with their email address, and no name or account yet", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await registerPerson(scope, "noah", "noah@acme.example");

      expect(await awaitPerson(box, scope, "noah")).toMatchObject({
        emailAddress: { value: "noah@acme.example" },
        name: "",
        account: [],
      });
    });
  });

  describe("react on 'SignInAccountAdded', and", () => {
    it("show every account the person signs in with, and the name the first one gave", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await linkExternalIdentity(scope, account(google, "1001"), "noah@acme.example");
      const person = (await awaitLinked(box, scope, account(google, "1001"))).person?.uuid ?? "";
      await awaitPerson(box, scope, person, (view) => view.account.length === 1);

      await linkExternalIdentity(scope, account(google, "g-7"), "noah@acme.example");

      const shown = await awaitPerson(box, scope, person, (view) => view.account.length === 2);
      expect(shown.account.map((held) => held.subject)).toEqual(["1001", "g-7"]);
      expect(shown.name).toBe("1001 (name)");
    });
  });

  describe("react on 'OrganizationJoined', and", () => {
    it("show the organization the person was added to", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await addMember(scope, "noah@acme.example", OrganizationRole.MEMBER, "acme");

      const person = (await awaitMembership(box, scope, "noah@acme.example")).person?.uuid ?? "";
      const view = await awaitPerson(
        box,
        scope,
        person,
        (shown) => shown.organization !== undefined,
      );
      expect(view.organization?.uuid).toBe("acme");
    });
  });
});
