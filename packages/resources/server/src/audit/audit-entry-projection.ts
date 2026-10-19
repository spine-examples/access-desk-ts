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

import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { AnySchema } from "@bufbuild/protobuf/wkt";
import { AnyMessages } from "@spine-event-engine/core";
import type { EventContext } from "@spine-event-engine/proto";
import { Projection, Subscribe } from "@spine-event-engine/server";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
  type AccessGrantCreated,
  type AccessGrantExtended,
  type AccessGrantRevoked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessExtensionRequestSubmissionFailedSchema,
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovalFailedSchema,
  AccessRequestApprovalStartedSchema,
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmissionFailedSchema,
  AccessRequestSubmittedSchema,
  type AccessExtensionRequestSubmissionFailed,
  type AccessExtensionRequestSubmitted,
  type AccessRequestApprovalFailed,
  type AccessRequestApprovalStarted,
  type AccessRequestApproved,
  type AccessRequestCanceled,
  type AccessRequestDenied,
  type AccessRequestSubmissionFailed,
  type AccessRequestSubmitted,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  AuditEntrySchema,
  type AuditEntry,
} from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
import type {
  AuditEntryId,
  ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  OrganizationMemberAddedSchema,
  type OrganizationMemberAdded,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import {
  ResourceClosedForRequestsSchema,
  ResourceOpenedForRequestsSchema,
  type ResourceClosedForRequests,
  type ResourceOpenedForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import {
  ResourceRegisteredSchema,
  ResourceRegistrationFailedSchema,
  type ResourceRegistered,
  type ResourceRegistrationFailed,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";
import type { AccessRequestSnapshot } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { equals } from "../proto/equals.js";

/**
 * An entry in an organization's audit trail.
 *
 * Each action the organization accepts in the membership, resource, request,
 * and grant flows makes one entry. The entry keeps the action as it was
 * recorded, and beside it when it was taken, who took it, and the resource it
 * concerns. It is never changed.
 *
 * Who took the action is the person the action names, such as the requester
 * or the manager who decided. Where it names nobody, as when access is granted
 * on approval, it is the person who took the action it followed from.
 */
export class AuditEntryProjection extends Projection<AuditEntryId, typeof AuditEntrySchema> {
  /** Records that a person became a member of the organization. */
  @Subscribe
  onOrganizationMemberAdded(event: OrganizationMemberAdded, context: EventContext): void {
    this.record(OrganizationMemberAddedSchema, event, context, { actor: event.addedBy });
  }

  /** Records that a resource was registered. */
  @Subscribe
  onResourceRegistered(event: ResourceRegistered, context: EventContext): void {
    this.record(ResourceRegisteredSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: event.id,
    });
  }

  /** Records that a resource could not be registered. */
  @Subscribe
  onResourceRegistrationFailed(event: ResourceRegistrationFailed, context: EventContext): void {
    this.record(ResourceRegistrationFailedSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: event.id,
    });
  }

  /** Records that a resource was opened for requests. */
  @Subscribe
  onResourceOpenedForRequests(event: ResourceOpenedForRequests, context: EventContext): void {
    this.record(ResourceOpenedForRequestsSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: event.id,
    });
  }

  /** Records that a resource was closed for requests. */
  @Subscribe
  onResourceClosedForRequests(event: ResourceClosedForRequests, context: EventContext): void {
    this.record(ResourceClosedForRequestsSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: event.id,
    });
  }

  /** Records that a person asked for access. */
  @Subscribe
  onAccessRequestSubmitted(event: AccessRequestSubmitted, context: EventContext): void {
    this.record(AccessRequestSubmittedSchema, event, context, {
      actor: event.snapshot?.requester,
      resource: AuditEntryProjection.requested(event.snapshot),
    });
  }

  /** Records that a person asked for their access to be extended. */
  @Subscribe
  onAccessExtensionRequestSubmitted(
    event: AccessExtensionRequestSubmitted,
    context: EventContext,
  ): void {
    this.record(AccessExtensionRequestSubmittedSchema, event, context, {
      actor: event.snapshot?.requester,
      resource: AuditEntryProjection.requested(event.snapshot),
    });
  }

  /** Records that a request for access never reached a manager. */
  @Subscribe
  onAccessRequestSubmissionFailed(
    event: AccessRequestSubmissionFailed,
    context: EventContext,
  ): void {
    this.record(AccessRequestSubmissionFailedSchema, event, context, {
      actor: event.requester,
      resource: event.resource,
    });
  }

  /** Records that a request for an extension never reached a manager. */
  @Subscribe
  onAccessExtensionRequestSubmissionFailed(
    event: AccessExtensionRequestSubmissionFailed,
    context: EventContext,
  ): void {
    this.record(AccessExtensionRequestSubmissionFailedSchema, event, context, {
      actor: event.requester,
      resource: event.resource,
    });
  }

  /** Records that a manager approved a request. */
  @Subscribe
  onAccessRequestApprovalStarted(event: AccessRequestApprovalStarted, context: EventContext): void {
    this.record(AccessRequestApprovalStartedSchema, event, context, {
      actor: event.decidedBy,
      resource: AuditEntryProjection.requested(event.snapshot),
      when: event.whenDecided,
    });
  }

  /** Records that an approved request was granted, by whose approval. */
  @Subscribe
  onAccessRequestApproved(event: AccessRequestApproved, context: EventContext): void {
    this.record(AccessRequestApprovedSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: AuditEntryProjection.requested(event.snapshot),
    });
  }

  /** Records that an approved request could not be granted. */
  @Subscribe
  onAccessRequestApprovalFailed(event: AccessRequestApprovalFailed, context: EventContext): void {
    this.record(AccessRequestApprovalFailedSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: AuditEntryProjection.requested(event.snapshot),
    });
  }

  /** Records that a manager denied a request. */
  @Subscribe
  onAccessRequestDenied(event: AccessRequestDenied, context: EventContext): void {
    this.record(AccessRequestDeniedSchema, event, context, {
      actor: event.decidedBy,
      resource: AuditEntryProjection.requested(event.snapshot),
      when: event.whenDecided,
    });
  }

  /** Records that the requester canceled a request. */
  @Subscribe
  onAccessRequestCanceled(event: AccessRequestCanceled, context: EventContext): void {
    this.record(AccessRequestCanceledSchema, event, context, {
      actor: event.snapshot?.requester,
      resource: AuditEntryProjection.requested(event.snapshot),
    });
  }

  /** Records that access was granted, and by whose approval. */
  @Subscribe
  onAccessGrantCreated(event: AccessGrantCreated, context: EventContext): void {
    this.record(AccessGrantCreatedSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: event.access?.resource,
    });
  }

  /** Records that access was extended, and by whose approval. */
  @Subscribe
  onAccessGrantExtended(event: AccessGrantExtended, context: EventContext): void {
    this.record(AccessGrantExtendedSchema, event, context, {
      actor: AuditEntryProjection.askedBy(context),
      resource: event.access?.resource,
    });
  }

  /** Records that a manager revoked access, and when. */
  @Subscribe
  onAccessGrantRevoked(event: AccessGrantRevoked, context: EventContext): void {
    this.record(AccessGrantRevokedSchema, event, context, {
      actor: event.revokedBy,
      resource: event.access?.resource,
      when: event.whenRevoked,
    });
  }

  /**
   * Records an action in the audit trail.
   *
   * @param schema The type of the event.
   * @param event The event, which the entry keeps as it is.
   * @param context What the organization recorded about the event, which says
   *   when it happened.
   * @param entry Who took the action, and the resource it concerns. Also
   *   when it was taken, where the action itself states the moment.
   * @throws Error When the entry already holds a different action.
   */
  private record<Schema extends GenMessage<Message>>(
    schema: Schema,
    event: MessageShape<Schema>,
    context: EventContext,
    entry: Partial<Pick<AuditEntry, "actor" | "resource" | "when">>,
  ): void {
    const packed = AnyMessages.pack(schema, event);
    const recorded = this.state.event;
    if (recorded !== undefined) {
      if (equals(AnySchema, recorded, packed)) {
        return;
      }
      throw new Error(`An audit entry for this ${schema.typeName} holds a different action.`);
    }
    this.update((draft) => {
      draft.when = entry.when ?? context.timestamp;
      draft.actor = entry.actor;
      draft.resource = entry.resource;
      draft.event = packed;
    });
  }

  /**
   * The person in whose name the organization was asked to do what led to a fact.
   *
   * @param context What the organization recorded about the fact.
   * @returns The person, or `undefined` when the fact came of no person's asking.
   */
  private static askedBy(context: EventContext): PersonId | undefined {
    const origin = context.origin;
    const actor =
      origin.case === "pastMessage" ? origin.value.actorContext?.actor?.value : undefined;
    return actor === undefined || actor === ""
      ? undefined
      : create(PersonIdSchema, { uuid: actor });
  }

  /**
   * The resource a request is for.
   *
   * @param snapshot The details of the request.
   * @returns The resource, or `undefined` when the request names none.
   */
  private static requested(snapshot: AccessRequestSnapshot | undefined): ResourceId | undefined {
    const kind = snapshot?.kind;
    return kind?.case === undefined ? undefined : kind.value.resource;
  }
}
