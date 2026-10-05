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
import { PersonEmailRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import { PersonEmailAlreadyRegisteredSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  expectRejection,
  identityBlackBox,
  loadIdentityContext,
  recordEvents,
} from "../given/identity-context.js";
import { account, github, google, registerPersonEmail } from "./given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("PersonEmailAggregate should", () => {
  describe("handle 'RegisterPersonEmail', and", () => {
    it("emit 'PersonEmailRegistered' with a new person for an address not registered yet", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const registered = await recordEvents(scope, PersonEmailRegisteredSchema);

      const sent = await registerPersonEmail(scope, "noah@acme.example", account(github, "1001"));

      expect(sent.kind).toBe("ok");
      const event = await registered.waitFor(box);
      expect(event).toMatchObject({
        emailAddress: { value: "noah@acme.example" },
        invoker: { issuer: github, subject: "1001" },
      });
      expect(event.person?.uuid).toMatch(/^[0-9a-f-]{36}$/);
      await registered.cancel();
    });

    it("reject with 'PersonEmailAlreadyRegistered', naming the person the address belongs to", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const registered = await recordEvents(scope, PersonEmailRegisteredSchema);
      await registerPersonEmail(scope, "noah@acme.example", account(github, "1001"));
      const first = (await registered.waitFor(box)).person;

      const rejection = await expectRejection(box, scope, PersonEmailAlreadyRegisteredSchema, () =>
        registerPersonEmail(scope, "noah@acme.example", account(google, "g-7")),
      );

      expect(rejection.person).toEqual(first);
      expect(rejection.invoker).toEqual(account(google, "g-7"));
      expect(registered.received).toHaveLength(1);
      await registered.cancel();
    });
  });
});
