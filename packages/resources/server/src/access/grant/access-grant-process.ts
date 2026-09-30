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
import type { Duration } from "@bufbuild/protobuf/wkt";
import { Assign, Command, ProcessManager, Throws } from "@spine-event-engine/server";
import {
  PersonIdSchema,
  type PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { AccessGrantId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type {
  AccessExtension,
  NewAccessRequest,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import type { AccessRequestApproved } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import { AccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import {
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
  type CreateAccessGrant,
  type ExtendAccessGrant,
  type RevokeAccessGrant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
  type AccessGrantCreated,
  type AccessGrantExtended,
  type AccessGrantRevoked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  AccessGrantNotActive,
  NotResourceManager,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/rejections.js";
import { equals } from "../../proto/equals.js";
import { now } from "../../time/clock.js";
import { between, compare, longerThan } from "../../time/interval.js";
import { effectiveInterval, requestedInterval } from "../access-period.js";

/**
 * Access a person holds to a resource from its start until its end.
 *
 * An approved first-time request creates the grant for the access the approval
 * makes effective. The grant shares its identifier with that request. Each
 * approved extension request then moves the grant's end to the end it proposed,
 * never past the longest total access the resource permits.
 *
 * A manager of the resource may revoke the grant, with a reason, before its end.
 *
 * The grant gives access while it is not revoked and the current time is
 * within its period. Nothing changes when the period begins or ends. Extending
 * and revoking check the grant against the current time when they are handled.
 */
export class AccessGrantProcessManager extends ProcessManager<
  AccessGrantId,
  typeof AccessGrantSchema
> {
  /**
   * Gives an approved request its effect on the grant.
   *
   * An approved first-time request creates the grant. An approved extension
   * request extends the grant it names.
   */
  @Command
  issueOnApproval(event: AccessRequestApproved): CreateAccessGrant | ExtendAccessGrant {
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

  /** Issues the grant from an approved first-time request, once. */
  @Assign
  createAccessGrant(command: CreateAccessGrant): AccessGrantCreated {
    if (this.state.start !== undefined) {
      throw new Error("An access grant is created once.");
    }
    const { request, access, start, end, approvedBy, manager } = command;
    if (start === undefined || end === undefined || compare(start, end) >= 0) {
      throw new Error("An access grant must end after it starts.");
    }
    this.update((draft) => {
      Object.assign(
        draft,
        create(AccessGrantSchema, {
          id: this.id,
          request,
          access,
          start,
          end,
          approvedBy,
          manager,
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
    });
  }

  /**
   * Moves the end of the access to the end an approved extension proposed.
   *
   * Only a grant that gives access now can be extended, so access revoked,
   * ended, or not yet begun is refused. The extension counts toward the longest
   * total access the resource permits, as its catalog entry tells it now. The
   * request was checked against the same limit when it was submitted.
   */
  @Assign
  @Throws(AccessGrantNotActive)
  async extendAccessGrant(command: ExtendAccessGrant): Promise<AccessGrantExtended> {
    if (!this.givesAccessNow()) {
      throw AccessGrantNotActive.create({ id: this.id });
    }
    const { start, end: previousEnd } = this.state;
    const end = command.end;
    const maximumLifetime = await this.maximumLifetime();
    if (start === undefined || previousEnd === undefined || end === undefined) {
      throw new Error("A grant and its extension must carry a complete period.");
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

  /**
   * Ends the access early, with a reason, on behalf of a manager of the resource.
   *
   * Access may be revoked before or after it begins, until its end. A grant
   * already revoked, or whose end has passed, is refused.
   */
  @Assign
  @Throws(NotResourceManager, AccessGrantNotActive)
  revokeAccessGrant(command: RevokeAccessGrant): AccessGrantRevoked {
    const revokedBy = this.assertManager(command.manager);
    if (this.state.revoked || this.hasEnded()) {
      throw AccessGrantNotActive.create({ id: this.id });
    }
    this.update((draft) => {
      draft.revoked = true;
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
   * The grant for the access an approved first-time request grants.
   *
   * 1. Immediate access counts its duration from the approval.
   * 2. Scheduled access approved within its interval begins at the approval.
   * 3. Scheduled access approved before its start keeps its interval.
   * 4. Scheduled access approved after its end keeps its interval, so the grant
   *    never gives access.
   */
  private creation(event: AccessRequestApproved, request: NewAccessRequest): CreateAccessGrant {
    const approvedAt = event.whenDecided;
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
      id: this.id,
      request: event.id,
      access: { grantee: event.snapshot?.requester, resource, accessLevel },
      start: interval.start,
      end: interval.end,
      approvedBy: event.decidedBy,
      manager: event.manager,
    });
  }

  /** The move of the grant's end to the end an approved extension request proposed. */
  private extension(event: AccessRequestApproved, extension: AccessExtension): ExtendAccessGrant {
    return create(ExtendAccessGrantSchema, {
      id: this.id,
      request: event.id,
      end: extension.proposedEnd,
    });
  }

  /**
   * The longest total access the resource of the grant permits, as its catalog
   * entry tells it now.
   */
  private async maximumLifetime(): Promise<Duration> {
    const resource = this.state.access?.resource;
    const maximum =
      resource === undefined
        ? undefined
        : (await this.select(ResourceCatalogItemSchema, {}).findById(resource as never))?.policy
            ?.maximumDuration;
    if (maximum === undefined) {
      throw new Error("The resource of an access grant must be in the catalog.");
    }
    return maximum;
  }

  /** Whether the grant gives access at the current time. */
  private givesAccessNow(): boolean {
    const { revoked, start } = this.state;
    return !revoked && start !== undefined && compare(start, now()) <= 0 && !this.hasEnded();
  }

  /** Whether the end of the grant's period has passed. */
  private hasEnded(): boolean {
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
