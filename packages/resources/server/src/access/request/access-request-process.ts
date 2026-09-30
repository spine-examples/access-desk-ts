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
import { DurationSchema, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Assign, ProcessManager, Throws } from "@spine-event-engine/server";
import { equals } from "../../proto/equals.js";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  type AccessLevel,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  AccessRequestSchema,
  AccessRequestViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  AccessGrantSchema,
  GrantCoverageSchema,
  type AccessGrant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import {
  AccessRequestSnapshotSchema,
  AccessRequestStatus,
  type AccessRequestSnapshot,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  AccessGrantIdSchema,
  AccessRequestIdSchema,
  GrantCoverageIdSchema,
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
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmittedSchema,
  type AccessExtensionRequestSubmitted,
  type AccessRequestApproved,
  type AccessRequestCanceled,
  type AccessRequestDenied,
  type AccessRequestSubmitted,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import {
  AccessAlreadyHeld,
  RequestedDurationTooLong,
  AccessLevelNotOffered,
  RequestAlreadyPending,
  NotAnEligibleManager,
  RequestAlreadyDecided,
  ResourceNotOpenForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections.js";
import { AccessGrantNotActive } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections.js";
import { effectiveInterval, requestedInterval } from "../access-period.js";
import { now } from "../../time/clock.js";
import {
  between,
  compare,
  type Interval,
  longerThan,
  overlaps,
  plus,
} from "../../time/interval.js";

/** No time at all, which every extension must exceed. */
const NO_TIME = create(DurationSchema, {});

/**
 * One access request for a protected resource, driven from submission to a
 * terminal decision.
 *
 * 1. Validate a submission against the resource's request policy and the
 *    access the requester already holds, and capture the managers who may
 *    decide it.
 * 2. Assign the accepted request to those managers for a decision.
 * 3. A manager approves or denies it, or the requester cancels it — once.
 *    Approval fixes when the access begins, so it checks once more that the
 *    requester does not already hold that access; an extension is approved
 *    only while the access it extends is still active.
 *
 * A first-time request asks for new access; an extension request asks to keep
 * active access longer and names the end it proposes.
 */
export class AccessRequestProcessManager extends ProcessManager<
  AccessRequestId,
  typeof AccessRequestSchema
> {
  /** Validates a first-time access request and, when it passes, submits it. */
  @Assign
  @Throws(
    ResourceNotOpenForRequests,
    AccessLevelNotOffered,
    RequestedDurationTooLong,
    RequestAlreadyPending,
    AccessAlreadyHeld,
  )
  async submitAccessRequest(command: SubmitAccessRequest): Promise<AccessRequestSubmitted> {
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
    const policy = await this.requestablePolicy(id, resource);
    const level = this.matchLevel(id, policy, accessLevel);
    this.assertWithinMaximumDuration(id, policy, requested);
    await this.assertNoDuplicate(id, requester, resource);
    await this.assertAccessNotHeld(id, requester, resource, level, requested);
    const manager = this.managers(policy);
    const snapshot = create(AccessRequestSnapshotSchema, {
      requester,
      justification: command.justification,
      kind: { case: "newRequest", value: { resource, accessLevel: level, period } },
    });
    this.store(snapshot, manager);
    return create(AccessRequestSubmittedSchema, { id, snapshot, manager });
  }

  /**
   * Validates a request to keep active access longer and, when it passes, submits it.
   *
   * 1. The requester must hold the grant, and it must be active.
   * 2. The proposed end is the grant's current end plus the requested
   *    duration, which must be positive.
   * 3. The whole access, extension included, must fit the maximum duration of
   *    the resource's policy.
   * 4. The requester must not already hold the same or stronger access to the
   *    resource, through another grant, for any part of the added time.
   */
  @Assign
  @Throws(
    ResourceNotOpenForRequests,
    AccessGrantNotActive,
    RequestedDurationTooLong,
    RequestAlreadyPending,
    AccessAlreadyHeld,
  )
  async submitAccessExtensionRequest(
    command: SubmitAccessExtensionRequest,
  ): Promise<AccessExtensionRequestSubmitted> {
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
    const policy = await this.requestablePolicy(id, resource);
    const held = await this.activeGrant(grant, requester, resource);
    const proposedEnd = plus(held.end, duration);
    this.assertWithinMaximumDuration(id, policy, { start: held.start, end: proposedEnd });
    await this.assertNoDuplicate(id, requester, resource, grant);
    await this.assertAccessNotHeld(
      id,
      requester,
      resource,
      held.accessLevel,
      { start: held.end, end: proposedEnd },
      grant,
    );
    const manager = this.managers(policy);
    const snapshot = create(AccessRequestSnapshotSchema, {
      requester,
      justification: command.justification,
      kind: { case: "extension", value: { grant, proposedEnd } },
    });
    this.store(snapshot, manager);
    return create(AccessExtensionRequestSubmittedSchema, { id, snapshot, manager });
  }

  /**
   * Approves a request that has not yet been decided.
   *
   * 1. Approval fixes when first-time access begins, so the requester must not
   *    already hold the same or stronger access for that effective period.
   * 2. An extension extends active access only, so the grant it applies to must
   *    still give the requester active access.
   * 3. An extension is checked again against access granted since it was
   *    submitted: the grant itself must not already reach the proposed end,
   *    and no other grant may give the same or stronger access for the added
   *    time.
   */
  @Assign
  @Throws(RequestAlreadyDecided, NotAnEligibleManager, AccessAlreadyHeld, AccessGrantNotActive)
  async approveAccessRequest(command: ApproveAccessRequest): Promise<AccessRequestApproved> {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    const decidedBy = this.assertEligibleDecider(command.id, command.manager);
    const id = command.id ?? this.id;
    const requester = snapshot.requester;
    const whenDecided = now();
    if (requester === undefined) {
      throw new Error("A pending request must name its requester.");
    }
    const kind = snapshot.kind;
    if (kind.case === "newRequest") {
      const { resource, accessLevel, period } = kind.value;
      if (resource !== undefined && accessLevel !== undefined) {
        const interval = period === undefined ? undefined : effectiveInterval(period, whenDecided);
        await this.assertAccessNotHeld(id, requester, resource, accessLevel, interval);
      }
    } else if (kind.case === "extension" && kind.value.grant !== undefined) {
      const { grant, proposedEnd } = kind.value;
      const held = await this.activeGrant(grant, requester);
      if (proposedEnd === undefined || compare(proposedEnd, held.end) <= 0) {
        throw AccessAlreadyHeld.create({ id });
      }
      await this.assertAccessNotHeld(
        id,
        requester,
        held.resource,
        held.accessLevel,
        { start: held.end, end: proposedEnd },
        grant,
      );
    }
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

  /** Stores the immutable request details and its manager pool as pending. */
  private store(snapshot: AccessRequestSnapshot, manager: readonly PersonId[]): void {
    this.update((draft) => {
      draft.id = this.id;
      draft.snapshot = snapshot;
      draft.manager = [...manager];
      draft.status = AccessRequestStatus.PENDING;
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

  /** Rejects access that would last longer than the resource's maximum duration. */
  private assertWithinMaximumDuration(
    id: AccessRequestId,
    policy: ResourcePolicy,
    access: Interval,
  ): void {
    const maximum = policy.maximumDuration;
    if (maximum === undefined) {
      throw new Error("A resource policy must carry its maximum duration.");
    }
    if (longerThan(between(access.start, access.end), maximum)) {
      throw RequestedDurationTooLong.create({ id });
    }
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

  /**
   * Rejects a request for access the requester already holds.
   *
   * Access is already held when a grant that has not ended gives the same or
   * a stronger level of the resource for any part of the interval. The grant
   * an extension applies to is not counted against it.
   */
  private async assertAccessNotHeld(
    id: AccessRequestId,
    requester: PersonId,
    resource: ResourceId,
    level: AccessLevel,
    interval: Interval | undefined,
    extended?: AccessGrantId,
  ): Promise<void> {
    if (interval === undefined) {
      return;
    }
    const coverageId = create(GrantCoverageIdSchema, { grantee: requester, resource });
    const coverage = await this.select(GrantCoverageSchema, {}).findById(coverageId as never);
    const held = (coverage?.grant ?? []).some(
      ({ id: covering, accessLevel, start, end }) =>
        !equals(AccessGrantIdSchema, covering, extended) &&
        accessLevel !== undefined &&
        start !== undefined &&
        end !== undefined &&
        accessLevel.rank >= level.rank &&
        overlaps({ start, end }, interval),
    );
    if (held) {
      throw AccessAlreadyHeld.create({ id });
    }
  }

  /**
   * The grant an extension applies to, when it gives the requester access now,
   * to the resource when one is named. A grant gives access now when it is not
   * revoked and the current time is within its period. Otherwise the result is
   * `AccessGrantNotActive`.
   */
  private async activeGrant(
    grant: AccessGrantId,
    requester: PersonId,
    resource?: ResourceId,
  ): Promise<ActiveGrant> {
    const state: AccessGrant | undefined = await this.select(AccessGrantSchema, {}).findById(
      grant as never,
    );
    const { start, end } = state ?? {};
    const heldResource = state?.access?.resource;
    const accessLevel = state?.access?.accessLevel;
    if (
      state === undefined ||
      state.revoked ||
      heldResource === undefined ||
      accessLevel === undefined ||
      !equals(PersonIdSchema, state.access?.grantee, requester) ||
      (resource !== undefined && !equals(ResourceIdSchema, heldResource, resource)) ||
      start === undefined ||
      end === undefined ||
      compare(now(), start) < 0 ||
      compare(now(), end) >= 0
    ) {
      throw AccessGrantNotActive.create({ id: grant });
    }
    return { resource: heldResource, accessLevel, start, end };
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

  /** Whether an equivalent request from the same requester is already pending. */
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
      if (snapshot.kind.case === "extension" && grant !== undefined) {
        const extended = snapshot.kind.value.grant;
        return extended !== undefined && equals(AccessGrantIdSchema, extended, grant);
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

/** The access and period of a grant that gives access now. */
interface ActiveGrant {
  readonly resource: ResourceId;
  readonly accessLevel: AccessLevel;
  readonly start: Timestamp;
  readonly end: Timestamp;
}
