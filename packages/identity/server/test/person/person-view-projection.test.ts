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
  addSignInAccount,
  awaitPerson,
  github,
  google,
  registerPerson,
} from "./given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("PersonViewProjection should", () => {
  describe("react on 'PersonRegistered', and", () => {
    it("list the person with their email address and the account they signed in with", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);

      await registerPerson(scope, "noah", "noah@acme.example", account(github, "1001"));

      expect(await awaitPerson(box, scope, "noah")).toMatchObject({
        emailAddress: { value: "noah@acme.example" },
        name: "noah (name)",
        account: [{ provider: github, subject: "1001" }],
      });
    });
  });

  describe("react on 'SignInAccountAdded', and", () => {
    it("show every account the person signs in with", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await registerPerson(scope, "noah", "noah@acme.example", account(github, "1001"));
      await awaitPerson(box, scope, "noah");

      await addSignInAccount(scope, "noah", account(google, "g-7"));

      const person = await awaitPerson(box, scope, "noah", (view) => view.account.length === 2);
      expect(person.account.map((held) => held.provider)).toEqual([github, google]);
    });
  });
});
