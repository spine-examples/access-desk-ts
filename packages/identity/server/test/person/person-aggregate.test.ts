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
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  identityBlackBox,
  loadIdentityContext,
  recordEvents,
} from "../given/identity-context.js";
import { addMember } from "../membership/given/membership.js";
import {
  account,
  awaitLinked,
  google,
  linkExternalIdentity,
  registerPerson,
} from "./given/person.js";

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
      const added = await recordEvents(scope, SignInAccountAddedSchema);

      const linked = await linkExternalIdentity(
        scope,
        account(google, "1001"),
        "noah@acme.example",
      );

      expect(linked.kind).toBe("ok");
      const event = await added.waitFor(box);
      expect(event.account).toEqual(account(google, "1001"));
      expect(event.name).toBe("1001 (name)");
      await added.cancel();
    });

    it("keep the name of a person who already has one", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await linkExternalIdentity(scope, account(google, "1001"), "noah@acme.example");
      await awaitLinked(box, scope, account(google, "1001"));
      const added = await recordEvents(scope, SignInAccountAddedSchema);

      await linkExternalIdentity(scope, account(google, "g-7"), "noah@acme.example");

      expect((await added.waitFor(box)).name).toBe("");
      await added.cancel();
    });
  });

  describe("handle 'JoinOrganization', and", () => {
    it("emit 'OrganizationJoined' for a registered person", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const joined = await recordEvents(scope, OrganizationJoinedSchema);

      await addMember(scope, "noah@acme.example", OrganizationRole.MEMBER, "acme");

      const event = await joined.waitFor(box);
      expect(event).toEqual(
        create(OrganizationJoinedSchema, {
          id: event.id,
          membership: { emailAddress: { value: "noah@acme.example" } },
          organization: { uuid: "acme" },
        }),
      );
      expect(event.id?.uuid).toMatch(/^[0-9a-f-]{36}$/);
      await joined.cancel();
    });
  });
});
