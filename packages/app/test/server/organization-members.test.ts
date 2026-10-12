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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import {
  eventually,
  givenOrganization,
  givenServer,
  organizationView,
  type Hosted,
} from "./given/hosted.js";

type MembersModule = typeof import("../../dist/src/server/organization-members.js");
let module: MembersModule;
beforeAll(async () => {
  module = await import("../../dist/src/server/organization-members.js");
});

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closing.reverse()) {
    await close();
  }
  closing = [];
});

async function hosted(): Promise<Hosted> {
  const server = await givenServer();
  closing.push(() => server.stop());
  return server;
}

function membersOf(server: Hosted, patienceMs?: number) {
  const members = module.organizationMembersThrough(() => server.url, patienceMs);
  closing.push(() => members.close());
  return members;
}

function joining(organization: string, person: string, role = OrganizationRole.MEMBER) {
  return {
    organization: create(OrganizationIdSchema, { uuid: organization }),
    person: create(PersonIdSchema, { uuid: person }),
    name: `${person} (name)`,
    role,
  };
}

describe("The organizations' members, reached through the application server, should", () => {
  it("add a person to the members of an organization, with their name and role", async () => {
    const server = await hosted();
    await givenOrganization(server, "acme");

    await membersOf(server).add(joining("acme", "noah", OrganizationRole.ADMINISTRATOR));

    const view = await eventually(
      () => organizationView(server, "acme"),
      (organization) => organization?.member.length === 1,
    );
    expect(view?.member).toMatchObject([
      { person: { uuid: "noah" }, name: "noah (name)", role: OrganizationRole.ADMINISTRATOR },
    ]);
  });

  it("add each person to the organization they join, and to no other", async () => {
    const server = await hosted();
    await givenOrganization(server, "acme");
    await givenOrganization(server, "globex");
    const members = membersOf(server);

    await members.add(joining("acme", "noah"));
    await members.add(joining("globex", "olivia"));

    const peopleOf = async (organization: string) =>
      (
        await eventually(
          () => organizationView(server, organization),
          (view) => view?.member.length === 1,
        )
      )?.member.map((member) => member.person?.uuid);
    expect(await peopleOf("acme")).toEqual(["noah"]);
    expect(await peopleOf("globex")).toEqual(["olivia"]);
  });

  it("say so, and fail, when the organization does not add the person", async () => {
    const server = await hosted();
    await givenOrganization(server, "acme");
    const members = membersOf(server, 300);
    await members.add(joining("acme", "noah"));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // A person is added to an organization once, so a second time adds nobody.
    await expect(members.add(joining("acme", "noah"))).rejects.toThrow(
      "The organization did not add the person to its members.",
    );

    expect(warned).toHaveBeenCalledWith(
      "Organization acme did not add person noah to its members.",
    );
    expect((await organizationView(server, "acme"))?.member).toHaveLength(1);
  });
});
