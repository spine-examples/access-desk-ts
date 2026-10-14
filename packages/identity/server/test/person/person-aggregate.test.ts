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

import { create } from "@bufbuild/protobuf";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  OrganizationJoinedSchema,
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import {
  AddSignInAccountSchema,
  JoinOrganizationSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/commands_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  identityBlackBox,
  loadIdentityContext,
  recordEvents,
} from "../given/identity-context.js";
import { account, addSignInAccount, awaitPerson, google, registerPerson } from "./given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("PersonAggregate should", () => {
  describe("handle 'RegisterPerson', and", () => {
    it("emit 'PersonRegistered' with the email address alone", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const registered = await recordEvents(scope, PersonRegisteredSchema);

      expect((await registerPerson(scope, "noah", "noah@acme.example")).kind).toBe("ok");

      expect(await registered.waitFor(box)).toEqual(
        create(PersonRegisteredSchema, {
          id: { uuid: "noah" },
          emailAddress: { value: "noah@acme.example" },
        }),
      );
      await registered.cancel();
    });
  });

  describe("handle 'AddSignInAccount', and", () => {
    it("name the person after the first account added", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await registerPerson(scope, "noah", "noah@acme.example");
      await awaitPerson(box, scope, "noah");
      const added = await recordEvents(scope, SignInAccountAddedSchema);

      expect((await addSignInAccount(scope, "noah", account(google, "1001"))).kind).toBe("ok");

      expect(await added.waitFor(box)).toEqual(
        create(SignInAccountAddedSchema, {
          id: { uuid: "noah" },
          account: account(google, "1001"),
          name: "noah (name)",
        }),
      );
      await added.cancel();
    });

    it("keep the name of a person who already has one", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await registerPerson(scope, "noah", "noah@acme.example");
      await addSignInAccount(scope, "noah", account(google, "1001"));
      await awaitPerson(box, scope, "noah", (view) => view.account.length === 1);
      const added = await recordEvents(scope, SignInAccountAddedSchema);

      await scope.post(
        AddSignInAccountSchema,
        create(AddSignInAccountSchema, {
          id: { uuid: "noah" },
          account: account(google, "g-7"),
          name: "Somebody else",
        }),
      );

      expect((await added.waitFor(box)).name).toBe("");
      await added.cancel();
    });
  });

  describe("handle 'JoinOrganization', and", () => {
    it("emit 'OrganizationJoined' for a registered person", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await registerPerson(scope, "noah", "noah@acme.example");
      await awaitPerson(box, scope, "noah");
      const joined = await recordEvents(scope, OrganizationJoinedSchema);

      await scope.post(
        JoinOrganizationSchema,
        create(JoinOrganizationSchema, {
          id: { uuid: "noah" },
          membership: { emailAddress: { value: "noah@acme.example" } },
          organization: { uuid: "acme" },
        }),
      );

      expect(await joined.waitFor(box)).toEqual(
        create(OrganizationJoinedSchema, {
          id: { uuid: "noah" },
          membership: { emailAddress: { value: "noah@acme.example" } },
          organization: { uuid: "acme" },
        }),
      );
      await joined.cancel();
    });
  });
});
