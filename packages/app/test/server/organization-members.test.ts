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
import { AnyMessages } from "@spine-event-engine/core";
import { EmailAddressSchema, type EmailAddress } from "@spine-event-engine/proto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type OrganizationId,
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { OrganizationMemberAddedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";

import {
  eventually,
  givenOrganization,
  givenServer,
  auditTrailOf,
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
  const members = module.ReachedOrganizationMembers.through(() => server.url, patienceMs);
  closing.push(() => members.close());
  return members;
}

function joining(
  organization: string,
  person: string,
  role = OrganizationRole.MEMBER,
  addedBy = person,
) {
  return {
    organization: create(OrganizationIdSchema, { uuid: organization }),
    person: create(PersonIdSchema, { uuid: person }),
    email: create(EmailAddressSchema, { value: `${person}@acme.example` }),
    role,
    addedBy: create(PersonIdSchema, { uuid: addedBy }),
  };
}

function organizationId(uuid: string) {
  return create(OrganizationIdSchema, { uuid });
}

describe("The organizations' members, reached through the application server, should", () => {
  it("add a person to the members of an organization, with their email address and role", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));

    await membersOf(server).add(joining("acme", "noah", OrganizationRole.ADMINISTRATOR));

    const view = await eventually(
      () => organizationView(server, organizationId("acme")),
      (organization) => organization?.member.length === 1,
    );
    expect(view?.member).toMatchObject([
      {
        person: { uuid: "noah" },
        emailAddress: { value: "noah@acme.example" },
        role: OrganizationRole.ADMINISTRATOR,
      },
    ]);
  });

  it("say which administrator added the person", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));

    await membersOf(server).add(joining("acme", "maya", OrganizationRole.MEMBER, "noah"));

    const [entry] = await eventually(
      () => auditTrailOf(server, organizationId("acme")),
      (entries) => entries.length === 1,
    );
    const added =
      entry?.event === undefined
        ? undefined
        : AnyMessages.unpack(entry.event, OrganizationMemberAddedSchema);
    expect(added).toMatchObject({ person: { uuid: "maya" }, addedBy: { uuid: "noah" } });
    expect(entry?.actor?.uuid).toBe("noah");
  });

  it("add each person to the organization they join, and to no other", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    await givenOrganization(server, organizationId("globex"));
    const members = membersOf(server);

    await members.add(joining("acme", "noah"));
    await members.add(joining("globex", "olivia"));

    const peopleOf = async (organization: OrganizationId) =>
      (
        await eventually(
          () => organizationView(server, organization),
          (view) => view?.member.length === 1,
        )
      )?.member.map((member) => member.person?.uuid);
    expect(await peopleOf(organizationId("acme"))).toEqual(["noah"]);
    expect(await peopleOf(organizationId("globex"))).toEqual(["olivia"]);
  });

  it("add a person once, however many times they are added", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const members = membersOf(server, 300);
    await members.add(joining("acme", "noah"));
    await eventually(
      () => organizationView(server, organizationId("acme")),
      (organization) => organization?.member.length === 1,
    );

    // An acceptance that failed after the person was added is given again.
    await expect(members.add(joining("acme", "noah"))).resolves.toBeUndefined();

    expect((await organizationView(server, organizationId("acme")))?.member).toHaveLength(1);
  });

  it("keep the role a member already holds, and say that it differs", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const members = membersOf(server, 300);
    await members.add(joining("acme", "noah", OrganizationRole.MEMBER));
    await eventually(
      () => organizationView(server, organizationId("acme")),
      (organization) => organization?.member.length === 1,
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await members.add(joining("acme", "noah", OrganizationRole.ADMINISTRATOR));

    expect(warned).toHaveBeenCalledWith(expect.stringContaining("in another role"));
    expect((await organizationView(server, organizationId("acme")))?.member).toMatchObject([
      { person: { uuid: "noah" }, role: OrganizationRole.MEMBER },
    ]);
  });

  it("say so, and fail, when the organization does not add the person", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const members = membersOf(server, 300);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // An organization adds nobody without an email address.
    await expect(
      members.add({ ...joining("acme", "noah"), email: undefined as unknown as EmailAddress }),
    ).rejects.toThrow("The organization did not add the person to its members.");

    expect(warned).toHaveBeenCalledWith(
      "Organization acme did not add person noah to its members.",
    );
    expect((await organizationView(server, organizationId("acme")))?.member).toHaveLength(0);
  });
});
