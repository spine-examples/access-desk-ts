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

import type { Message } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { anyIs, anyUnpack } from "@bufbuild/protobuf/wkt";
import type { EventContext } from "@spine-event-engine/proto";
import {
  BoundedContext,
  EventRouting,
  StorageSubscriptionRegistry,
} from "@spine-event-engine/server";
import type { StorageFactory } from "@spine-event-engine/storage";
import {
  OrganizationMemberAddedSchema,
  ResourceAddedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import {
  ResourceClosedForRequestsSchema,
  ResourceDeletedSchema,
  ResourceOpenedForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import {
  ResourceRegisteredSchema,
  ResourceRegistrationFailedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";
import { ResourceAlreadyExistsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/rejections_pb.js";
import { OrganizationResourceNameAlreadyUsedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections_pb.js";
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
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  type AccessGrantId,
  type AccessRequestId,
  type AuditEntryId,
  type ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
  RequestedAccessCheckedSchema,
  RequestedExtensionCheckedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  CheckRequestedAccessSchema,
  CheckRequestedExtensionSchema,
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import { AccessGrantNotActiveSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import {
  AccessAlreadyHeldSchema,
  RequestedDurationTooLongSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections_pb.js";
import { type PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationAggregate } from "./organization/organization-aggregate.js";
import { OrganizationViewProjection } from "./organization/organization-view-projection.js";
import { ResourceAggregate } from "./resource/resource-aggregate.js";
import { ResourceCatalogProjection } from "./resource/resource-catalog-projection.js";
import { ResourceRegistrationProcessManager } from "./resource/resource-registration-process.js";
import { AccessRequestProcessManager } from "./access/request/access-request-process.js";
import { AccessRequestViewProjection } from "./access/request/access-request-view-projection.js";
import { AccessDecisionAssignmentProjection } from "./access/request/access-decision-assignment-projection.js";
import { ResourceAccessAggregate } from "./access/grant/resource-access-aggregate.js";
import { AccessGrantViewProjection } from "./access/grant/access-grant-view-projection.js";
import { AuditEntryIds } from "./audit/audit-entry-ids.js";
import { AuditEntryProjection } from "./audit/audit-entry-projection.js";

/** How the Resources context is assembled. */
export interface ResourcesContextOptions {
  /**
   * Where the context keeps each organization and everything it owns.
   *
   * Each organization is kept apart, so the storage must take an organization
   * it has not seen before, or know every organization from the start.
   */
  readonly storage: StorageFactory;
  /**
   * Where the context keeps subscriptions. Whoever passes it closes it.
   *
   * A subscription belongs to no organization, so storage that keeps each
   * organization apart, such as Spine's PostgreSQL storage, cannot keep it.
   */
  readonly subscriptions: StorageFactory;
}

/**
 * The Resources bounded context.
 *
 * It is multitenant, and each organization is its own tenant. So
 * `CreateOrganization` is given in the tenant of the organization it creates.
 */
export const ResourcesContext = {
  /**
   * Builds the context.
   *
   * @param options How to assemble the context.
   * @returns The assembled Resources bounded context.
   */
  async create(options: ResourcesContextOptions): Promise<BoundedContext> {
    /**
     * Finds the request an event from a person's access answers.
     *
     * That is the request that asked for a check when it was submitted, or for a
     * grant when it was approved.
     */
    const requestOf = (answer: {
      readonly request?: AccessRequestId | undefined;
    }): AccessRequestId[] => (answer.request === undefined ? [] : [answer.request]);
    /** The commands a request gives to a person's access to a resource. */
    const askedByRequest = [
      CheckRequestedAccessSchema,
      CheckRequestedExtensionSchema,
      CreateAccessGrantSchema,
      ExtendAccessGrantSchema,
    ] as const;
    /**
     * Finds the request whose command a person's access rejected.
     *
     * A rejection of anything else, such as a revocation, belongs to no request.
     */
    const requestRejected = (context: EventContext): AccessRequestId[] => {
      const rejected = context.rejection?.command?.message;
      const asked =
        rejected === undefined
          ? undefined
          : askedByRequest.find((schema) => anyIs(rejected, schema));
      return rejected === undefined || asked === undefined
        ? []
        : requestOf(anyUnpack(rejected, asked) ?? {});
    };
    /** Finds the grant an event is about. */
    const grantOf = (event: { readonly id?: AccessGrantId | undefined }): AccessGrantId[] =>
      event.id === undefined ? [] : [event.id];
    const resourceRegistrationProcmanRouting = EventRouting.create<ResourceId>()
      .route(ResourceAddedSchema, (event) =>
        event.resourceId === undefined ? [] : [event.resourceId],
      )
      .route(ResourceAlreadyExistsSchema, (rejection) =>
        rejection.id === undefined ? [] : [rejection.id],
      )
      .route(OrganizationResourceNameAlreadyUsedSchema, (rejection) =>
        rejection.resourceId === undefined ? [] : [rejection.resourceId],
      )
      .route(ResourceDeletedSchema, (event) => (event.id === undefined ? [] : [event.id]));
    const decisionRouting = EventRouting.create<PersonId>()
      .route(AccessRequestSubmittedSchema, (event) => event.manager)
      .route(AccessExtensionRequestSubmittedSchema, (event) => event.manager)
      .route(AccessRequestApprovedSchema, (event) => event.manager)
      .route(AccessRequestApprovalFailedSchema, (event) => event.manager)
      .route(AccessRequestDeniedSchema, (event) => event.manager)
      .route(AccessRequestCanceledSchema, (event) => event.manager)
      .route(AccessGrantRevokedSchema, (event) => event.manager);
    const requestRouting = EventRouting.create<AccessRequestId>()
      .route(RequestedAccessCheckedSchema, (event) => requestOf(event))
      .route(RequestedExtensionCheckedSchema, (event) => requestOf(event))
      .route(AccessGrantCreatedSchema, (event) => requestOf(event))
      .route(AccessGrantExtendedSchema, (event) => requestOf(event))
      .route(AccessAlreadyHeldSchema, (_rejection, context) => requestRejected(context))
      .route(AccessGrantNotActiveSchema, (_rejection, context) => requestRejected(context))
      .route(RequestedDurationTooLongSchema, (_rejection, context) => requestRejected(context));
    const grantViewRouting = EventRouting.create<AccessGrantId>()
      .route(AccessGrantCreatedSchema, (event) => grantOf(event))
      .route(AccessGrantExtendedSchema, (event) => grantOf(event))
      .route(AccessGrantRevokedSchema, (event) => grantOf(event));
    /** The events the organization's audit trail records. */
    const auditTrailEvents = [
      OrganizationMemberAddedSchema,
      ResourceRegisteredSchema,
      ResourceRegistrationFailedSchema,
      ResourceOpenedForRequestsSchema,
      ResourceClosedForRequestsSchema,
      AccessRequestSubmittedSchema,
      AccessExtensionRequestSubmittedSchema,
      AccessRequestSubmissionFailedSchema,
      AccessExtensionRequestSubmissionFailedSchema,
      AccessRequestApprovalStartedSchema,
      AccessRequestApprovedSchema,
      AccessRequestApprovalFailedSchema,
      AccessRequestDeniedSchema,
      AccessRequestCanceledSchema,
      AccessGrantCreatedSchema,
      AccessGrantExtendedSchema,
      AccessGrantRevokedSchema,
    ] as const;

    /** Finds the entry of the audit trail an action makes. */
    const entryOf = (kind: GenMessage<Message>, context: EventContext): AuditEntryId[] => {
      const { producerId: producer, version } = context;
      if (producer === undefined || version === undefined) {
        console.error(
          `The audit trail left out a ${kind.typeName}, because the event does not say what changed.`,
          context,
        );
        return [];
      }
      return [AuditEntryIds.of(producer, version, kind)];
    };
    const auditTrailRouting = EventRouting.create<AuditEntryId>();
    for (const event of auditTrailEvents) {
      auditTrailRouting.route(event, (_event, context) => entryOf(event, context));
    }
    return BoundedContext.multitenant("Resources")
      .withGeneratedRegistryRoot(new URL("..", import.meta.url))
      .withStorageFactory(options.storage)
      .add(OrganizationAggregate)
      .add(OrganizationViewProjection)
      .add(ResourceRegistrationProcessManager, { eventRouting: resourceRegistrationProcmanRouting })
      .add(ResourceAggregate)
      .add(ResourceCatalogProjection)
      .add(AccessRequestProcessManager, { eventRouting: requestRouting })
      .add(AccessRequestViewProjection)
      .add(AccessDecisionAssignmentProjection, { eventRouting: decisionRouting })
      .add(ResourceAccessAggregate)
      .add(AccessGrantViewProjection, { eventRouting: grantViewRouting })
      .add(AuditEntryProjection, { eventRouting: auditTrailRouting })
      .withSubscriptionRegistry(
        new StorageSubscriptionRegistry(
          { name: "Resources:subscriptions", multitenant: false },
          options.subscriptions,
        ),
      )
      .buildAsync();
  },
};
