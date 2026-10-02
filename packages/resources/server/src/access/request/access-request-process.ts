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
import { type Duration, DurationSchema } from "@bufbuild/protobuf/wkt";
import { Assign, Command, ProcessManager, React, Throws } from "@spine-event-engine/server";
import { equals } from "../../proto/equals.js";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  type AccessExtension,
  type AccessLevel,
  type NewAccessRequest,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  AccessRequestSchema,
  AccessRequestViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  CheckRequestedAccessSchema,
  CheckRequestedExtensionSchema,
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
  type CheckRequestedAccess,
  type CheckRequestedExtension,
  type CreateAccessGrant,
  type ExtendAccessGrant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import type {
  AccessGrantCreated,
  AccessGrantExtended,
  RequestedAccessChecked,
  RequestedExtensionChecked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import type { AccessGrantNotActive as GrantNotActive } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import {
  AccessRequestSnapshotSchema,
  AccessRequestStatus,
  type AccessRequestSnapshot,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  AccessGrantIdSchema,
  AccessRequestIdSchema,
  ResourceIdSchema,
  type AccessGrantId,
  type AccessRequestId,
  type ResourceId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type {
  ApproveAccessRequest,
  CancelAccessRequest,
  DenyAccessRequest,
  SubmitAccessExtensionRequest,
  SubmitAccessRequest,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  AccessExtensionRequestSubmissionFailedSchema,
  AccessExtensionRequestSubmissionStartedSchema,
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovalFailedSchema,
  AccessRequestApprovalStartedSchema,
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmissionFailedSchema,
  AccessRequestSubmissionStartedSchema,
  AccessRequestSubmittedSchema,
  type AccessExtensionRequestSubmissionFailed,
  type AccessExtensionRequestSubmissionStarted,
  type AccessExtensionRequestSubmitted,
  type AccessRequestApprovalFailed,
  type AccessRequestApprovalStarted,
  type AccessRequestApproved,
  type AccessRequestCanceled,
  type AccessRequestDenied,
  type AccessRequestSubmissionFailed,
  type AccessRequestSubmissionStarted,
  type AccessRequestSubmitted,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import type {
  AccessAlreadyHeld as AlreadyHeld,
  RequestedDurationTooLong as DurationTooLong,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections_pb.js";
import {
  AccessLevelNotOffered,
  RequestAlreadyPending,
  NotAnEligibleManager,
  RequestAlreadyDecided,
  ResourceNotOpenForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections.js";
import { effectiveInterval, requestedInterval } from "../access-period.js";
import { now } from "../../time/clock.js";
import { compare, longerThan } from "../../time/interval.js";

/** No time at all, which every extension must exceed. */
const NO_TIME = create(DurationSchema, {});

/**
 * One access request for a protected resource, driven from submission to a
 * terminal decision.
 *
 * 1. Validate a submission against the resource's request policy, and capture
 *    the managers who may decide it.
 * 2. Have the requester's access to the resource check what the request asks
 *    for: access not already held, or a grant that may be extended. That
 *    changes nothing there. When the check refuses, the submission fails.
 * 3. Assign the accepted request to those managers for a decision.
 * 4. A manager approves or denies it, or the requester cancels it — once.
 * 5. An approval asks for the grant to take effect: a first-time request
 *    creates a grant, and an extension request extends the grant it names.
 *    Only then does the requester's access change.
 * 6. Once the grant is created or extended, the request is approved. When the
 *    grant to extend gives no access, the approval fails.
 *
 * A first-time request asks for new access; an extension request asks to keep
 * active access longer by a duration, which fixes the end it proposes.
 */
export class AccessRequestProcessManager extends ProcessManager<
  AccessRequestId,
  typeof AccessRequestSchema
> {
  /**
   * Validates a first-time access request against the resource's policy and,
   * when it passes, has the access it asks for checked against the access the
   * requester already holds.
   */
  @Assign
  @Throws(ResourceNotOpenForRequests, AccessLevelNotOffered, RequestAlreadyPending)
  async submitAccessRequest(command: SubmitAccessRequest): Promise<AccessRequestSubmissionStarted> {
    const id = command.id ?? this.id;
    const requester = command.requester;
    const resource = command.resource;
    const accessLevel = command.accessLevel;
    const period = command.period;
    if (
      requester === undefined ||
      resource === undefined ||
      accessLevel === undefined ||
      period === undefined
    ) {
      throw new Error("SubmitAccessRequest requires a requester, resource, level, and period.");
    }
    const requested = requestedInterval(period, now());
    if (requested === undefined || compare(requested.start, requested.end) >= 0) {
      throw new Error("Requested access must end after it begins.");
    }
    this.assertUnclaimed();
    const policy = await this.requestablePolicy(id, resource);
    const level = this.matchLevel(id, policy, accessLevel);
    await this.assertNoDuplicate(id, requester, resource);
    const manager = this.managers(policy);
    const snapshot = create(AccessRequestSnapshotSchema, {
      requester,
      justification: command.justification,
      kind: { case: "newRequest", value: { resource, accessLevel: level, period } },
    });
    this.store(snapshot, manager);
    return create(AccessRequestSubmissionStartedSchema, { id });
  }

  /**
   * Validates a request to keep active access longer against the resource's
   * policy and, when it passes, has the extension checked against its grant.
   *
   * The requested duration must be positive.
   */
  @Assign
  @Throws(ResourceNotOpenForRequests, RequestAlreadyPending)
  async submitAccessExtensionRequest(
    command: SubmitAccessExtensionRequest,
  ): Promise<AccessExtensionRequestSubmissionStarted> {
    const id = command.id ?? this.id;
    const requester = command.requester;
    const grant = command.grant;
    const duration = command.duration;
    const resource = command.resource;
    if (
      requester === undefined ||
      grant === undefined ||
      duration === undefined ||
      resource === undefined
    ) {
      throw new Error(
        "SubmitAccessExtensionRequest requires a requester, grant, duration, and resource.",
      );
    }
    if (!longerThan(duration, NO_TIME)) {
      throw new Error("An extension must add time to the access.");
    }
    this.assertUnclaimed();
    const policy = await this.requestablePolicy(id, resource);
    await this.assertNoDuplicate(id, requester, resource, grant);
    const manager = this.managers(policy);
    const snapshot = create(AccessRequestSnapshotSchema, {
      requester,
      justification: command.justification,
      kind: { case: "extension", value: { grant, resource } },
    });
    this.store(snapshot, manager, duration);
    return create(AccessExtensionRequestSubmissionStartedSchema, { id });
  }

  /**
   * Has the requester's access to the resource check the access a first-time
   * request asks for, without changing that access.
   *
   * The check carries the longest total access the resource permits now.
   */
  @Command
  async onAccessRequestSubmissionStarted(
    _event: AccessRequestSubmissionStarted,
  ): Promise<CheckRequestedAccess> {
    const snapshot = this.requireSnapshot();
    if (snapshot.kind.case !== "newRequest") {
      throw new Error("Only a first-time request asks for new access.");
    }
    const { resource, accessLevel, period } = snapshot.kind.value;
    const requested = period === undefined ? undefined : requestedInterval(period, now());
    return create(CheckRequestedAccessSchema, {
      id: { grantee: snapshot.requester, resource },
      request: this.id,
      accessLevel,
      start: requested?.start,
      end: requested?.end,
      maximumDuration: await this.maximumDuration(resource),
    });
  }

  /**
   * Has the requester's access to the resource check the extension a request
   * asks for, without changing that access.
   *
   * The check carries the longest total access the resource permits now.
   */
  @Command
  async onAccessExtensionRequestSubmissionStarted(
    _event: AccessExtensionRequestSubmissionStarted,
  ): Promise<CheckRequestedExtension> {
    const snapshot = this.requireSnapshot();
    if (snapshot.kind.case !== "extension") {
      throw new Error("Only an extension request asks for a grant to be extended.");
    }
    const { grant, resource } = snapshot.kind.value;
    return create(CheckRequestedExtensionSchema, {
      id: { grantee: snapshot.requester, resource },
      grant,
      request: this.id,
      duration: this.state.extensionDuration,
      maximumDuration: await this.maximumDuration(resource),
    });
  }

  /** Submits a first-time request once the access it asks for is checked. */
  @React
  onRequestedAccessChecked(_event: RequestedAccessChecked): AccessRequestSubmitted {
    const snapshot = this.requireSubmissionStarted();
    this.update((draft) => {
      draft.status = AccessRequestStatus.PENDING;
    });
    return create(AccessRequestSubmittedSchema, {
      id: this.id,
      snapshot,
      manager: this.state.manager,
    });
  }

  /** Submits an extension request once the extension is checked, fixing the end it proposes. */
  @React
  onRequestedExtensionChecked(event: RequestedExtensionChecked): AccessExtensionRequestSubmitted {
    const requested = this.requireSubmissionStarted();
    if (requested.kind.case !== "extension") {
      throw new Error("Only an extension request extends a grant.");
    }
    const snapshot = create(AccessRequestSnapshotSchema, {
      ...requested,
      kind: {
        case: "extension",
        value: { ...requested.kind.value, proposedEnd: event.proposedEnd },
      },
    });
    this.update((draft) => {
      draft.snapshot = snapshot;
      draft.status = AccessRequestStatus.PENDING;
    });
    return create(AccessExtensionRequestSubmittedSchema, {
      id: this.id,
      snapshot,
      manager: this.state.manager,
    });
  }

  /** Ends the request without effect when the requester already holds the access it asks for. */
  @React
  onAccessAlreadyHeld(
    _rejection: AlreadyHeld,
  ): AccessRequestSubmissionFailed | AccessExtensionRequestSubmissionFailed {
    return this.submissionFailed();
  }

  /** Ends the request without effect when the access it asks for would last too long. */
  @React
  onRequestedDurationTooLong(
    _rejection: DurationTooLong,
  ): AccessRequestSubmissionFailed | AccessExtensionRequestSubmissionFailed {
    return this.submissionFailed();
  }

  /** Accepts a manager's approval of a pending request, and asks for its access to be granted. */
  @Assign
  @Throws(RequestAlreadyDecided, NotAnEligibleManager)
  approveAccessRequest(command: ApproveAccessRequest): AccessRequestApprovalStarted {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    const decidedBy = this.assertEligibleDecider(command.id, command.manager);
    const whenDecided = now();
    this.update((draft) => {
      draft.status = AccessRequestStatus.APPROVAL_STARTED;
      draft.decidedBy = decidedBy;
      draft.whenDecided = whenDecided;
    });
    return create(AccessRequestApprovalStartedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
      whenDecided,
      manager: this.state.manager,
    });
  }

  /**
   * Asks the grant to give an approval its effect.
   *
   * A first-time request creates its grant, which shares the request's
   * identifier. An extension request extends the grant it names.
   */
  @Command
  onAccessRequestApprovalStarted(
    event: AccessRequestApprovalStarted,
  ): CreateAccessGrant | ExtendAccessGrant {
    const kind = event.snapshot?.kind;
    switch (kind?.case) {
      case "newRequest":
        return this.creation(event, kind.value);
      case "extension":
        return this.extension(event, kind.value);
      default:
        throw new Error("An approved request must ask for new access or for an extension.");
    }
  }

  /** Approves the request once its grant is created. */
  @React
  onAccessGrantCreated(_event: AccessGrantCreated): AccessRequestApproved {
    return this.approved();
  }

  /** Approves the request once its grant is extended. */
  @React
  onAccessGrantExtended(_event: AccessGrantExtended): AccessRequestApproved {
    return this.approved();
  }

  /**
   * Ends an extension request without effect when its grant gives no access,
   * whether that shows at submission or at approval.
   */
  @React
  onAccessGrantNotActive(
    _rejection: GrantNotActive,
  ): AccessExtensionRequestSubmissionFailed | AccessRequestApprovalFailed {
    const outcome = this.refused();
    if (outcome.$typeName === AccessRequestSubmissionFailedSchema.typeName) {
      throw new Error("Only an extension request names a grant that may give no access.");
    }
    return outcome;
  }

  /** Denies a request, with a reason, when it has not yet been decided. */
  @Assign
  @Throws(RequestAlreadyDecided, NotAnEligibleManager)
  denyAccessRequest(command: DenyAccessRequest): AccessRequestDenied {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    const decidedBy = this.assertEligibleDecider(command.id, command.manager);
    const whenDecided = now();
    this.update((draft) => {
      draft.status = AccessRequestStatus.DENIED;
    });
    return create(AccessRequestDeniedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
      whenDecided,
      reason: command.reason,
      manager: this.state.manager,
    });
  }

  /** Cancels a request that has not yet been decided. */
  @Assign
  @Throws(RequestAlreadyDecided)
  cancelAccessRequest(command: CancelAccessRequest): AccessRequestCanceled {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    this.update((draft) => {
      draft.status = AccessRequestStatus.CANCELED;
    });
    return create(AccessRequestCanceledSchema, {
      id: this.id,
      snapshot,
      manager: this.state.manager,
    });
  }

  /**
   * The grant for the access an approved first-time request grants.
   *
   * 1. Immediate access counts its duration from the approval.
   * 2. Scheduled access approved within its interval begins at the approval.
   * 3. Scheduled access approved before its start keeps its interval.
   * 4. Scheduled access approved after its end keeps its interval, so the grant
   *    never gives access.
   */
  private creation(
    approval: AccessRequestApprovalStarted,
    request: NewAccessRequest,
  ): CreateAccessGrant {
    const approvedAt = approval.whenDecided;
    const { resource, accessLevel, period } = request;
    const interval =
      approvedAt === undefined || period === undefined
        ? undefined
        : (effectiveInterval(period, approvedAt) ?? requestedInterval(period, approvedAt));
    if (interval === undefined || resource === undefined) {
      throw new Error(
        "An approved first-time request must carry its approval time, resource, and period.",
      );
    }
    return create(CreateAccessGrantSchema, {
      id: { grantee: approval.snapshot?.requester, resource },
      grant: { uuid: this.id.uuid },
      request: this.id,
      accessLevel,
      start: interval.start,
      end: interval.end,
      manager: approval.manager,
    });
  }

  /** The move of a grant's end to the end an approved extension request proposed. */
  private extension(
    approval: AccessRequestApprovalStarted,
    extension: AccessExtension,
  ): ExtendAccessGrant {
    return create(ExtendAccessGrantSchema, {
      id: { grantee: approval.snapshot?.requester, resource: extension.resource },
      grant: extension.grant,
      request: this.id,
      end: extension.proposedEnd,
    });
  }

  /** The request's approval, now that its grant was created or extended. */
  private approved(): AccessRequestApproved {
    const { snapshot, decidedBy, whenDecided } = this.requireApprovalStarted();
    this.update((draft) => {
      draft.status = AccessRequestStatus.APPROVED;
    });
    return create(AccessRequestApprovedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
      whenDecided,
      manager: this.state.manager,
    });
  }

  /**
   * The request's end without effect, at the step its access was refused at:
   * its submission, or its approval.
   */
  private refused(): SubmissionFailed | AccessRequestApprovalFailed {
    if (this.state.status === AccessRequestStatus.SUBMISSION_STARTED) {
      return this.submissionFailed();
    }
    const { snapshot, decidedBy, whenDecided } = this.requireApprovalStarted();
    this.update((draft) => {
      draft.status = AccessRequestStatus.APPROVAL_FAILED;
    });
    return create(AccessRequestApprovalFailedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
      whenDecided,
      manager: this.state.manager,
    });
  }

  /**
   * The failure of a submission whose access may not be granted, told for the
   * kind of request it is.
   */
  private submissionFailed(): SubmissionFailed {
    const snapshot = this.requireSubmissionStarted();
    this.update((draft) => {
      draft.status = AccessRequestStatus.SUBMISSION_FAILED;
    });
    const failure = { id: this.id, requester: snapshot.requester };
    return snapshot.kind.case === "extension"
      ? create(AccessExtensionRequestSubmissionFailedSchema, failure)
      : create(AccessRequestSubmissionFailedSchema, failure);
  }

  /** The request details while it is asked whether its access may be granted. */
  private requireSubmissionStarted(): AccessRequestSnapshot {
    if (this.state.status !== AccessRequestStatus.SUBMISSION_STARTED) {
      throw new Error("Only a request being submitted is settled by its access.");
    }
    return this.requireSnapshot();
  }

  /** The request and its approval while its grant is asked to give the approval its effect. */
  private requireApprovalStarted(): Pick<
    AccessRequestApproved,
    "snapshot" | "decidedBy" | "whenDecided"
  > {
    const { status, snapshot, decidedBy, whenDecided } = this.state;
    if (status !== AccessRequestStatus.APPROVAL_STARTED) {
      throw new Error("Only a request a manager approved is settled by its grant.");
    }
    return { snapshot, decidedBy, whenDecided };
  }

  /**
   * Stores the request details and its manager pool while it is asked whether
   * the access may be granted, with the time an extension request asks to add.
   */
  private store(
    snapshot: AccessRequestSnapshot,
    manager: readonly PersonId[],
    extensionDuration?: Duration,
  ): void {
    this.update((draft) => {
      draft.id = this.id;
      draft.snapshot = snapshot;
      draft.manager = [...manager];
      draft.status = AccessRequestStatus.SUBMISSION_STARTED;
      if (extensionDuration !== undefined) {
        draft.extensionDuration = extensionDuration;
      }
    });
  }

  /** The resource's current policy, or `ResourceNotOpenForRequests` when it is closed. */
  private async requestablePolicy(
    id: AccessRequestId,
    resource: ResourceId,
  ): Promise<ResourcePolicy> {
    const policy = (await this.select(ResourceCatalogItemSchema, {}).findById(resource as never))
      ?.policy;
    if (!policy?.openForRequests) {
      throw ResourceNotOpenForRequests.create({ id });
    }
    return policy;
  }

  /** The longest total access the resource permits, as its catalog entry tells now. */
  private async maximumDuration(resource: ResourceId | undefined): Promise<Duration | undefined> {
    return resource === undefined
      ? undefined
      : (await this.select(ResourceCatalogItemSchema, {}).findById(resource as never))?.policy
          ?.maximumDuration;
  }

  /** The authoritative policy level matching the request, or `AccessLevelNotOffered`. */
  private matchLevel(
    id: AccessRequestId,
    policy: ResourcePolicy,
    accessLevel: AccessLevel,
  ): AccessLevel {
    const requestedName = accessLevel.name.trim().toLocaleLowerCase();
    const level = policy.accessLevel.find(
      (offeredLevel) =>
        offeredLevel.name.trim().toLocaleLowerCase() === requestedName &&
        offeredLevel.rank === accessLevel.rank,
    );
    if (level === undefined) {
      throw AccessLevelNotOffered.create({ id });
    }
    return level;
  }

  /** Rejects a request that conflicts with one already pending for this requester. */
  private async assertNoDuplicate(
    id: AccessRequestId,
    requester: PersonId,
    resource: ResourceId,
    grant?: AccessGrantId,
  ): Promise<void> {
    if (await this.hasPendingRequest(requester, resource, id, grant)) {
      throw RequestAlreadyPending.create({ id });
    }
  }

  /** Refuses a request identifier that already names a request lifecycle. */
  private assertUnclaimed(): void {
    if (
      this.state.status !== AccessRequestStatus.ARS_UNSPECIFIED ||
      this.state.snapshot !== undefined
    ) {
      throw new Error("A request identifier names only one request.");
    }
  }

  /** The resource managers who may decide the request, deduplicated in policy order. */
  private managers(policy: ResourcePolicy): PersonId[] {
    const managers: PersonId[] = [];
    const seen = new Set<string>();
    for (const manager of policy.manager) {
      if (seen.has(manager.uuid)) {
        continue;
      }
      seen.add(manager.uuid);
      managers.push(manager);
    }
    return managers;
  }

  /**
   * Whether a conflicting request from the same requester is already pending.
   *
   * 1. A pending first-time request for the resource conflicts with any other
   *    request for it.
   * 2. A pending extension request conflicts with a first-time request for the
   *    resource its grant gives access to, and with another extension of the
   *    same grant.
   */
  private async hasPendingRequest(
    requester: PersonId,
    resource: ResourceId,
    thisRequest: AccessRequestId,
    grant?: AccessGrantId,
  ): Promise<boolean> {
    const requests = await this.select(AccessRequestViewSchema, {}).all();
    return requests.some((request) => {
      if (equals(AccessRequestIdSchema, request.id, thisRequest)) {
        return false;
      }
      if (request.status !== AccessRequestStatus.PENDING) {
        return false;
      }
      const snapshot = request.snapshot;
      if (snapshot === undefined || !equals(PersonIdSchema, snapshot.requester, requester)) {
        return false;
      }
      if (snapshot.kind.case === "newRequest") {
        const requested = snapshot.kind.value.resource;
        return requested !== undefined && equals(ResourceIdSchema, requested, resource);
      }
      if (snapshot.kind.case === "extension") {
        const { grant: extended, resource: extendedOn } = snapshot.kind.value;
        return grant === undefined
          ? extendedOn !== undefined && equals(ResourceIdSchema, extendedOn, resource)
          : extended !== undefined && equals(AccessGrantIdSchema, extended, grant);
      }
      return false;
    });
  }

  private assertPending(id: AccessRequestId | undefined): void {
    if (this.state.status !== AccessRequestStatus.PENDING) {
      throw RequestAlreadyDecided.create({ id: id ?? this.id });
    }
  }

  private requireSnapshot(): AccessRequestSnapshot {
    const snapshot = this.state.snapshot;
    if (snapshot === undefined) {
      throw new Error("A pending request must retain its immutable snapshot.");
    }
    return snapshot;
  }

  private assertEligibleDecider(
    id: AccessRequestId | undefined,
    decidedBy: PersonId | undefined,
  ): PersonId {
    if (decidedBy === undefined || decidedBy.uuid.trim() === "") {
      throw NotAnEligibleManager.create({ id: id ?? this.id });
    }
    if (!this.state.manager.some((manager) => equals(PersonIdSchema, manager, decidedBy))) {
      throw NotAnEligibleManager.create({ id: id ?? this.id });
    }
    return decidedBy;
  }
}

/** The failure of a submission, of a first-time request or of an extension request. */
type SubmissionFailed = AccessRequestSubmissionFailed | AccessExtensionRequestSubmissionFailed;
