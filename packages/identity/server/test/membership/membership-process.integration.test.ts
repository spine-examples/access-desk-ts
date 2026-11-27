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
} from "../person/given/person.js";
import { awaitMembership, claimMember, organizationId } from "./given/membership.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("MembershipProcessManager should", () => {
  it("register a new person for an address nobody signed in under, and have them join the organization", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);

    expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");

    const membership = await awaitMembership(box, scope, "noah@acme.example");
    expect(membership.organization?.value).toBe(organizationId);
    const person = membership.person?.uuid ?? "";
    // The person exists before they sign in, with no name and no account yet.
    expect(
      await awaitPerson(box, scope, person, (view) => view.organization !== undefined),
    ).toMatchObject({
      emailAddress: { value: "noah@acme.example" },
      name: "",
      account: [],
      organization: { value: organizationId },
    });
  });

  it("name the person who already signed in under the address", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    await linkExternalIdentity(scope, account(google, "1001"), "noah@acme.example");
    const person = (await awaitLinked(box, scope, account(google, "1001"))).person?.uuid;

    expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");

    expect((await awaitMembership(box, scope, "noah@acme.example")).person?.uuid).toBe(person);
    expect(
      (await awaitPerson(box, scope, person ?? "", (view) => view.organization !== undefined))
        .organization?.value,
    ).toBe(organizationId);
  });

  it("keep an address that belongs to an organization out of another", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");
    await awaitMembership(box, scope, "noah@acme.example");

    await claimMember(scope, "noah@acme.example", "globex");

    expect((await awaitMembership(box, scope, "noah@acme.example")).organization?.value).toBe(
      organizationId,
    );
  });
});
