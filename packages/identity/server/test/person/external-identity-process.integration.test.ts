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
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  identityBlackBox,
  loadIdentityContext,
  readAll,
} from "../given/identity-context.js";
import {
  account,
  awaitLinked,
  awaitPerson,
  github,
  google,
  linkExternalIdentity,
} from "./given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("ExternalIdentityProcessManager should", () => {
  it("register a new person for an account under an email address not registered yet", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);

    await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");

    const person = (await awaitLinked(box, scope, account(github, "1001"))).person?.uuid ?? "";
    expect(await awaitPerson(box, scope, person)).toMatchObject({
      emailAddress: { value: "noah@acme.example" },
      name: "1001 (name)",
      account: [{ provider: github, subject: "1001" }],
    });
  });

  it("add an account of another provider to the person its email address is registered for", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    await linkExternalIdentity(scope, account(github, "1001"), "noah@acme.example");
    const first = (await awaitLinked(box, scope, account(github, "1001"))).person?.uuid ?? "";

    await linkExternalIdentity(scope, account(google, "g-7"), "Noah@Acme.example");

    expect((await awaitLinked(box, scope, account(google, "g-7"))).person?.uuid).toBe(first);
    const person = await awaitPerson(box, scope, first, (view) => view.account.length === 2);
    expect(person.account.map((held) => held.provider)).toEqual([github, google]);
    const people = await readAll(scope, PersonViewSchema, "query-everybody");
    expect(people.map((view) => view.id?.uuid)).toEqual([first]);
  });
});
