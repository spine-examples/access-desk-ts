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

import { InvitationStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { Projection, Subscribe } from "@spine-event-engine/server";
import type { InvitationId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type {
  InvitationAccepted,
  InvitationDeclined,
  InvitationRevoked,
  MemberInvited,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/events_pb.js";
import { InvitationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/invitation_pb.js";

/**
 * Each invitation an organization has issued, and how far it has got.
 */
export class InvitationViewProjection extends Projection<
  InvitationId,
  typeof InvitationViewSchema
> {
  /** Creates the view of a newly issued invitation, as pending. */
  @Subscribe
  onMemberInvited(event: MemberInvited): void {
    this.update((draft) => {
      draft.id = event.id ?? this.id;
      draft.role = event.role;
      draft.status = InvitationStatus.INVITATION_PENDING;
    });
  }

  /** Marks the invitation as revoked. */
  @Subscribe
  onInvitationRevoked(_event: InvitationRevoked): void {
    this.update((draft) => {
      draft.status = InvitationStatus.INVITATION_REVOKED;
    });
  }

  /** Marks the invitation as accepted, and sets who accepted it. */
  @Subscribe
  onInvitationAccepted(event: InvitationAccepted): void {
    this.update((draft) => {
      draft.id = event.id ?? this.id;
      draft.status = InvitationStatus.INVITATION_ACCEPTED;
      if (event.person !== undefined) {
        draft.acceptedBy = event.person;
      }
    });
  }

  /** Marks the invitation as declined. */
  @Subscribe
  onInvitationDeclined(_event: InvitationDeclined): void {
    this.update((draft) => {
      draft.status = InvitationStatus.INVITATION_DECLINED;
    });
  }
}
