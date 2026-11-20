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
  MembershipIdSchema,
  OrganizationIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

import {
  givenApplicationServer,
  givenOrganization,
  stopApplicationServer,
} from "./given/application-server.js";
import { eventually } from "./given/hosted.js";

type ClientModule = typeof import("../../dist/src/server/client.js");

afterEach(stopApplicationServer);

describe("The application server should", () => {
  it("add a person to an organization while the workers share the delivery server", async () => {
    const connection = await givenApplicationServer();
    const { ServerRequests }: ClientModule = await import("../../dist/src/server/client.js");
    const acme = create(OrganizationIdSchema, { uuid: "acme" });
    await givenOrganization(connection, acme);
    const noah = create(MembershipIdSchema, {
      emailAddress: create(EmailAddressSchema, { value: "noah@acme.example" }),
    });

    const identity = connection.in().onBehalfOf("access-desk");
    await identity.post(
      AddMemberSchema,
      create(AddMemberSchema, { id: noah, organization: acme, role: OrganizationRole.MEMBER }),
    );

    const membership = await eventually(
      () => ServerRequests.readById(identity, MembershipViewSchema, MembershipIdSchema, noah),
      (view) => view?.person !== undefined,
    );
    const organization = await ServerRequests.readById(
      connection.in(acme).onBehalfOf("access-desk"),
      OrganizationViewSchema,
      OrganizationIdSchema,
      acme,
    );
    expect(membership?.person).toBeDefined();
    expect(organization?.member.map((member) => member.person?.uuid)).toEqual([
      membership?.person?.uuid,
    ]);
  });
});
