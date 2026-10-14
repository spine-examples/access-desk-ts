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
import type { MembershipId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { MemberAdded } from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";

/** Each email address added to an organization, with the person it belongs to. */
export class MembershipViewProjection extends Projection<
  MembershipId,
  typeof MembershipViewSchema
> {
  /** Creates the view of an address added to an organization. */
  @Subscribe
  onMemberAdded(event: MemberAdded): void {
    this.update((draft) => {
      draft.organization = event.organization;
      draft.role = event.role;
      draft.person = event.person;
    });
  }
}
