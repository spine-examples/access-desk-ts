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

import { create, isMessage, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { AuthenticatedPrincipal, IncomingRequest } from "@spine-event-engine/auth";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { Filter_Operator, type Target } from "@spine-event-engine/proto/client";
import { AccessGrantViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/resource_access_pb.js";
import { RevokeAccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessDecisionAssignmentSchema,
  AccessRequestViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  ApproveAccessRequestSchema,
  CancelAccessRequestSchema,
  DenyAccessRequestSchema,
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import {
  CloseResourceForRequestsSchema,
  OpenResourceForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/commands_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import type { OrganizationMember } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { EmailAddressSchema, type EmailAddress } from "@spine-event-engine/proto";
import {
  OrganizationIdSchema,
  PersonIdSchema,
  type OrganizationId,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { ResourceId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  AcceptInvitationSchema,
  DeclineInvitationSchema,
  InviteMemberSchema,
  RevokeInvitationSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/commands_pb.js";
import { InvitationViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import type { AccessDesk } from "./access_desk.js";

/** Who has signed in, as the session says. */
interface Signed {
  /** The signed-in person. */
  readonly person: PersonId;
  /** The email address the person is registered under, in lower case. */
  readonly email: EmailAddress;
  /** The person's display name. */
  readonly name: string;
}

/** Who is asking, and where, once the gateway has established both. */
interface Asking extends Signed {
  /** The organization the person has entered. */
  readonly organization: OrganizationId;
  /** The person's membership in that organization. */
  readonly member: OrganizationMember;
  /** Whether the person administers the organization. */
  readonly administrator: boolean;
}

/** Says whether somebody may give one kind of command. */
interface CommandRule<Who> {
  readonly schema: GenMessage<Message>;
  readonly allows: (command: Message, who: Who, desk: AccessDesk) => boolean | Promise<boolean>;
}

function rule<Who, Schema extends GenMessage<Message>>(
  schema: Schema,
  allows: (command: MessageShape<Schema>, who: Who, desk: AccessDesk) => boolean | Promise<boolean>,
): CommandRule<Who> {
  return { schema, allows: (command, who, desk) => allows(command as never, who, desk) };
}

/** Whether an invitation is the one an organization holds for the signed-in person. */
function invitesThem(
  id: { readonly invitee?: EmailAddress | undefined } | undefined,
  signed: Signed,
): boolean {
  return id?.invitee?.value.trim().toLowerCase() === signed.email.value;
}

/**
 * The commands a signed-in person may give before entering any organization.
 *
 * A person answers only the invitations sent to their own email address, and
 * only in their own name.
 */
const SIGNED_IN_COMMANDS: readonly CommandRule<Signed>[] = [
  rule(
    AcceptInvitationSchema,
    (command, signed: Signed) =>
      command.person?.uuid === signed.person.uuid &&
      command.name === signed.name &&
      invitesThem(command.id, signed),
  ),
  rule(
    DeclineInvitationSchema,
    (command, signed: Signed) =>
      command.person?.uuid === signed.person.uuid && invitesThem(command.id, signed),
  ),
];

/**
 * The commands a member may give in the organization they have entered, and
 * on what condition.
 *
 * A command that is not listed is refused. That covers every command only the
 * application itself gives, such as creating an organization, adding a member,
 * or creating a grant, and every other command of the Identity context.
 *
 * Where a command names the person who acts, that person must be the one who
 * signed in. Where it names an organization, that must be the one entered.
 * The finer rules, such as which manager may decide which request, remain
 * with the domain.
 */
const MEMBER_COMMANDS: readonly CommandRule<Asking>[] = [
  rule(
    SubmitAccessRequestSchema,
    (command, asking: Asking) => command.requester?.uuid === asking.person.uuid,
  ),
  rule(
    SubmitAccessExtensionRequestSchema,
    (command, asking: Asking) => command.requester?.uuid === asking.person.uuid,
  ),
  rule(CancelAccessRequestSchema, (command, asking: Asking, desk) =>
    command.id === undefined
      ? false
      : desk.requested(asking.organization, asking.person, command.id),
  ),
  rule(
    ApproveAccessRequestSchema,
    (command, asking: Asking) => command.manager?.uuid === asking.person.uuid,
  ),
  rule(
    DenyAccessRequestSchema,
    (command, asking: Asking) => command.manager?.uuid === asking.person.uuid,
  ),
  rule(
    RevokeAccessGrantSchema,
    (command, asking: Asking) => command.manager?.uuid === asking.person.uuid,
  ),
  rule(OpenResourceForRequestsSchema, managesOrAdministers),
  rule(CloseResourceForRequestsSchema, managesOrAdministers),
  rule(RegisterResourceSchema, (_command, asking: Asking) => asking.administrator),
  rule(
    InviteMemberSchema,
    (command, asking: Asking) =>
      asking.administrator && command.id?.organization?.uuid === asking.organization.uuid,
  ),
  rule(
    RevokeInvitationSchema,
    (command, asking: Asking) =>
      asking.administrator && command.id?.organization?.uuid === asking.organization.uuid,
  ),
];

function managesOrAdministers(
  command: { readonly id?: ResourceId | undefined },
  asking: Asking,
  desk: AccessDesk,
): boolean | Promise<boolean> {
  return (
    command.id !== undefined &&
    (asking.administrator || desk.manages(asking.organization, asking.person, command.id))
  );
}

/** What every member of an organization may read and watch there. */
const MEMBER_READS: ReadonlySet<string> = new Set(
  [
    OrganizationViewSchema,
    ResourceCatalogItemSchema,
    AccessRequestViewSchema,
    AccessDecisionAssignmentSchema,
    AccessGrantViewSchema,
  ].map((schema) => TypeUrls.derive(schema)),
);

const INVITATIONS = TypeUrls.derive(InvitationViewSchema);

/** The kinds of message that concern no single organization, because Identity handles them. */
const OUTSIDE_ORGANIZATIONS: ReadonlySet<string> = new Set([
  INVITATIONS,
  ...[
    AcceptInvitationSchema,
    DeclineInvitationSchema,
    InviteMemberSchema,
    RevokeInvitationSchema,
  ].map((schema) => TypeUrls.derive(schema)),
]);

/**
 * Whether a request is for Identity, which belongs to no organization.
 *
 * Such a request must reach the application server without naming an
 * organization, even when the person has entered one.
 *
 * @param request A request that reached the gateway.
 */
export function concernsNoOrganization(request: IncomingRequest): boolean {
  switch (request.kind) {
    case "command":
      return OUTSIDE_ORGANIZATIONS.has(request.messageType);
    case "query":
    case "subscribe":
      return OUTSIDE_ORGANIZATIONS.has(request.target.type);
    case "activate":
    case "cancel":
      return false;
  }
}

/**
 * Whether a query asks for the invitations of one organization and nothing
 * else.
 *
 * Invitations of every organization are kept together, so a query for them
 * must say which organization's it wants, by that column alone.
 */
function asksForInvitationsOf(target: Target, organization: OrganizationId): boolean {
  if (target.type !== INVITATIONS || target.criterion.case !== "filters") {
    return false;
  }
  const { idFilter, filter: composites } = target.criterion.value;
  const [composite] = composites;
  const [only] = composite?.filter ?? [];
  if (
    (idFilter?.id.length ?? 0) > 0 ||
    composites.length !== 1 ||
    composite === undefined ||
    composite.compositeFilter.length > 0 ||
    composite.filter.length !== 1 ||
    only?.value === undefined ||
    only.operator !== Filter_Operator.EQUAL ||
    only.fieldPath?.fieldName.join(".") !== "organization"
  ) {
    return false;
  }
  return AnyMessages.unpack(only.value, OrganizationIdSchema)?.uuid === organization.uuid;
}

/**
 * Decides, for each request that reaches the gateway, whether the signed-in
 * person may make it.
 *
 * 1. A signed-in person may answer an invitation sent to their own email
 *    address, whether or not they have entered an organization.
 * 2. For anything else the person must have entered an organization, and be
 *    a member of it, as the organization says now.
 * 3. A command must be one a member may give, on its condition.
 * 4. A query or a subscription must be for something a member may see. An
 *    administrator may also read the organization's invitations.
 *
 * @param desk What the gateway asks of the contexts.
 * @returns The decision the gateway asks for each request.
 */
export function authorization(
  desk: AccessDesk,
): (principal: AuthenticatedPrincipal, request: IncomingRequest) => Promise<boolean> {
  return async (principal, request) => {
    const { email, name, organization } = principal.attributes ?? {};
    if (email === undefined) {
      return false;
    }
    const signed: Signed = {
      person: create(PersonIdSchema, { uuid: principal.id }),
      email: create(EmailAddressSchema, { value: email }),
      name: name ?? email,
    };
    const command = request.kind === "command" ? request.message : undefined;
    const answering =
      command === undefined
        ? undefined
        : SIGNED_IN_COMMANDS.find(({ schema }) => isMessage(command, schema));
    if (command !== undefined && answering !== undefined) {
      return answering.allows(command, signed, desk);
    }
    if (organization === undefined) {
      return false;
    }
    const organizationId = create(OrganizationIdSchema, { uuid: organization });
    const member = await desk.member(organizationId, signed.person);
    if (member === undefined) {
      return false;
    }
    const asking: Asking = {
      ...signed,
      organization: organizationId,
      member,
      administrator: member.role === OrganizationRole.ADMINISTRATOR,
    };
    switch (request.kind) {
      case "command": {
        const applies =
          command === undefined
            ? undefined
            : MEMBER_COMMANDS.find(({ schema }) => isMessage(command, schema));
        return command !== undefined && applies !== undefined
          ? applies.allows(command, asking, desk)
          : false;
      }
      case "query":
        return (
          MEMBER_READS.has(request.target.type) ||
          (asking.administrator && asksForInvitationsOf(request.target, organizationId))
        );
      case "subscribe":
        return MEMBER_READS.has(request.target.type);
      case "activate":
      case "cancel":
        return true;
    }
  };
}
