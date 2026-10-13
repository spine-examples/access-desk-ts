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
import type { EmailAddress } from "@spine-event-engine/proto";
import {
  ExternalIdentityIdSchema,
  PersonIdSchema,
  OrganizationIdSchema,
  type ExternalIdentityId,
  type PersonId,
  type OrganizationId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  IdentityProvider,
  InvitationStatus,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { InvitationViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import { InvitationViewQuery } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_query.js";
import { LinkExternalIdentitySchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_commands_pb.js";
import { ExternalIdentityLinkedSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_events_pb.js";
import { ExternalIdentityViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";
import {
  AccessRequestIdSchema,
  ResourceIdSchema,
  type AccessRequestId,
  type ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AccessRequestViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import type { OrganizationMember } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { ServerRequests, type ServerConnection, type ServerRequest } from "../server/client.js";

/** The name under which the gateway itself acts. */
const GATEWAY = "access-desk-gateway";

/** An account as its identity provider has just confirmed it. */
export interface VerifiedPerson {
  /** The account confirmed by its identity provider. */
  readonly id: ExternalIdentityId;
  /** The email address the provider has verified for the account. */
  readonly email: EmailAddress;
  /** The display name the provider gives. */
  readonly name: string;
}

/** A person who has signed in. */
export interface SignedIn {
  /** The person's identifier, by which Access Desk knows them everywhere. */
  readonly id: PersonId;
  /** The email address the person is registered under. */
  readonly email: EmailAddress;
  /** The person's display name. */
  readonly name: string;
}

/** Whether a person is a member of an organization, or only invited to it. */
export type Standing = "member" | "invited";

/** What Identity knows about a signed-in person. */
export interface Profile {
  /** The accounts the person signs in with. */
  readonly accounts: readonly { readonly provider: string; readonly subject: string }[];
  /** The person's organizations, each with their standing in it. */
  readonly standings: readonly {
    readonly organization: OrganizationId;
    readonly standing: Standing;
  }[];
}

/**
 * The application, as the gateway uses it.
 *
 * It signs people in through Identity, and looks up what the gateway needs to
 * know about an organization in Resources.
 */
export class AccessDesk {
  /** The gateway's connection to the application server. */
  readonly #server: ServerConnection;

  /**
   * @param server The gateway's connection to the application server.
   */
  constructor(server: ServerConnection) {
    this.#server = server;
  }

  /** The gateway's client for Identity, which belongs to no organization. */
  get #identity(): ServerRequest {
    return this.#server.in().onBehalfOf(GATEWAY);
  }

  /** The gateway's client for one organization. */
  #in(organization: OrganizationId): ServerRequest {
    return this.#server.in(organization).onBehalfOf(GATEWAY);
  }

  /**
   * Signs in the person a confirmed account belongs to.
   *
   * An account that is new to Access Desk is linked to its person first.
   *
   * @param verified The account the identity provider confirmed.
   * @returns The signed-in person, or `undefined` when the account could not be
   *   linked.
   */
  async signIn(verified: VerifiedPerson): Promise<SignedIn | undefined> {
    const { id, email, name } = verified;
    const known = await ServerRequests.readById(
      this.#identity,
      ExternalIdentityViewSchema,
      ExternalIdentityIdSchema,
      id,
    );
    const holder = known?.person ?? (await this.#link(id, email, name));
    if (holder === undefined) {
      return undefined;
    }
    // The account is linked a moment before the person shows with it.
    const view = await AccessDesk.#eventually(() =>
      ServerRequests.readById(this.#identity, PersonViewSchema, PersonIdSchema, holder),
    );
    return view?.emailAddress === undefined
      ? undefined
      : { id: holder, email: view.emailAddress, name: view.name };
  }

  /**
   * Links an account Access Desk has not seen to the person it belongs to.
   *
   * @returns The person, or `undefined` when Identity did not link the account in time.
   */
  async #link(
    id: ExternalIdentityId,
    email: EmailAddress,
    name: string,
  ): Promise<PersonId | undefined> {
    const linked = await ServerRequests.postAndAwait(this.#identity, {
      command: LinkExternalIdentitySchema,
      message: create(LinkExternalIdentitySchema, { id, emailAddress: email, name }),
      event: ExternalIdentityLinkedSchema,
      answers: (event) => event.id?.provider === id.provider && event.id.subject === id.subject,
    });
    return linked?.person;
  }

  /**
   * A signed-in person's accounts and organizations.
   *
   * The person is a member where they accepted an invitation, and invited where
   * an invitation still waits for their answer.
   */
  async profile(person: SignedIn): Promise<Profile> {
    const [invitations, view] = await Promise.all([
      ServerRequests.find(
        this.#identity,
        InvitationViewSchema,
        InvitationViewQuery.create().invitee().is(person.email).build(),
      ),
      ServerRequests.readById(this.#identity, PersonViewSchema, PersonIdSchema, person.id),
    ]);
    const standings = new Map<string, Profile["standings"][number]>();
    for (const invitation of invitations) {
      const organization = invitation.id?.organization;
      if (invitation.status === InvitationStatus.PENDING && organization !== undefined) {
        standings.set(organization.uuid, { organization, standing: "invited" });
      }
    }
    for (const organization of view?.organization ?? []) {
      standings.set(organization.uuid, { organization, standing: "member" });
    }
    return {
      accounts: (view?.account ?? []).map((account) => ({
        provider: IdentityProvider[account.provider].toLowerCase(),
        subject: account.subject,
      })),
      standings: [...standings.values()],
    };
  }

  /** Whether a person is a member of an organization, as Identity knows it. */
  async joined(person: PersonId, organization: OrganizationId): Promise<boolean> {
    const view = await ServerRequests.readById(
      this.#identity,
      PersonViewSchema,
      PersonIdSchema,
      person,
    );
    return view?.organization.some((joined) => joined.uuid === organization.uuid) ?? false;
  }

  /** An organization with its members and resources, when it exists. */
  organization(organization: OrganizationId): Promise<OrganizationView | undefined> {
    return ServerRequests.readById(
      this.#in(organization),
      OrganizationViewSchema,
      OrganizationIdSchema,
      organization,
    );
  }

  /** A person's membership in an organization, when they are a member. */
  async member(
    organization: OrganizationId,
    person: PersonId,
  ): Promise<OrganizationMember | undefined> {
    const view = await this.organization(organization);
    return view?.member.find((candidate) => candidate.person?.uuid === person.uuid);
  }

  /** Whether a person manages a resource of an organization. */
  async manages(
    organization: OrganizationId,
    person: PersonId,
    resource: ResourceId,
  ): Promise<boolean> {
    const item = await ServerRequests.readById(
      this.#in(organization),
      ResourceCatalogItemSchema,
      ResourceIdSchema,
      resource,
    );
    return item?.policy?.manager.some((manager) => manager.uuid === person.uuid) ?? false;
  }

  /** Whether a person made an access request in an organization. */
  async requested(
    organization: OrganizationId,
    person: PersonId,
    request: AccessRequestId,
  ): Promise<boolean> {
    const view = await ServerRequests.readById(
      this.#in(organization),
      AccessRequestViewSchema,
      AccessRequestIdSchema,
      request,
    );
    return view?.snapshot?.requester?.uuid === person.uuid;
  }

  /** Reads until something is there, for up to ten seconds. */
  static async #eventually<Value>(
    read: () => Promise<Value | undefined>,
  ): Promise<Value | undefined> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (value !== undefined || Date.now() >= deadline) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
