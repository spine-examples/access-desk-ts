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
import { afterEach, describe, expect, it } from "vitest";
import { InvitationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AcceptInvitationSchema,
  InviteMemberSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/commands_pb.js";
import { InvitationViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

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

function invitationOf(organization: string, email: string) {
  return create(InvitationIdSchema, {
    organization: { uuid: organization },
    invitee: { value: email },
  });
}

describe("The assembled application should", () => {
  it("hold the Identity context, which has no tenants, and the Resources context, which has", async () => {
    server = await givenServer();

    expect(server.identity.name.value).toBe("Identity");
    expect(server.identity.isMultitenant).toBe(false);
    expect(server.resources.name.value).toBe("Resources");
    expect(server.resources.isMultitenant).toBe(true);
  });

  it("add a person to the organization's members when they accept its invitation", async () => {
    const hosted = await givenServer();
    server = hosted;
    const { identity } = hosted;
    await givenOrganization(hosted, "acme");
    await give(
      identity,
      InviteMemberSchema,
      create(InviteMemberSchema, {
        id: invitationOf("acme", "noah@acme.example"),
        role: OrganizationRole.ADMINISTRATOR,
      }),
    );

    await give(
      identity,
      AcceptInvitationSchema,
      create(AcceptInvitationSchema, {
        id: invitationOf("acme", "noah@acme.example"),
        person: { uuid: "noah" },
        name: "Noah Reyes",
      }),
      { actor: "noah" },
    );

    const organization = await eventually(
      () => organizationView(hosted, "acme"),
      (view) => view?.member.length === 1,
    );
    expect(organization?.member).toMatchObject([
      { person: { uuid: "noah" }, name: "Noah Reyes", role: OrganizationRole.ADMINISTRATOR },
    ]);
    const invitation = await eventually(
      () => identity.stand().read(InvitationViewSchema, invitationOf("acme", "noah@acme.example")),
      (view) => view?.status === InvitationStatus.ACCEPTED,
    );
    expect(invitation?.acceptedBy?.uuid).toBe("noah");
  });
});
