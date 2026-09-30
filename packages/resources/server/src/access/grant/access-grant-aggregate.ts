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
import { Aggregate, Assign, Throws } from "@spine-event-engine/server";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { type AccessGrantId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AccessGrantStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { AccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import type {
  ActivateAccessGrant,
  CreateAccessGrant,
  ExpireAccessGrant,
  ExtendAccessGrant,
  RevokeAccessGrant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessGrantActivatedSchema,
  AccessGrantCreatedSchema,
  AccessGrantExpiredSchema,
  AccessGrantExpiredBeforeActivationSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
  type AccessGrantActivated,
  type AccessGrantCreated,
  type AccessGrantExpired,
  type AccessGrantExpiredBeforeActivation,
  type AccessGrantExtended,
  type AccessGrantRevoked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantNotPending,
  AccessGrantNotActive,
  NotResourceManager,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections.js";
import { equals } from "../../proto/equals.js";
import { now } from "../../time/clock.js";
import { between, compare, longerThan } from "../../time/interval.js";

/**
 * Access a person holds to a resource, from its issue to its end.
 *
 * An approved request creates the grant. Access that begins later awaits the
 * scheduling of its start, and any other access awaits activation at once.
 *
 * The grant becomes active once its start has arrived. If its end has arrived
 * first, the grant expires before activation and the person never holds the
 * access.
 *
 * The grant ends exactly once. It expires at its planned end, or a manager of the
 * resource revokes it earlier with a reason.
 *
 * While the grant is active, an approved extension request may move its end, but
 * never past the longest total access the resource permits.
 */
export class AccessGrantAggregate extends Aggregate<AccessGrantId, typeof AccessGrantSchema> {
  /** Issues the grant from an approved request. */
  @Assign
  createAccessGrant(command: CreateAccessGrant): AccessGrantCreated {
    const { request, access, start, end, maximumLifetime, approvedBy, manager } = command;
    if (start === undefined || end === undefined || compare(start, end) >= 0) {
      throw new Error("An access grant must end after it starts.");
    }
    const status =
      compare(now(), start) < 0
        ? AccessGrantStatus.PENDING_SCHEDULING
        : AccessGrantStatus.PENDING_ACTIVATION;
    this.update((draft) => {
      Object.assign(
        draft,
        create(AccessGrantSchema, {
          id: this.id,
          request,
          access,
          start,
          end,
          maximumLifetime,
          approvedBy,
          manager,
          status,
        }),
      );
    });
    return create(AccessGrantCreatedSchema, {
      id: this.id,
      request,
      access,
      start,
      end,
      approvedBy,
      manager,
      status,
    });
  }

  /**
   * Activates the grant once its start has arrived.
   *
   * A grant whose end arrived before its activation ends without ever being
   * active.
   *
   * An activation sent again, or after the grant has ended, is rejected.
   */
  @Assign
  @Throws(AccessGrantNotPending)
  activateAccessGrant(
    _command: ActivateAccessGrant,
  ): AccessGrantActivated | AccessGrantExpiredBeforeActivation {
    const { status, start } = this.state;
    if (
      (status !== AccessGrantStatus.PENDING_ACTIVATION &&
        status !== AccessGrantStatus.PENDING_SCHEDULING) ||
      start === undefined
    ) {
      throw AccessGrantNotPending.create({ id: this.id });
    }
    if (compare(now(), start) < 0) {
      throw new Error("A grant's access is activated only once its start has arrived.");
    }
    if (this.hasReachedEnd()) {
      this.update((draft) => {
        draft.status = AccessGrantStatus.EXPIRED_BEFORE_ACTIVATION;
      });
      return this.expiredBeforeActivation();
    }
    this.update((draft) => {
      draft.status = AccessGrantStatus.ACTIVE;
    });
    return create(AccessGrantActivatedSchema, {
      id: this.id,
      access: this.state.access,
      start,
      end: this.state.end,
    });
  }

  /**
   * Ends active access once its planned end has arrived.
   *
   * An expiration sent again, or sent after the grant has ended, is rejected.
   */
  @Assign
  @Throws(AccessGrantNotActive)
  expireAccessGrant(_command: ExpireAccessGrant): AccessGrantExpired {
    if (this.state.status !== AccessGrantStatus.ACTIVE) {
      throw AccessGrantNotActive.create({ id: this.id });
    }
    if (!this.hasReachedEnd()) {
      throw new Error("A grant's access expires only once its end has arrived.");
    }
    this.update((draft) => {
      draft.status = AccessGrantStatus.EXPIRED;
    });
    return create(AccessGrantExpiredSchema, {
      id: this.id,
      access: this.state.access,
      end: this.state.end,
      manager: this.state.manager,
    });
  }

  /**
   * Ends access early on behalf of a manager of the resource.
   *
   * Both active access and access that has yet to begin may be revoked.
   */
  @Assign
  @Throws(NotResourceManager, AccessGrantNotActive)
  revokeAccessGrant(command: RevokeAccessGrant): AccessGrantRevoked {
    const revokedBy = this.assertManager(command.manager);
    const status = this.state.status;
    if (
      (status !== AccessGrantStatus.ACTIVE && status !== AccessGrantStatus.PENDING_SCHEDULING) ||
      this.hasReachedEnd()
    ) {
      throw AccessGrantNotActive.create({ id: this.id });
    }
    this.update((draft) => {
      draft.status = AccessGrantStatus.REVOKED;
    });
    return create(AccessGrantRevokedSchema, {
      id: this.id,
      access: this.state.access,
      revokedBy,
      reason: command.reason,
      whenRevoked: now(),
      manager: this.state.manager,
    });
  }

  /**
   * Moves the end of active access to the end an approved extension proposed.
   *
   * The extension counts toward the longest total access the resource permits,
   * as checked when it was requested. Access that ended while the extension
   * awaited approval is refused.
   */
  @Assign
  @Throws(AccessGrantNotActive)
  extendAccessGrant(command: ExtendAccessGrant): AccessGrantExtended {
    if (this.state.status !== AccessGrantStatus.ACTIVE || this.hasReachedEnd()) {
      throw AccessGrantNotActive.create({ id: this.id });
    }
    const previousEnd = this.state.end;
    const { start, maximumLifetime } = this.state;
    const end = command.end;
    if (
      start === undefined ||
      previousEnd === undefined ||
      maximumLifetime === undefined ||
      end === undefined
    ) {
      throw new Error("An active grant and its extension must carry a complete period.");
    }
    if (compare(end, previousEnd) <= 0) {
      throw new Error("An approved extension moves the end of access later.");
    }
    if (longerThan(between(start, end), maximumLifetime)) {
      throw new Error("An approved extension keeps access within its maximum lifetime.");
    }
    this.update((draft) => {
      draft.end = end;
    });
    return create(AccessGrantExtendedSchema, {
      id: this.id,
      request: command.request,
      access: this.state.access,
      previousEnd,
      end,
    });
  }

  /** The fact that the grant ended before its access could begin. */
  private expiredBeforeActivation(): AccessGrantExpiredBeforeActivation {
    return create(AccessGrantExpiredBeforeActivationSchema, {
      id: this.id,
      access: this.state.access,
      start: this.state.start,
      end: this.state.end,
      manager: this.state.manager,
    });
  }

  /** Whether the grant's planned end has arrived. */
  private hasReachedEnd(): boolean {
    const end = this.state.end;
    return end !== undefined && compare(now(), end) >= 0;
  }

  /** The acting person, when they manage the resource the grant applies to. */
  private assertManager(person: PersonId | undefined): PersonId {
    if (
      person === undefined ||
      !this.state.manager.some((manager) => equals(PersonIdSchema, manager, person))
    ) {
      throw NotResourceManager.create({ id: this.id });
    }
    return person;
  }
}
