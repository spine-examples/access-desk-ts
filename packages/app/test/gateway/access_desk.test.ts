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
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExternalIdentityIdSchema,
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { InvitationViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import {
  IdentityProvider,
  InvitationStatus,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";
import { ExternalIdentityViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import { ExternalIdentityLinkedSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_events_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import { AccessRequestViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  AccessRequestIdSchema,
  ResourceIdSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AccessDesk } from "../../src/gateway/access_desk.js";
import type { ServerConnection } from "../../src/server/client.js";

const reads = vi.hoisted(() => ({
  readById: vi.fn(),
  find: vi.fn(),
  postAndAwait: vi.fn(),
}));
vi.mock("../../src/server/client.js", () => reads);

beforeEach(() => {
  vi.clearAllMocks();
});

const person = create(PersonIdSchema, { uuid: "person-1" });
const email = create(EmailAddressSchema, { value: "maya@example.com" });
const organization = create(OrganizationIdSchema, { uuid: "acme" });
const account = create(ExternalIdentityIdSchema, {
  provider: IdentityProvider.GITHUB,
  subject: "github-1",
});

function givenDesk() {
  const request = { name: "server request" };
  const onBehalfOf = vi.fn(() => request);
  const inOrganization = vi.fn(() => ({ onBehalfOf }));
  const desk = new AccessDesk({ in: inOrganization } as unknown as ServerConnection);
  return { desk, request, onBehalfOf, inOrganization };
}

describe("AccessDesk should", () => {
  it("return a known account's person as typed identity values", async () => {
    const { desk, inOrganization, onBehalfOf } = givenDesk();
    reads.readById
      .mockResolvedValueOnce(create(ExternalIdentityViewSchema, { person }))
      .mockResolvedValueOnce(create(PersonViewSchema, { emailAddress: email, name: "Maya" }));

    const signed = await desk.signIn({ id: account, email, name: "Maya" });

    expect(signed).toMatchObject({
      id: { uuid: "person-1" },
      email: { value: "maya@example.com" },
      name: "Maya",
    });
    expect(reads.postAndAwait).not.toHaveBeenCalled();
    expect(inOrganization).toHaveBeenCalledWith();
    expect(onBehalfOf).toHaveBeenCalledWith("access-desk-gateway");
    expect(reads.readById).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      ExternalIdentityViewSchema,
      ExternalIdentityIdSchema,
      account,
    );
    expect(reads.readById).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      PersonViewSchema,
      PersonIdSchema,
      person,
    );
  });

  it("link an unknown account and wait for its typed person view", async () => {
    const { desk } = givenDesk();
    reads.readById
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(create(PersonViewSchema, { emailAddress: email, name: "Maya" }));
    reads.postAndAwait.mockResolvedValue(
      create(ExternalIdentityLinkedSchema, { id: account, person }),
    );

    const signed = await desk.signIn({ id: account, email, name: "Maya" });

    expect(signed?.id.uuid).toBe("person-1");
    const awaited = reads.postAndAwait.mock.calls[0]?.[1] as {
      readonly message: {
        readonly id?: { readonly subject: string };
        readonly emailAddress?: { readonly value: string };
      };
      readonly answers: (event: {
        readonly id?: { readonly provider: IdentityProvider; readonly subject: string };
      }) => boolean;
    };
    expect(awaited.message).toMatchObject({
      id: { subject: "github-1" },
      emailAddress: { value: "maya@example.com" },
    });
    expect(awaited.answers({ id: account })).toBe(true);
    expect(
      awaited.answers({ id: { provider: IdentityProvider.GOOGLE, subject: "github-1" } }),
    ).toBe(false);
    expect(reads.readById).toHaveBeenCalledTimes(3);
  });

  it("return no person when an unknown account cannot be linked", async () => {
    const { desk } = givenDesk();
    reads.readById.mockResolvedValueOnce(undefined);
    reads.postAndAwait.mockResolvedValueOnce(undefined);

    expect(await desk.signIn({ id: account, email, name: "Maya" })).toBeUndefined();
  });

  it("list provider accounts as browser scalars", async () => {
    const { desk } = givenDesk();
    reads.readById.mockResolvedValueOnce(
      create(PersonViewSchema, {
        account: [
          account,
          create(ExternalIdentityIdSchema, {
            provider: IdentityProvider.GOOGLE,
            subject: "google-2",
          }),
        ],
      }),
    );

    expect(await desk.accounts(person)).toEqual([
      { provider: "github", subject: "github-1" },
      { provider: "google", subject: "google-2" },
    ]);
  });

  it("let a membership override a pending invitation with an equal organization UUID", async () => {
    const { desk } = givenDesk();
    const anotherInstance = create(OrganizationIdSchema, { uuid: "acme" });
    reads.find.mockResolvedValueOnce([
      create(InvitationViewSchema, {
        id: { organization, invitee: email },
        status: InvitationStatus.PENDING,
      }),
    ]);
    reads.readById.mockResolvedValueOnce(
      create(PersonViewSchema, { organization: [anotherInstance] }),
    );

    const standings = await desk.standings({ id: person, email, name: "Maya" });

    expect(standings).toEqual([{ organization: anotherInstance, standing: "member" }]);
    expect(reads.find).toHaveBeenCalledWith(
      expect.anything(),
      InvitationViewSchema,
      expect.anything(),
    );
  });

  it("keep pending invitations for other organizations and omit nonpending ones", async () => {
    const { desk } = givenDesk();
    const globex = create(OrganizationIdSchema, { uuid: "globex" });
    reads.find.mockResolvedValueOnce([
      create(InvitationViewSchema, {
        id: { organization, invitee: email },
        status: InvitationStatus.PENDING,
      }),
      create(InvitationViewSchema, {
        id: { organization: globex, invitee: email },
        status: InvitationStatus.DECLINED,
      }),
    ]);
    reads.readById.mockResolvedValueOnce(undefined);

    expect(await desk.standings({ id: person, email, name: "Maya" })).toEqual([
      { organization, standing: "invited" },
    ]);
  });

  it("read organization membership, management, and request ownership by typed IDs", async () => {
    const { desk, inOrganization } = givenDesk();
    const resource = create(ResourceIdSchema, { uuid: "payroll" });
    const accessRequest = create(AccessRequestIdSchema, { uuid: "request-1" });
    reads.readById
      .mockResolvedValueOnce(
        create(OrganizationViewSchema, { id: organization, member: [{ person, name: "Maya" }] }),
      )
      .mockResolvedValueOnce(
        create(ResourceCatalogItemSchema, { id: resource, policy: { manager: [person] } }),
      )
      .mockResolvedValueOnce(
        create(AccessRequestViewSchema, { id: accessRequest, snapshot: { requester: person } }),
      );

    expect((await desk.member(organization, person))?.name).toBe("Maya");
    expect(await desk.manages(organization, person, resource)).toBe(true);
    expect(await desk.requested(organization, person, accessRequest)).toBe(true);
    expect(inOrganization).toHaveBeenCalledWith(organization);
    expect(reads.readById.mock.calls.map((call): unknown => call[3])).toEqual([
      organization,
      resource,
      accessRequest,
    ]);
  });

  it("report no membership, management, or request ownership when their views are absent", async () => {
    const { desk } = givenDesk();
    reads.readById.mockResolvedValue(undefined);

    expect(await desk.member(organization, person)).toBeUndefined();
    expect(
      await desk.manages(organization, person, create(ResourceIdSchema, { uuid: "missing" })),
    ).toBe(false);
    expect(
      await desk.requested(
        organization,
        person,
        create(AccessRequestIdSchema, { uuid: "missing" }),
      ),
    ).toBe(false);
  });
});
