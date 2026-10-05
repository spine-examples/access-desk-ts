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
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import {
  ExternalIdentityLinkedSchema,
  ExternalIdentityLinkingStartedSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_events_pb.js";
import { ExternalIdentityAlreadyKnownSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_rejections_pb.js";
import { PersonEmailRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  expectRejection,
  identityBlackBox,
  loadIdentityContext,
  recordEvents,
} from "../given/identity-context.js";
import { account, awaitLinked, github, google, linkExternalIdentity } from "./given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("ExternalIdentityProcessManager should", () => {
  describe("handle 'LinkExternalIdentity', and", () => {
    it("emit 'ExternalIdentityLinkingStarted' with the email address in lower case", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const started = await recordEvents(scope, ExternalIdentityLinkingStartedSchema);

      const sent = await linkExternalIdentity(
        scope,
        account(github, "1001"),
        " Noah@Acme.example ",
      );

      expect(sent.kind).toBe("ok");
      expect(await started.waitFor(box)).toEqual(
        create(ExternalIdentityLinkingStartedSchema, {
          id: account(github, "1001"),
          emailAddress: { value: "noah@acme.example" },
        }),
      );
      await started.cancel();
    });

    it("reject an account that is already linked with 'ExternalIdentityAlreadyKnown'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");
      await awaitLinked(box, scope, account(github, "1001"));

      const rejection = await expectRejection(box, scope, ExternalIdentityAlreadyKnownSchema, () =>
        linkExternalIdentity(scope, account(github, "1001"), "other@acme.example"),
      );

      expect(rejection.id).toEqual(account(github, "1001"));
    });
  });

  describe("react on 'ExternalIdentityLinkingStarted', and", () => {
    it("register the account's email address, naming the account as the invoker", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const registered = await recordEvents(scope, PersonEmailRegisteredSchema);

      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");

      expect(await registered.waitFor(box)).toMatchObject({
        emailAddress: { value: "noah@acme.example" },
        invoker: { provider: github, subject: "1001" },
      });
      await registered.cancel();
    });
  });

  describe("react on 'PersonEmailRegistered', and", () => {
    it("register the new person with the email address, the provider's name, and the account", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const emailRegistered = await recordEvents(scope, PersonEmailRegisteredSchema);
      const personRegistered = await recordEvents(scope, PersonRegisteredSchema);

      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");

      const person = (await emailRegistered.waitFor(box)).person;
      expect(await personRegistered.waitFor(box)).toEqual(
        create(PersonRegisteredSchema, {
          id: person,
          emailAddress: { value: "noah@acme.example" },
          name: "1001 (name)",
          account: account(github, "1001"),
        }),
      );
      await Promise.all([emailRegistered.cancel(), personRegistered.cancel()]);
    });
  });

  describe("react on 'PersonEmailAlreadyRegistered', and", () => {
    it("add the account to the person the email address is registered for", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");
      const first = (await awaitLinked(box, scope, account(github, "1001"))).person;
      const added = await recordEvents(scope, SignInAccountAddedSchema);
      const registered = await recordEvents(scope, PersonRegisteredSchema);

      await linkExternalIdentity(scope, account(google, "g-7"), "noah@acme.example");

      expect(await added.waitFor(box)).toEqual(
        create(SignInAccountAddedSchema, { id: first, account: account(google, "g-7") }),
      );
      expect(registered.received).toEqual([]);
      await Promise.all([added.cancel(), registered.cancel()]);
    });
  });

  describe("react on 'PersonRegistered', and", () => {
    it("emit 'ExternalIdentityLinked' with the person registered for the account", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const registered = await recordEvents(scope, PersonRegisteredSchema);
      const linked = await recordEvents(scope, ExternalIdentityLinkedSchema);

      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");

      const person = (await registered.waitFor(box)).id;
      expect(await linked.waitFor(box)).toEqual(
        create(ExternalIdentityLinkedSchema, { id: account(github, "1001"), person }),
      );
      await Promise.all([registered.cancel(), linked.cancel()]);
    });
  });

  describe("react on 'SignInAccountAdded', and", () => {
    it("emit 'ExternalIdentityLinked' with the person the account was added to", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");
      const first = (await awaitLinked(box, scope, account(github, "1001"))).person;
      const linked = await recordEvents(scope, ExternalIdentityLinkedSchema);

      await linkExternalIdentity(scope, account(google, "g-7"), "noah@acme.example");

      expect(await linked.waitFor(box, (event) => event.id?.subject === "g-7")).toEqual(
        create(ExternalIdentityLinkedSchema, { id: account(google, "g-7"), person: first }),
      );
      await linked.cancel();
    });
  });
});
