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
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalIdentityIdSchema,
  MembershipIdSchema,
  OrganizationIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { LinkExternalIdentitySchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_commands_pb.js";
import { ExternalIdentityViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import {
  IdentityProvider,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { AddOrganizationMemberSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";

import {
  eventually,
  give,
  givenOrganization,
  givenServer,
  organizationView,
  type Hosted,
} from "./given/hosted.js";

let server: Hosted | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** The email address of the person the tests add. */
const NOAH = create(EmailAddressSchema, { value: "noah@acme.example" });

/** The membership of that address. */
const NOAHS_MEMBERSHIP = create(MembershipIdSchema, { emailAddress: NOAH });

/** The Google account Noah signs in with. */
const NOAHS_ACCOUNT = create(ExternalIdentityIdSchema, {
  provider: IdentityProvider.GOOGLE,
  subject: "1001",
});

/**
 * Has Noah sign in, as the gateway does, and waits until his account is linked.
 *
 * @param hosted The running application server.
 * @returns The identifier of the person Noah is.
 */
async function givenNoahSignedIn(hosted: Hosted): Promise<string> {
  await give(
    hosted.identity,
    LinkExternalIdentitySchema,
    create(LinkExternalIdentitySchema, {
      id: NOAHS_ACCOUNT,
      emailAddress: NOAH,
      name: "Noah Reyes",
    }),
  );
  const linked = await eventually(
    () => hosted.identity.stand().read(ExternalIdentityViewSchema, NOAHS_ACCOUNT),
    (view) => view?.person !== undefined,
  );
  return linked?.person?.uuid ?? "";
}

/**
 * Has Identity add Noah to Acme.
 *
 * @param hosted The running application server.
 * @param role The role Noah is to hold.
 */
async function givenNoahAdded(hosted: Hosted, role: OrganizationRole): Promise<void> {
  await give(
    hosted.identity,
    AddMemberSchema,
    create(AddMemberSchema, { id: NOAHS_MEMBERSHIP, organization: { uuid: "acme" }, role }),
  );
}

/**
 * Waits until Noah's membership names the person he is.
 *
 * @param hosted The running application server.
 * @returns The membership.
 */
function noahsMembership(hosted: Hosted) {
  return eventually(
    () => hosted.identity.stand().read(MembershipViewSchema, NOAHS_MEMBERSHIP),
    (view) => view?.person !== undefined,
  );
}

describe("The assembled application should", () => {
  it("hold the Identity context, which has no tenants, and the Resources context, which has", async () => {
    server = await givenServer();

    expect(server.identity.name.value).toBe("Identity");
    expect(server.identity.isMultitenant).toBe(false);
    expect(server.resources.name.value).toBe("Resources");
    expect(server.resources.isMultitenant).toBe(true);
  });

  it("list a person among the organization's members as soon as they are added", async () => {
    const hosted = await givenServer();
    server = hosted;
    const acme = create(OrganizationIdSchema, { uuid: "acme" });
    await givenOrganization(hosted, acme);

    await givenNoahAdded(hosted, OrganizationRole.ADMINISTRATOR);

    const membership = await noahsMembership(hosted);
    const organization = await eventually(
      () => organizationView(hosted, acme),
      (view) => view?.member.length === 1,
    );
    expect(organization?.member).toMatchObject([
      {
        person: membership?.person,
        emailAddress: { value: "noah@acme.example" },
        role: OrganizationRole.ADMINISTRATOR,
      },
    ]);
  });

  it("let Noah sign in as the person he was added as", async () => {
    const hosted = await givenServer();
    server = hosted;
    const acme = create(OrganizationIdSchema, { uuid: "acme" });
    await givenOrganization(hosted, acme);
    await givenNoahAdded(hosted, OrganizationRole.MEMBER);
    await noahsMembership(hosted);

    const person = await givenNoahSignedIn(hosted);

    const organization = await organizationView(hosted, acme);
    expect(organization?.member.map((member) => member.person?.uuid)).toEqual([person]);
  });

  it("add a person the organization already lists", async () => {
    const hosted = await givenServer();
    server = hosted;
    const acme = create(OrganizationIdSchema, { uuid: "acme" });
    await givenOrganization(hosted, acme);
    const person = await givenNoahSignedIn(hosted);
    // An earlier adding got as far as the organization, and no further.
    await give(
      hosted.resources,
      AddOrganizationMemberSchema,
      create(AddOrganizationMemberSchema, {
        organizationId: acme,
        person: { uuid: person },
        emailAddress: NOAH,
        role: OrganizationRole.MEMBER,
      }),
      { organization: acme },
    );
    await eventually(
      () => organizationView(hosted, acme),
      (view) => view?.member.length === 1,
    );

    await givenNoahAdded(hosted, OrganizationRole.MEMBER);

    expect((await noahsMembership(hosted))?.person?.uuid).toBe(person);
    expect((await organizationView(hosted, acme))?.member).toHaveLength(1);
  });
});
