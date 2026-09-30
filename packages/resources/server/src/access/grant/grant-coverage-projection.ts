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
import { Projection, Subscribe } from "@spine-event-engine/server";
import {
  AccessGrantIdSchema,
  type AccessGrantId,
  type GrantCoverageId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  GrantCoverageSchema,
  GrantCoverage_CoveringGrantSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import type {
  AccessGrantCreated,
  AccessGrantExpired,
  AccessGrantExpiredBeforeActivation,
  AccessGrantExtended,
  AccessGrantRevoked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import { equals } from "../../proto/equals.js";

/**
 * The access one person holds, or is about to hold, to one resource.
 *
 * It lists every issued grant that has not yet ended, with its level and period.
 */
export class GrantCoverageProjection extends Projection<
  GrantCoverageId,
  typeof GrantCoverageSchema
> {
  /** Adds a newly issued grant to the person's access. */
  @Subscribe
  onAccessGrantCreated(event: AccessGrantCreated): void {
    const { id: grant, start, end } = event;
    const accessLevel = event.access?.accessLevel;
    if (
      grant === undefined ||
      accessLevel === undefined ||
      start === undefined ||
      end === undefined
    ) {
      return;
    }
    this.update((draft) => {
      draft.id = this.id;
      if (!draft.grant.some((covering) => equals(AccessGrantIdSchema, covering.id, grant))) {
        draft.grant = [
          ...draft.grant,
          create(GrantCoverage_CoveringGrantSchema, { id: grant, accessLevel, start, end }),
        ];
      }
    });
  }

  /** Moves the end of an extended grant. */
  @Subscribe
  onAccessGrantExtended(event: AccessGrantExtended): void {
    const { id: grant, end } = event;
    if (grant === undefined || end === undefined) {
      return;
    }
    this.update((draft) => {
      draft.grant = draft.grant.map((covering) =>
        equals(AccessGrantIdSchema, covering.id, grant)
          ? create(GrantCoverage_CoveringGrantSchema, { ...covering, end })
          : covering,
      );
    });
  }

  /** Drops a grant whose access has expired. */
  @Subscribe
  onAccessGrantExpired(event: AccessGrantExpired): void {
    this.drop(event.id);
  }

  /** Drops a grant whose access was revoked. */
  @Subscribe
  onAccessGrantRevoked(event: AccessGrantRevoked): void {
    this.drop(event.id);
  }

  /** Drops a grant whose access ended before it began. */
  @Subscribe
  onAccessGrantExpiredBeforeActivation(event: AccessGrantExpiredBeforeActivation): void {
    this.drop(event.id);
  }

  private drop(grant: AccessGrantId | undefined): void {
    if (grant === undefined) {
      return;
    }
    this.update((draft) => {
      draft.grant = draft.grant.filter(
        (covering) => !equals(AccessGrantIdSchema, covering.id, grant),
      );
    });
  }
}
