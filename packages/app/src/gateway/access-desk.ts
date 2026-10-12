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
import {
  find,
  memberOf,
  postAndAwait,
  readById,
  type ServerConnection,
  type ServerRequest,
} from "../server/client.js";

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
  /** The email address the person was registered under, which invitations name. */
  readonly email: EmailAddress;
  /** The person's display name. */
  readonly name: string;
}

/**
 * How a signed-in person stands with an organization. A member may enter it.
 * An invited person holds a pending invitation and may enter once they accept.
 */
export type Standing = "member" | "invited";

/** What Identity tells about a signed-in person. */
export interface Profile {
  /**
   * The accounts the person signs in with, each as its provider and the name
   * the provider gives it.
   */
  readonly accounts: readonly { readonly provider: string; readonly subject: string }[];
  /** Each organization the person may see, paired with their standing in it. */
  readonly standings: readonly {
    readonly organization: OrganizationId;
    readonly standing: Standing;
  }[];
}

/**
 * What the gateway asks of Identity and Resources.
 *
 * Signing in is asked of Identity and concerns no organization. Everything
 * about an organization is asked of Resources, and only for a person who has
 * already signed in. Nothing here takes the person or the organization from
 * the browser.
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
   * Signs in whoever holds an account an identity provider has just confirmed.
   *
   * 1. An account Access Desk already knows signs in the person it belongs to.
   * 2. An account it has not seen is linked first. It joins the person who
   *    its email address is registered for, or a new person is registered for it.
   *
   * @param verified The account the identity provider confirmed.
   * @returns The signed-in person, or `undefined` when Identity did not settle whose account it is.
   */
  async signIn(verified: VerifiedPerson): Promise<SignedIn | undefined> {
    const { id, email, name } = verified;
    const known = await readById(
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
    const view = await eventually(() =>
      readById(this.#identity, PersonViewSchema, PersonIdSchema, holder),
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
    const linked = await postAndAwait(this.#identity, {
      command: LinkExternalIdentitySchema,
      message: create(LinkExternalIdentitySchema, { id, emailAddress: email, name }),
      event: ExternalIdentityLinkedSchema,
      answers: (event) => event.id?.provider === id.provider && event.id.subject === id.subject,
    });
    return linked?.person;
  }

  /**
   * The accounts a signed-in person signs in with, and each organization they
   * may see, paired with their standing in it.
   *
   * A person is a member of the organizations whose invitations they
   * accepted, and is invited to those whose invitations of their email
   * address still wait.
   */
  async profile(person: SignedIn): Promise<Profile> {
    const [invitations, view] = await Promise.all([
      find(
        this.#identity,
        InvitationViewSchema,
        InvitationViewQuery.create().invitee().is(person.email).build(),
      ),
      readById(this.#identity, PersonViewSchema, PersonIdSchema, person.id),
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

  /**
   * Whether Identity lists an organization among those a person is a member
   * of, which it does once they have accepted its invitation.
   */
  async joined(person: PersonId, organization: OrganizationId): Promise<boolean> {
    const view = await readById(this.#identity, PersonViewSchema, PersonIdSchema, person);
    return view?.organization.some((joined) => joined.uuid === organization.uuid) ?? false;
  }

  /** What an organization records about itself, when it exists. */
  organization(organization: OrganizationId): Promise<OrganizationView | undefined> {
    return readById(
      this.#in(organization),
      OrganizationViewSchema,
      OrganizationIdSchema,
      organization,
    );
  }

  /** A person's membership in an organization, when they are a member. */
  member(organization: OrganizationId, person: PersonId): Promise<OrganizationMember | undefined> {
    return memberOf(this.#in(organization), organization, person);
  }

  /** Whether the person is one of the managers of a resource of the organization. */
  async manages(
    organization: OrganizationId,
    person: PersonId,
    resource: ResourceId,
  ): Promise<boolean> {
    const item = await readById(
      this.#in(organization),
      ResourceCatalogItemSchema,
      ResourceIdSchema,
      resource,
    );
    return item?.policy?.manager.some((manager) => manager.uuid === person.uuid) ?? false;
  }

  /** Whether the person is the one who made an access request of the organization. */
  async requested(
    organization: OrganizationId,
    person: PersonId,
    request: AccessRequestId,
  ): Promise<boolean> {
    const view = await readById(
      this.#in(organization),
      AccessRequestViewSchema,
      AccessRequestIdSchema,
      request,
    );
    return view?.snapshot?.requester?.uuid === person.uuid;
  }
}

/** Reads until something is there, for up to ten seconds. */
async function eventually<Value>(
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
