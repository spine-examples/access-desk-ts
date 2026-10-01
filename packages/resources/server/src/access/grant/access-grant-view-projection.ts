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

import { Projection, Subscribe } from "@spine-event-engine/server";
import type { AccessGrantId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { AccessGrantViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import type {
  AccessGrantCreated,
  AccessGrantExtended,
  AccessGrantRevoked,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";

/**
 * An access grant as its grantee and the resource's managers see it.
 */
export class AccessGrantViewProjection extends Projection<
  AccessGrantId,
  typeof AccessGrantViewSchema
> {
  /** Lists a newly issued grant. */
  @Subscribe
  onAccessGrantCreated(event: AccessGrantCreated): void {
    this.update((draft) => {
      draft.grantee = event.access?.grantee;
      draft.resource = event.access?.resource;
      draft.accessLevel = event.access?.accessLevel;
      draft.start = event.start;
      draft.end = event.end;
      draft.revoked = false;
      draft.request = event.request;
    });
  }

  /** Shows the new end of extended access, and the request that extended it. */
  @Subscribe
  onAccessGrantExtended(event: AccessGrantExtended): void {
    const { end, request } = event;
    this.update((draft) => {
      draft.end = end;
      if (request !== undefined) {
        draft.extension = [...draft.extension, request];
      }
    });
  }

  /** Shows the access as revoked. */
  @Subscribe
  onAccessGrantRevoked(_event: AccessGrantRevoked): void {
    this.update((draft) => (draft.revoked = true));
  }
}
