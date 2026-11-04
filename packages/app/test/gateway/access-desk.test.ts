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
import { IdentityProvider } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";
import {
  ExternalIdentityViewSchema,
  type ExternalIdentityView,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import { AccessRequestViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  AccessRequestIdSchema,
  ResourceIdSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AccessDesk } from "../../src/gateway/access-desk.js";
import type { ServerConnection } from "../../src/server/client.js";

const reads = vi.hoisted(() => ({
  readById: vi.fn(),
  find: vi.fn(),
  postAndAwaitView: vi.fn(),
}));
vi.mock("../../src/server/client.js", () => ({ ServerRequests: reads }));

beforeEach(() => {
  vi.clearAllMocks();
});

const person = create(PersonIdSchema, { uuid: "person-1" });
const email = create(EmailAddressSchema, { value: "maya@example.com" });
const organization = create(OrganizationIdSchema, { uuid: "acme" });
const account = create(ExternalIdentityIdSchema, {
  provider: IdentityProvider.GOOGLE,
  subject: "google-1",
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
      .mockResolvedValueOnce(
        create(PersonViewSchema, { emailAddress: email, name: "Maya", account: [account] }),
      );

    const signed = await desk.signIn({ id: account, email, name: "Maya" });

    expect(signed).toMatchObject({
      id: { uuid: "person-1" },
      email: { value: "maya@example.com" },
      name: "Maya",
    });
    // Nobody added her to an organization.
    expect(signed?.organization).toBeUndefined();
    expect(reads.postAndAwaitView).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(
        create(PersonViewSchema, { emailAddress: email, name: "Maya", account: [account] }),
      );
    reads.postAndAwaitView.mockResolvedValue(person);

    const signed = await desk.signIn({ id: account, email, name: "Maya" });

    expect(signed?.id.uuid).toBe("person-1");
    const awaited = reads.postAndAwaitView.mock.calls[0]?.[1] as {
      readonly message: {
        readonly id?: { readonly subject: string };
        readonly emailAddress?: { readonly value: string };
      };
      readonly view: unknown;
      readonly idSchema: unknown;
      readonly id: unknown;
      readonly shows: (view: ExternalIdentityView) => { readonly uuid: string } | undefined;
    };
    expect(awaited.message).toMatchObject({
      id: { subject: "google-1" },
      emailAddress: { value: "maya@example.com" },
    });
    expect(awaited.view).toBe(ExternalIdentityViewSchema);
    expect(awaited.idSchema).toBe(ExternalIdentityIdSchema);
    expect(awaited.id).toEqual(account);
    expect(awaited.shows(create(ExternalIdentityViewSchema, { person }))?.uuid).toBe("person-1");
    expect(awaited.shows(create(ExternalIdentityViewSchema, {}))).toBeUndefined();
    expect(reads.readById).toHaveBeenCalledTimes(3);
  });

  it("return no person when an unknown account cannot be linked", async () => {
    const { desk } = givenDesk();
    reads.readById.mockResolvedValueOnce(undefined);
    reads.postAndAwaitView.mockResolvedValueOnce(undefined);

    expect(await desk.signIn({ id: account, email, name: "Maya" })).toBeUndefined();
  });

  it("sign a member in with the organization they belong to", async () => {
    const { desk } = givenDesk();
    reads.readById
      .mockResolvedValueOnce(create(ExternalIdentityViewSchema, { person }))
      .mockResolvedValueOnce(
        create(PersonViewSchema, {
          emailAddress: email,
          name: "Maya",
          account: [account],
          organization,
        }),
      );

    const signed = await desk.signIn({ id: account, email, name: "Maya" });

    expect(signed?.organization?.uuid).toBe("acme");
    expect(reads.readById).toHaveBeenCalledTimes(2);
  });

  it("wait until the person shows with the account they sign in with", async () => {
    const { desk } = givenDesk();
    reads.readById
      .mockResolvedValueOnce(create(ExternalIdentityViewSchema, { person }))
      // An administrator added her, and she has not signed in yet.
      .mockResolvedValueOnce(create(PersonViewSchema, { emailAddress: email, organization }))
      .mockResolvedValueOnce(
        create(PersonViewSchema, {
          emailAddress: email,
          name: "Maya",
          account: [account],
          organization,
        }),
      );

    const signed = await desk.signIn({ id: account, email, name: "Maya" });

    expect(signed).toMatchObject({ name: "Maya", organization: { uuid: "acme" } });
    expect(reads.readById).toHaveBeenCalledTimes(3);
  });

  it("list provider accounts as browser scalars", async () => {
    const { desk } = givenDesk();
    reads.readById.mockResolvedValueOnce(
      create(PersonViewSchema, {
        organization,
        account: [
          account,
          create(ExternalIdentityIdSchema, {
            provider: IdentityProvider.GOOGLE,
            subject: "google-2",
          }),
        ],
      }),
    );

    const profile = await desk.profile({ id: person, email, name: "Maya" });

    expect(profile.accounts).toEqual([
      { provider: "google", subject: "google-1" },
      { provider: "google", subject: "google-2" },
    ]);
    expect(profile.organization?.uuid).toBe("acme");
    expect(reads.readById).toHaveBeenCalledTimes(1);
  });

  it("read organization membership, management, and request ownership by typed IDs", async () => {
    const { desk, inOrganization } = givenDesk();
    const resource = create(ResourceIdSchema, { uuid: "payroll" });
    const accessRequest = create(AccessRequestIdSchema, { uuid: "request-1" });
    reads.readById
      .mockResolvedValueOnce(
        create(OrganizationViewSchema, {
          id: organization,
          member: [{ person, emailAddress: email }],
        }),
      )
      .mockResolvedValueOnce(
        create(ResourceCatalogItemSchema, { id: resource, policy: { manager: [person] } }),
      )
      .mockResolvedValueOnce(
        create(AccessRequestViewSchema, { id: accessRequest, snapshot: { requester: person } }),
      );

    expect((await desk.member(organization, person))?.emailAddress).toEqual(email);
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
