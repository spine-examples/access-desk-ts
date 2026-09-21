/*
 * Copyright 2026, TeamDev. All rights reserved.
 * Licensed under the Apache License, Version 2.0.
 */

import { create } from "@bufbuild/protobuf";
import { Aggregate, Assign, Throws } from "@spine-event-engine/server";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/access_desk/identity/identifiers_pb.js";
import { equals } from "@access-desk/base/proto";
import {
  AccessRequestStatus,
  type AccessRequestSnapshot,
} from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import { AccessRequestSchema } from "@access-desk/access-model/generated/access_desk/access/access_request_pb.js";
import type { AccessRequestId } from "@access-desk/access-model/generated/access_desk/access/identifiers_pb.js";
import type {
  ApproveAccessRequest,
  CancelAccessRequest,
  CreateAccessRequest,
  DenyAccessRequest,
} from "@access-desk/access-model/generated/access_desk/access/access_request_commands_pb.js";
import {
  AccessRequestApprovedSchema,
  AccessRequestCanceledSchema,
  AccessRequestCreatedSchema,
  AccessRequestDeniedSchema,
  type AccessRequestApproved,
  type AccessRequestCanceled,
  type AccessRequestCreated,
  type AccessRequestDenied,
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import {
  ManagerNotEligible,
  RequestAlreadyDecided,
  SelfApprovalNotAllowed,
} from "@access-desk/access-model/generated/access_desk/access/access_request_rejections.js";

/**
 * An immutable request for access to one protected resource.
 *
 * Once created, its details never change; a requester cancels and resubmits
 * instead. The request captures its eligible managers and reaches exactly one
 * terminal decision — approved, denied, or canceled. A regular access request
 * and an access-extension request share this lifecycle.
 */
export class AccessRequestAggregate extends Aggregate<
  AccessRequestId,
  typeof AccessRequestSchema,
  bigint
> {
  /** Records an accepted access request and its eligible manager pool. */
  @Assign
  createAccessRequest(command: CreateAccessRequest): AccessRequestCreated {
    const snapshot = this.record(command.snapshot, command.candidateManager);
    return create(AccessRequestCreatedSchema, {
      id: this.id,
      snapshot,
      candidateManager: command.candidateManager,
    });
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

  /** Stores the immutable request details and its pending manager pool. */
  private record(
    snapshot: AccessRequestSnapshot | undefined,
    candidateManager: readonly PersonId[],
  ): AccessRequestSnapshot {
    if (snapshot === undefined || candidateManager.length === 0) {
      throw new Error("Creating a request requires a snapshot and candidate managers.");
    }
    this.update((draft) => {
      draft.id = this.id;
      draft.snapshot = snapshot;
      draft.candidateManager = [...candidateManager];
      draft.status = AccessRequestStatus.PENDING;
    });
    return snapshot;
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
    if (
      !this.state.candidateManager.some((manager) => equals(PersonIdSchema, manager, decidedBy))
    ) {
      throw ManagerNotEligible.create({ id: id ?? this.id });
    }
    return decidedBy;
  }
}
