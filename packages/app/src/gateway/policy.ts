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
import type { Any } from "@bufbuild/protobuf/wkt";
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
import { AuditEntrySchema } from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
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
import {
  ResourceIdSchema,
  type ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import type { AccessDesk } from "./access-desk.js";

/** Who has signed in, as the session says. */
interface Signed {
  /** The signed-in person. */
  readonly person: PersonId;
  /** The email address the person is registered under, in lower case. */
  readonly email: EmailAddress;
  /** The person's display name. */
  readonly name: string;
}

/** A signed-in person, in the organization they belong to. */
interface Asking extends Signed {
  /** The organization the person belongs to. */
  readonly organization: OrganizationId;
  /** The person's membership in that organization. */
  readonly member: OrganizationMember;
  /** Whether the person administers the organization. */
  readonly administrator: boolean;
}

/** Whether somebody may give one kind of command. */
interface CommandRule<Who> {
  /** The kind of command. */
  readonly schema: GenMessage<Message>;
  /** Decides whether somebody may give the command. */
  readonly allows: (command: Message, who: Who, desk: AccessDesk) => boolean | Promise<boolean>;
}

function rule<Who, Schema extends GenMessage<Message>>(
  schema: Schema,
  allows: (command: MessageShape<Schema>, who: Who, desk: AccessDesk) => boolean | Promise<boolean>,
): CommandRule<Who> {
  return { schema, allows: (command, who, desk) => allows(command as never, who, desk) };
}

/**
 * The commands a member may give in their organization, each with its
 * condition.
 *
 * A command must name the signed-in person as the one acting, and the
 * organization they belong to. Finer rules, such as which manager decides
 * which request, stay in the domain.
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
  rule(
    RegisterResourceSchema,
    (command, asking: Asking) =>
      asking.administrator && command.organizationId?.uuid === asking.organization.uuid,
  ),
  rule(
    AddMemberSchema,
    (command, asking: Asking) =>
      asking.administrator &&
      command.organization?.uuid === asking.organization.uuid &&
      command.addedBy?.uuid === asking.person.uuid,
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

/**
 * The filter of a query that has exactly one, of the form `column = value`.
 *
 * A query by identifiers, or with several filters or none, has no such filter.
 */
function onlyCondition(
  target: Target,
): { readonly column: string; readonly value: Any } | undefined {
  if (target.criterion.case !== "filters") {
    return undefined;
  }
  const { idFilter, filter: composites } = target.criterion.value;
  const [composite] = composites;
  const [only] = composite?.filter ?? [];
  const [column] = only?.fieldPath?.fieldName ?? [];
  if (
    (idFilter?.id.length ?? 0) > 0 ||
    composites.length !== 1 ||
    composite === undefined ||
    composite.compositeFilter.length > 0 ||
    composite.filter.length !== 1 ||
    only?.value === undefined ||
    only.operator !== Filter_Operator.EQUAL ||
    only.fieldPath?.fieldName.length !== 1 ||
    column === undefined
  ) {
    return undefined;
  }
  return { column, value: only.value };
}

/**
 * Whether a query is filtered to the person's own records, such as the
 * requests they made or the grants they hold.
 */
function asksForOwn(target: Target, column: string, person: PersonId): boolean {
  const condition = onlyCondition(target);
  return (
    condition?.column === column &&
    AnyMessages.unpack(condition.value, PersonIdSchema)?.uuid === person.uuid
  );
}

/** Whether a query is filtered to one resource, and the person manages that resource. */
function asksForManaged(
  target: Target,
  asking: Asking,
  desk: AccessDesk,
): boolean | Promise<boolean> {
  const condition = onlyCondition(target);
  const resource =
    condition?.column === "resource"
      ? AnyMessages.unpack(condition.value, ResourceIdSchema)
      : undefined;
  return (
    resource !== undefined &&
    resource.uuid !== "" &&
    desk.manages(asking.organization, asking.person, resource)
  );
}

/** Whether a query asks only for the record kept under the person's own identifier. */
function asksForOwnById(target: Target, person: PersonId): boolean {
  if (target.criterion.case !== "filters") {
    return false;
  }
  const { idFilter, filter: conditions } = target.criterion.value;
  const [id, ...others] = idFilter?.id ?? [];
  return (
    conditions.length === 0 &&
    id !== undefined &&
    others.length === 0 &&
    AnyMessages.unpack(id, PersonIdSchema)?.uuid === person.uuid
  );
}

/** Whether a member may read or watch what a query asks for. */
type ReadRule = (target: Target, asking: Asking, desk: AccessDesk) => boolean | Promise<boolean>;

/**
 * What a member may read and watch in their organization.
 *
 * Every member sees the organization and its catalog of resources. The rest a
 * person sees only where it concerns them:
 *
 * - the requests they made, and those for a resource they manage;
 * - the grants they hold, and those to a resource they manage;
 * - their own queue of requests to decide;
 * - the audit trail of a resource they manage.
 *
 * So a query for requests, grants, or audit trail must filter by the person or by
 * the resource. An administrator sees the audit trail of the whole organization,
 * and need not filter it. The decision queue is asked for by its identifier,
 * which is the manager's own. Anything not listed here cannot be read.
 */
const MEMBER_READS: ReadonlyMap<string, ReadRule> = new Map<string, ReadRule>([
  [TypeUrls.derive(OrganizationViewSchema), () => true],
  [TypeUrls.derive(ResourceCatalogItemSchema), () => true],
  [
    TypeUrls.derive(AccessRequestViewSchema),
    (target, asking, desk) =>
      asksForOwn(target, "requester", asking.person) || asksForManaged(target, asking, desk),
  ],
  [
    TypeUrls.derive(AccessGrantViewSchema),
    (target, asking, desk) =>
      asksForOwn(target, "grantee", asking.person) || asksForManaged(target, asking, desk),
  ],
  [
    TypeUrls.derive(AccessDecisionAssignmentSchema),
    (target, asking) => asksForOwnById(target, asking.person),
  ],
  [
    TypeUrls.derive(AuditEntrySchema),
    (target, asking, desk) => asking.administrator || asksForManaged(target, asking, desk),
  ],
]);

/** Whether a member may read or watch what a request asks for. */
function mayRead(target: Target, asking: Asking, desk: AccessDesk): boolean | Promise<boolean> {
  return MEMBER_READS.get(target.type)?.(target, asking, desk) ?? false;
}

const MEMBERSHIPS = TypeUrls.derive(MembershipViewSchema);

/** The messages Identity handles, which belong to no organization. */
const OUTSIDE_ORGANIZATIONS: ReadonlySet<string> = new Set([
  MEMBERSHIPS,
  TypeUrls.derive(AddMemberSchema),
]);

/**
 * Whether a query asks only for the memberships of one organization.
 *
 * The memberships of all organizations are kept together, so the query must
 * filter by organization.
 */
function asksForMembershipsOf(target: Target, organization: OrganizationId): boolean {
  const condition = target.type === MEMBERSHIPS ? onlyCondition(target) : undefined;
  return (
    condition?.column === "organization" &&
    AnyMessages.unpack(condition.value, OrganizationIdSchema)?.uuid === organization.uuid
  );
}

/** What a signed-in person may do through the gateway. */
export const Policy = {
  /**
   * Whether a request is for Identity.
   *
   * Such a request is sent without an organization, even though the person
   * belongs to one.
   *
   * @param request A request that reached the gateway.
   */
  concernsNoOrganization(request: IncomingRequest): boolean {
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
  },

  /**
   * Decides whether a signed-in person may make a request.
   *
   * 1. Everything requires belonging to an organization, and being listed
   *    among its members.
   * 2. A command must be one a member may give.
   * 3. A query or a subscription must be for something the member may see. An
   *    administrator may also read who was added to the organization.
   *
   * @param desk Looks up what a rule needs to know.
   * @returns The check the gateway runs on each request.
   */
  authorization(
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
          const command = request.message;
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
            (await mayRead(request.target, asking, desk)) ||
            (asking.administrator && asksForMembershipsOf(request.target, organizationId))
          );
        case "subscribe":
          return mayRead(request.target, asking, desk);
        case "activate":
        case "cancel":
          return true;
      }
    };
  },
};
