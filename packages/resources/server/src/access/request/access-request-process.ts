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
import type { Duration, Timestamp } from "@bufbuild/protobuf/wkt";
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
import { AccessNotActive } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import {
  AccessGrantStatus,
  AccessRequestSnapshotSchema,
  AccessRequestStatus,
  type AccessPeriod,
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
 *    requester does not already hold that access.
 *
 * A first-time request asks for new access; an extension request asks to keep
 * active access longer and names the end it proposes. Both are decided alike.
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
    const policy = await this.requestablePolicy(id, resource);
    const level = this.matchLevel(id, policy, accessLevel);
    this.assertWithinMaxDuration(id, policy, period);
    await this.assertNoDuplicate(id, requester, resource);
    await this.assertAccessNotHeld(
      id,
      requester,
      resource,
      level,
      requestedInterval(period, now()),
    );
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
   * The requester must hold the grant, and it must be active. The proposed end
   * is the grant's current end plus the requested duration, and the whole
   * access, extension included, must fit the grant's maximum lifetime.
   */
  @Assign
  @Throws(
    ResourceNotOpenForRequests,
    AccessNotActive,
    RequestedDurationTooLong,
    RequestAlreadyPending,
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
    // An extension keeps the grant's level, so the level is not checked again,
    // and it is a duplicate only of another extension of the same grant.
    const policy = await this.requestablePolicy(id, resource);
    const held = await this.activeGrant(grant, requester, resource);
    const proposedEnd = plus(held.end, duration);
    if (longerThan(between(held.start, proposedEnd), held.maximumLifetime)) {
      throw RequestedDurationTooLong.create({ id });
    }
    await this.assertNoDuplicate(id, requester, resource, grant);
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
   * Approval fixes when first-time access begins, so the requester must not
   * already hold the same or stronger access for that effective period.
   */
  @Assign
  @Throws(RequestAlreadyDecided, NotAnEligibleManager, AccessAlreadyHeld)
  async approveAccessRequest(command: ApproveAccessRequest): Promise<AccessRequestApproved> {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    const decidedBy = this.assertEligibleDecider(command.id, command.manager);
    const whenDecided = now();
    if (snapshot.kind.case === "newRequest") {
      const { resource, accessLevel, period } = snapshot.kind.value;
      if (snapshot.requester !== undefined && resource !== undefined && accessLevel !== undefined) {
        const interval = period === undefined ? undefined : effectiveInterval(period, whenDecided);
        await this.assertAccessNotHeld(
          command.id ?? this.id,
          snapshot.requester,
          resource,
          accessLevel,
          interval,
        );
      }
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
    this.update((draft) => {
      draft.status = AccessRequestStatus.DENIED;
    });
    return create(AccessRequestDeniedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
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

  /** Rejects a requested period longer than the resource's maximum access duration. */
  private assertWithinMaxDuration(
    id: AccessRequestId,
    policy: ResourcePolicy,
    period: AccessPeriod,
  ): void {
    if (
      policy.maximumDuration !== undefined &&
      this.durationExceedsMaximum(period, policy.maximumDuration)
    ) {
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
   * Access is already held when a grant that has not ended confers the same or
   * a stronger level of the resource for any part of the interval.
   */
  private async assertAccessNotHeld(
    id: AccessRequestId,
    requester: PersonId,
    resource: ResourceId,
    level: AccessLevel,
    interval: Interval | undefined,
  ): Promise<void> {
    if (interval === undefined) {
      return;
    }
    const coverageId = create(GrantCoverageIdSchema, { grantee: requester, resource });
    const coverage = await this.select(GrantCoverageSchema, {}).findById(coverageId as never);
    const held = (coverage?.grant ?? []).some(
      ({ accessLevel, start, end }) =>
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
   * The grant an extension applies to, when it confers the requester active
   * access to the resource; otherwise `AccessNotActive`.
   */
  private async activeGrant(
    grant: AccessGrantId,
    requester: PersonId,
    resource: ResourceId,
  ): Promise<ActiveGrant> {
    const state: AccessGrant | undefined = await this.select(AccessGrantSchema, {}).findById(
      grant as never,
    );
    const { start, end, maximumLifetime } = state ?? {};
    if (
      state?.status !== AccessGrantStatus.ACTIVE ||
      !equals(PersonIdSchema, state.access?.grantee, requester) ||
      !equals(ResourceIdSchema, state.access?.resource, resource) ||
      start === undefined ||
      end === undefined ||
      maximumLifetime === undefined ||
      compare(now(), end) >= 0
    ) {
      throw AccessNotActive.create({ id: grant });
    }
    return { start, end, maximumLifetime };
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

  private durationExceedsMaximum(
    period: AccessPeriod,
    maximum: { seconds: bigint; nanos: number },
  ): boolean {
    const requested = this.durationOf(period);
    if (requested === undefined) {
      return false;
    }
    return (
      requested.seconds > maximum.seconds ||
      (requested.seconds === maximum.seconds && requested.nanos > maximum.nanos)
    );
  }

  private durationOf(period: AccessPeriod): { seconds: bigint; nanos: number } | undefined {
    if (period.kind.case === "immediateDuration") {
      return period.kind.value;
    }
    if (period.kind.case === "scheduled") {
      const start = period.kind.value.start;
      const end = period.kind.value.end;
      if (start === undefined || end === undefined) {
        return undefined;
      }
      return { seconds: end.seconds - start.seconds, nanos: end.nanos - start.nanos };
    }
    return undefined;
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

/** The period and lifetime limit of a grant that confers active access. */
interface ActiveGrant {
  readonly start: Timestamp;
  readonly end: Timestamp;
  readonly maximumLifetime: Duration;
}
