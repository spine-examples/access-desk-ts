/*
 * Copyright 2026, TeamDev. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Redistribution and use in source and/or binary forms, with or without
 * modification, must retain the above copyright notice and the following
 * disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { create } from "@bufbuild/protobuf";
import { Assign, ProcessManager, Throws } from "@spine-event-engine/server";
import { equals } from "@access-desk/base/proto";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/access_desk/identity/identifiers_pb.js";
import {
  ResourceIdSchema,
  type ResourceId,
} from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import {
  type AccessLevel,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";
import { AccessRequestSchema } from "@access-desk/access-model/generated/access_desk/access/access_request_pb.js";
import { AccessRequestViewSchema } from "@access-desk/access-model/generated/access_desk/access/access_request_view_pb.js";
import {
  OrganizationMembershipSchema,
  ResourceRequestPolicySchema,
} from "@access-desk/access-model/generated/access_desk/access/resources_integration_pb.js";
import {
  AccessPeriodSchema,
  AccessRequestSnapshotSchema,
  AccessRequestStatus,
  type AccessPeriod,
  type AccessRequestSnapshot,
} from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import {
  AccessRequestIdSchema,
  type AccessRequestId,
} from "@access-desk/access-model/generated/access_desk/access/identifiers_pb.js";
import type {
  ApproveAccessRequest,
  CancelAccessRequest,
  DenyAccessRequest,
  SubmitAccessExtensionRequest,
  SubmitAccessRequest,
} from "@access-desk/access-model/generated/access_desk/access/access_request_commands_pb.js";
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
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import {
  AccessDurationTooLong,
  AccessLevelNotAvailable,
  DuplicateAccessRequest,
  ManagerNotEligible,
  NoManagersEligible,
  RequestAlreadyDecided,
  ResourceNotRequestable,
  SelfApprovalNotAllowed,
} from "@access-desk/access-model/generated/access_desk/access/access_request_rejections.js";

/**
 * One access request for a protected resource, driven from submission to a
 * terminal decision.
 *
 * 1. Validate a submission against the resource's request policy and the current
 *    membership, and capture the active managers who may decide it.
 * 2. Assign the accepted request to those managers for a decision.
 * 3. A manager approves or denies it, or the requester cancels it — once.
 *
 * A first-time request and an access-extension request differ only in what the
 * client submits and in the snapshot's `kind`; everything downstream is shared.
 */
export class AccessRequestProcessManager extends ProcessManager<
  AccessRequestId,
  typeof AccessRequestSchema,
  bigint
> {
  /** Validates a first-time access request and, when it passes, submits it. */
  @Assign
  @Throws(
    ResourceNotRequestable,
    AccessLevelNotAvailable,
    AccessDurationTooLong,
    DuplicateAccessRequest,
    NoManagersEligible,
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
    const candidateManager = await this.eligibleManagers(id, requester, policy);
    const snapshot = create(AccessRequestSnapshotSchema, {
      requester,
      justification: command.justification,
      kind: { case: "newRequest", value: { resource, accessLevel: level, period } },
    });
    this.store(snapshot, candidateManager);
    return create(AccessRequestSubmittedSchema, { id, snapshot, candidateManager });
  }

  /** Validates an access-extension request and, when it passes, submits it. */
  @Assign
  @Throws(ResourceNotRequestable, AccessDurationTooLong, NoManagersEligible)
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
      throw new Error("SubmitAccessExtensionRequest requires a requester, grant, duration, and resource.");
    }
    // An extension renews an existing grant: its level is implied by the grant, so
    // it is neither re-validated nor treated as a duplicate of a first-time request.
    const period = create(AccessPeriodSchema, {
      kind: { case: "immediateDuration", value: duration },
    });
    const policy = await this.requestablePolicy(id, resource);
    this.assertWithinMaxDuration(id, policy, period);
    const candidateManager = await this.eligibleManagers(id, requester, policy);
    const snapshot = create(AccessRequestSnapshotSchema, {
      requester,
      justification: command.justification,
      kind: { case: "extension", value: { grant, duration } },
    });
    this.store(snapshot, candidateManager);
    return create(AccessExtensionRequestSubmittedSchema, { id, snapshot, candidateManager });
  }

  /** Approves a request that has not yet been decided. */
  @Assign
  @Throws(RequestAlreadyDecided, SelfApprovalNotAllowed, ManagerNotEligible)
  approveAccessRequest(command: ApproveAccessRequest): AccessRequestApproved {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    const decidedBy = this.assertEligibleDecider(command.id, snapshot.requester, command.manager);
    this.update((draft) => {
      draft.status = AccessRequestStatus.APPROVED;
    });
    return create(AccessRequestApprovedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
      candidateManager: this.state.candidateManager,
    });
  }

  /** Denies a request, with a reason, when it has not yet been decided. */
  @Assign
  @Throws(RequestAlreadyDecided, SelfApprovalNotAllowed, ManagerNotEligible)
  denyAccessRequest(command: DenyAccessRequest): AccessRequestDenied {
    this.assertPending(command.id);
    const snapshot = this.requireSnapshot();
    const decidedBy = this.assertEligibleDecider(command.id, snapshot.requester, command.manager);
    this.update((draft) => {
      draft.status = AccessRequestStatus.DENIED;
    });
    return create(AccessRequestDeniedSchema, {
      id: this.id,
      snapshot,
      decidedBy,
      reason: command.reason,
      candidateManager: this.state.candidateManager,
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
      candidateManager: this.state.candidateManager,
    });
  }

  /** Stores the immutable request details and its eligible manager pool as pending. */
  private store(snapshot: AccessRequestSnapshot, candidateManager: readonly PersonId[]): void {
    this.update((draft) => {
      draft.id = this.id;
      draft.snapshot = snapshot;
      draft.candidateManager = [...candidateManager];
      draft.status = AccessRequestStatus.PENDING;
    });
  }

  /** The resource's current policy, or `ResourceNotRequestable` when it is closed. */
  private async requestablePolicy(
    id: AccessRequestId,
    resource: ResourceId,
  ): Promise<ResourcePolicy> {
    const policy = (await this.select(ResourceRequestPolicySchema, {}).findById(resource as never))
      ?.policy;
    if (!policy?.openForRequests) {
      throw ResourceNotRequestable.create({ id });
    }
    return policy;
  }

  /** The authoritative policy level matching the request, or `AccessLevelNotAvailable`. */
  private matchLevel(
    id: AccessRequestId,
    policy: ResourcePolicy,
    accessLevel: AccessLevel,
  ): AccessLevel {
    const requestedName = accessLevel.name.trim().toLocaleLowerCase();
    const level = policy.accessLevel.find(
      (candidate) =>
        candidate.name.trim().toLocaleLowerCase() === requestedName &&
        candidate.rank === accessLevel.rank,
    );
    if (level === undefined) {
      throw AccessLevelNotAvailable.create({ id });
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
      throw AccessDurationTooLong.create({ id });
    }
  }

  /** Rejects a first-time request when one is already pending for this requester and resource. */
  private async assertNoDuplicate(
    id: AccessRequestId,
    requester: PersonId,
    resource: ResourceId,
  ): Promise<void> {
    if (await this.hasPendingRequest(requester, resource, id)) {
      throw DuplicateAccessRequest.create({ id });
    }
  }

  /**
   * The resource's active managers eligible to decide the request.
   *
   * Deduplicates the policy managers, drops the requester (no self-approval), and
   * reads their membership in a single query; rejects an empty pool.
   */
  private async eligibleManagers(
    id: AccessRequestId,
    requester: PersonId,
    policy: ResourcePolicy,
  ): Promise<PersonId[]> {
    const managers: PersonId[] = [];
    const seen = new Set<string>();
    for (const manager of policy.manager) {
      if (equals(PersonIdSchema, manager, requester) || seen.has(manager.uuid)) {
        continue;
      }
      seen.add(manager.uuid);
      managers.push(manager);
    }
    const active = await this.activeMembers(managers);
    const candidateManager = managers.filter((manager) => active.has(manager.uuid));
    if (candidateManager.length === 0) {
      throw NoManagersEligible.create({ id });
    }
    return candidateManager;
  }

  /** Whether a first-time request for the same requester and resource is already pending. */
  private async hasPendingRequest(
    requester: PersonId,
    resource: ResourceId,
    thisRequest: AccessRequestId,
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
      // Only a first-time request names a resource; an extension implies it
      // through the grant, so it never duplicates a resource-scoped request.
      const requested =
        snapshot.kind.case === "newRequest" ? snapshot.kind.value.resource : undefined;
      return requested !== undefined && equals(ResourceIdSchema, requested, resource);
    });
  }

  /** Reads the membership of every candidate manager in a single query. */
  private async activeMembers(candidates: readonly PersonId[]): Promise<ReadonlySet<string>> {
    if (candidates.length === 0) {
      return new Set();
    }
    const memberships = await this.select(OrganizationMembershipSchema, {})
      .byId(...candidates.map((candidate) => candidate as never))
      .read();
    const active = new Set<string>();
    for (const membership of memberships) {
      if (membership.active && membership.id !== undefined) {
        active.add(membership.id.uuid);
      }
    }
    return active;
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
    requester: PersonId | undefined,
    decidedBy: PersonId | undefined,
  ): PersonId {
    if (decidedBy === undefined || decidedBy.uuid.trim() === "") {
      throw ManagerNotEligible.create({ id: id ?? this.id });
    }
    if (requester !== undefined && equals(PersonIdSchema, requester, decidedBy)) {
      throw SelfApprovalNotAllowed.create({ id: id ?? this.id });
    }
    if (!this.state.candidateManager.some((manager) => equals(PersonIdSchema, manager, decidedBy))) {
      throw ManagerNotEligible.create({ id: id ?? this.id });
    }
    return decidedBy;
  }
}
