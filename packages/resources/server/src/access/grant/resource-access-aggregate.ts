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
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { Aggregate, Assign, Throws } from "@spine-event-engine/server";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AccessGrantIdSchema,
  type AccessGrantId,
  type ResourceAccessId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type { AccessLevel } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  ResourceAccessSchema,
  ResourceAccess_GrantSchema,
  type ResourceAccess_Grant as Grant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import type {
  CheckRequestedAccess,
  CheckRequestedExtension,
  CreateAccessGrant,
  ExtendAccessGrant,
  RevokeAccessGrant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
  RequestedAccessCheckedSchema,
  RequestedExtensionCheckedSchema,
  type AccessGrantCreated,
  type AccessGrantExtended,
  type AccessGrantRevoked,
  type RequestedAccessChecked,
  type RequestedExtensionChecked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantNotActive,
  NotResourceManager,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections.js";
import {
  AccessAlreadyHeld,
  RequestedDurationTooLong,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/rejections.js";
import { equals } from "../../proto/equals.js";
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
 * The access one person holds, or is about to hold, to one resource.
 *
 * It is made of grants. An approved first-time request creates a grant, and
 * each approved extension request moves a grant's end to the end it proposed.
 * A manager of the resource may revoke a grant, with a reason, before its end.
 *
 * A request for access the person already holds at the same or a stronger
 * level is refused when it is submitted. That check changes nothing here. Only
 * an approved request, or a revocation, changes the grants.
 *
 * Only grants that still give, or will give, access are kept. A grant that
 * ended or was revoked is forgotten.
 */
export class ResourceAccessAggregate extends Aggregate<
  ResourceAccessId,
  typeof ResourceAccessSchema
> {
  /**
   * Checks the access a first-time request asks for, without granting it.
   *
   * 1. The access must not last longer than the resource permits.
   * 2. The requester must not already hold the same or stronger access for any
   *    part of the period.
   */
  @Assign
  @Throws(RequestedDurationTooLong, AccessAlreadyHeld)
  checkRequestedAccess(command: CheckRequestedAccess): RequestedAccessChecked {
    const { request, accessLevel, start, end, maximumDuration } = command;
    if (
      accessLevel === undefined ||
      start === undefined ||
      end === undefined ||
      maximumDuration === undefined
    ) {
      throw new Error("Requested access must carry its level, period, and the maximum duration.");
    }
    if (longerThan(between(start, end), maximumDuration)) {
      throw RequestedDurationTooLong.create({ id: request });
    }
    if (this.holds(accessLevel, { start, end })) {
      throw AccessAlreadyHeld.create({ id: request });
    }
    return create(RequestedAccessCheckedSchema, { id: this.id, request });
  }

  /**
   * Checks the extension a request asks for, without extending the grant, and
   * tells the end the grant would then have.
   *
   * 1. The grant must give access now.
   * 2. The whole access, extension included, must fit the longest total access
   *    the resource permits.
   * 3. No other grant may give the same or stronger access for the added time.
   */
  @Assign
  @Throws(AccessGrantNotActive, RequestedDurationTooLong, AccessAlreadyHeld)
  checkRequestedExtension(command: CheckRequestedExtension): RequestedExtensionChecked {
    const { grant, request, duration, maximumDuration } = command;
    if (duration === undefined || maximumDuration === undefined) {
      throw new Error("A requested extension must carry its duration and the maximum duration.");
    }
    const held = this.activeGrant(grant);
    const proposedEnd = plus(held.end, duration);
    if (longerThan(between(held.start, proposedEnd), maximumDuration)) {
      throw RequestedDurationTooLong.create({ id: request });
    }
    if (this.holds(held.accessLevel, { start: held.end, end: proposedEnd }, grant)) {
      throw AccessAlreadyHeld.create({ id: request });
    }
    return create(RequestedExtensionCheckedSchema, { id: this.id, grant, request, proposedEnd });
  }

  /** Issues a grant from an approved first-time request. */
  @Assign
  createAccessGrant(command: CreateAccessGrant): AccessGrantCreated {
    const { grant, request, accessLevel, start, end, manager } = command;
    if (
      accessLevel === undefined ||
      start === undefined ||
      end === undefined ||
      compare(start, end) >= 0
    ) {
      throw new Error("An access grant must end after it starts.");
    }
    const created = create(ResourceAccess_GrantSchema, { id: grant, accessLevel, start, end });
    this.update((draft) => {
      draft.id = this.id;
      draft.manager = [...manager];
      draft.grant = [...this.grantsNotEnded(), created];
    });
    return create(AccessGrantCreatedSchema, {
      id: grant,
      request,
      access: this.accessOf(accessLevel),
      start,
      end,
    });
  }

  /**
   * Moves the end of a grant to the end an approved extension proposed.
   *
   * Only a grant that gives access now can be extended, so access revoked,
   * ended, or not yet begun is rejected.
   */
  @Assign
  @Throws(AccessGrantNotActive)
  extendAccessGrant(command: ExtendAccessGrant): AccessGrantExtended {
    const { grant, request, end } = command;
    const held = this.activeGrant(grant);
    const previousEnd = held.end;
    if (end === undefined) {
      throw new Error("An extension must carry the end it proposes.");
    }
    if (compare(end, previousEnd) <= 0) {
      throw new Error("An approved extension moves the end of access later.");
    }
    this.update((draft) => {
      draft.grant = this.grantsNotEnded().map((kept) =>
        equals(AccessGrantIdSchema, kept.id, grant)
          ? create(ResourceAccess_GrantSchema, { ...kept, end })
          : kept,
      );
    });
    return create(AccessGrantExtendedSchema, {
      id: grant,
      request,
      access: this.accessOf(held.accessLevel),
      previousEnd,
      end,
    });
  }

  /**
   * Ends a grant early, with a reason, on behalf of a manager of the resource.
   *
   * A grant may be revoked before or after it begins, until its end. A grant
   * already revoked, or whose end has passed, is rejected.
   */
  @Assign
  @Throws(NotResourceManager, AccessGrantNotActive)
  revokeAccessGrant(command: RevokeAccessGrant): AccessGrantRevoked {
    const { grant, reason } = command;
    const revokedBy = this.assertManager(command.manager, grant);
    const whenRevoked = now();
    const revoked = this.grantsNotEnded().find((kept) =>
      equals(AccessGrantIdSchema, kept.id, grant),
    );
    if (revoked === undefined) {
      throw AccessGrantNotActive.create({ id: grant });
    }
    this.update((draft) => {
      draft.grant = this.grantsNotEnded().filter(
        (kept) => !equals(AccessGrantIdSchema, kept.id, grant),
      );
    });
    return create(AccessGrantRevokedSchema, {
      id: grant,
      access: this.accessOf(revoked.accessLevel),
      revokedBy,
      reason,
      whenRevoked,
      manager: this.state.manager,
    });
  }

  /**
   * Whether a grant other than the excepted one gives the same or a stronger
   * access level for any part of the interval.
   */
  private holds(level: AccessLevel, interval: Interval, except?: AccessGrantId): boolean {
    return this.state.grant.some(
      ({ id, accessLevel, start, end }) =>
        !equals(AccessGrantIdSchema, id, except) &&
        accessLevel !== undefined &&
        start !== undefined &&
        end !== undefined &&
        accessLevel.rank >= level.rank &&
        overlaps({ start, end }, interval),
    );
  }

  /** The grant, when it gives access now, or `AccessGrantNotActive` otherwise. */
  private activeGrant(grant: AccessGrantId | undefined): ActiveGrant {
    const held = this.state.grant.find((kept) => equals(AccessGrantIdSchema, kept.id, grant));
    const { accessLevel, start, end } = held ?? {};
    const time = now();
    if (
      accessLevel === undefined ||
      start === undefined ||
      end === undefined ||
      compare(time, start) < 0 ||
      compare(time, end) >= 0
    ) {
      throw AccessGrantNotActive.create({ id: grant });
    }
    return { accessLevel, start, end };
  }

  /** The grants whose end has not passed. */
  private grantsNotEnded(): Grant[] {
    const time = now();
    return this.state.grant.filter(({ end }) => end !== undefined && compare(time, end) < 0);
  }

  /** The person, resource, and access level a grant gives access for. */
  private accessOf(accessLevel: AccessLevel | undefined) {
    return { grantee: this.id.grantee, resource: this.id.resource, accessLevel };
  }

  /** The acting person, when they are among the managers of the resource. */
  private assertManager(person: PersonId | undefined, grant: AccessGrantId | undefined): PersonId {
    if (
      person === undefined ||
      !this.state.manager.some((manager) => equals(PersonIdSchema, manager, person))
    ) {
      throw NotResourceManager.create({ id: grant });
    }
    return person;
  }
}

/** The level and period of a grant that gives access now. */
interface ActiveGrant {
  readonly accessLevel: AccessLevel;
  readonly start: Timestamp;
  readonly end: Timestamp;
}
