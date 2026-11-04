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
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  identityBlackBox,
  loadIdentityContext,
  organizations,
} from "../given/identity-context.js";
import {
  account,
  awaitLinked,
  awaitPerson,
  google,
  linkExternalIdentity,
} from "../person/given/person.js";
import { addMember, awaitMembership, organizationId } from "./given/membership.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("MembershipProcessManager should", () => {
  it("register a new person for an address nobody signed in under, and have the organization list them", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);

    expect((await addMember(scope, "noah@acme.example", OrganizationRole.ADMINISTRATOR)).kind).toBe(
      "ok",
    );

    const person = (await awaitMembership(box, scope, "noah@acme.example")).person?.uuid ?? "";
    expect(organizations.added).toEqual([
      {
        organization: organizationId,
        person,
        email: "noah@acme.example",
        role: OrganizationRole.ADMINISTRATOR,
        addedBy: person,
      },
    ]);
    // The person exists before they sign in, with no name and no account yet.
    expect(
      await awaitPerson(box, scope, person, (view) => view.organization !== undefined),
    ).toMatchObject({
      emailAddress: { value: "noah@acme.example" },
      name: "",
      account: [],
      organization: { uuid: organizationId },
    });
  });

  it("pass the organization which administrator added the person", async () => {
    const box = await identityBlackBox();
    const administrator = box.onBehalfOf("person-olivia");

    expect(
      (
        await addMember(
          administrator,
          "noah@acme.example",
          OrganizationRole.MEMBER,
          organizationId,
          "person-olivia",
        )
      ).kind,
    ).toBe("ok");

    await awaitMembership(box, administrator, "noah@acme.example");
    expect(organizations.added.map((member) => member.addedBy)).toEqual(["person-olivia"]);
  });

  it("have the organization list the person who already signed in under the address", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    await linkExternalIdentity(scope, account(google, "1001"), "noah@acme.example");
    const person = (await awaitLinked(box, scope, account(google, "1001"))).person?.uuid;

    expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");

    expect((await awaitMembership(box, scope, "noah@acme.example")).person?.uuid).toBe(person);
    expect(organizations.added.map((member) => member.person)).toEqual([person]);
  });

  it("finish an adding the organization refused, when the address is added to it again", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    organizations.refusing = true;
    expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");
    await box.eventually(
      () => Promise.resolve(organizations.refused),
      (refused) => refused > 0,
    );
    expect(organizations.added).toEqual([]);

    organizations.refusing = false;
    expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");

    await awaitMembership(box, scope, "noah@acme.example");
    expect(organizations.added.map((member) => member.email)).toEqual(["noah@acme.example"]);
  });

  it("keep an address that belongs to an organization out of another", async () => {
    const box = await identityBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");
    await awaitMembership(box, scope, "noah@acme.example");

    await addMember(scope, "noah@acme.example", OrganizationRole.MEMBER, "globex");

    expect((await awaitMembership(box, scope, "noah@acme.example")).organization?.uuid).toBe(
      organizationId,
    );
    expect(organizations.added.map((member) => member.organization)).toEqual([organizationId]);
  });
});
