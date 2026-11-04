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
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  identityBlackBox,
  loadIdentityContext,
  readAll,
  storageOf,
} from "./given/identity-context.js";
import { addMember, awaitMembership } from "./membership/given/membership.js";
import {
  account,
  awaitLinked,
  awaitPerson,
  google,
  linkExternalIdentity,
} from "./person/given/person.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("IdentityContext should", () => {
  it("know every person, account, and membership again once it starts over its storage", async () => {
    const before = await identityBlackBox();
    const scope = before.onBehalfOf(actor);
    await linkExternalIdentity(scope, account(google, "1001"), "noah@acme.example");
    const noah = (await awaitLinked(before, scope, account(google, "1001"))).person?.uuid ?? "";
    expect((await addMember(scope, "olivia@acme.example")).kind).toBe("ok");
    const olivia = (await awaitMembership(before, scope, "olivia@acme.example")).person?.uuid;
    await awaitPerson(before, scope, noah);
    await before.close();

    const after = await identityBlackBox(storageOf(before));
    const again = after.onBehalfOf(actor);

    const people = await readAll(again, PersonViewSchema, "query-people-after-restart");
    expect(people.map((person) => person.emailAddress?.value).sort()).toEqual([
      "noah@acme.example",
      "olivia@acme.example",
    ]);
    const memberships = await readAll(again, MembershipViewSchema, "query-members-after-restart");
    expect(memberships).toMatchObject([
      { id: { emailAddress: { value: "olivia@acme.example" } }, person: { uuid: olivia } },
    ]);
    // A second account under the same address joins the person kept from before.
    await linkExternalIdentity(again, account(google, "g-7"), "noah@acme.example");
    expect((await awaitLinked(after, again, account(google, "g-7"))).person?.uuid).toBe(noah);
  });
});
