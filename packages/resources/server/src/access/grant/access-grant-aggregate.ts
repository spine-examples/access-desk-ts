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
import type { AccessGrantId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AccessGrantSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import type {
  CreateAccessGrant,
  ExtendAccessGrant,
  RevokeAccessGrant,
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
import { compare } from "../../time/interval.js";

/**
 * Access a person holds to a resource from its start until its end.
 *
 * An approved first-time request creates the grant for the access the approval
 * makes effective. Each approved extension request then moves the grant's end
 * to the end it proposed.
 *
 * A manager of the resource may revoke the grant, with a reason, before its end.
 */
export class AccessGrantAggregate extends Aggregate<AccessGrantId, typeof AccessGrantSchema> {
  /** Issues the grant from an approved first-time request. */
  @Assign
  createAccessGrant(command: CreateAccessGrant): AccessGrantCreated {
    const { request, access, start, end, manager } = command;
    if (start === undefined || end === undefined || compare(start, end) >= 0) {
      throw new Error("An access grant must end after it starts.");
    }
    this.update((draft) => {
      Object.assign(
        draft,
        create(AccessGrantSchema, {
          id: this.id,
          access,
          start,
          end,
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
    });
  }

  /**
   * Moves the end of the access to the end an approved extension proposed.
   *
   * Only a grant that gives access now can be extended, so access revoked,
   * ended, or not yet begun is rejected.
   */
  @Assign
  @Throws(AccessGrantNotActive)
  extendAccessGrant(command: ExtendAccessGrant): AccessGrantExtended {
    if (!this.givesAccessNow()) {
      throw AccessGrantNotActive.create({ id: this.id });
    }
    const previousEnd = this.state.end;
    const end = command.end;
    if (previousEnd === undefined || end === undefined) {
      throw new Error("A grant and its extension must carry a complete period.");
    }
    if (compare(end, previousEnd) <= 0) {
      throw new Error("An approved extension moves the end of access later.");
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
   * already revoked, or whose end has passed, is rejected.
   */
  @Assign
  @Throws(NotResourceManager, AccessGrantNotActive)
  revokeAccessGrant(command: RevokeAccessGrant): AccessGrantRevoked {
    const manager = this.state.manager;
    const revokedBy = this.assertManager(command.manager, manager);
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
      manager,
    });
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

  /** The acting person, when they are among the managers of the grant's resource. */
  private assertManager(person: PersonId | undefined, managers: readonly PersonId[]): PersonId {
    if (
      person === undefined ||
      !managers.some((manager) => equals(PersonIdSchema, manager, person))
    ) {
      throw NotResourceManager.create({ id: this.id });
    }
    return person;
  }
}
