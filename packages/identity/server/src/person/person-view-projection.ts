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
import type { PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type {
  PersonRegistered,
  SignInAccountAdded,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import type { InvitationAccepted } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/events_pb.js";
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";

/**
 * Each person who has signed in, with the accounts they sign in with and the
 * organizations they are a member of.
 */
export class PersonViewProjection extends Projection<PersonId, typeof PersonViewSchema> {
  /** Creates the view of a newly registered person. */
  @Subscribe
  onPersonRegistered(event: PersonRegistered): void {
    this.update((draft) => {
      draft.emailAddress = event.emailAddress;
      draft.name = event.name;
      draft.account = event.account === undefined ? [] : [event.account];
    });
  }

  /** Adds an account to the accounts the person signs in with. */
  @Subscribe
  onSignInAccountAdded(event: SignInAccountAdded): void {
    this.update((draft) => {
      if (event.account !== undefined) {
        draft.account.push(event.account);
      }
    });
  }

  /** Adds the organization whose invitation the person accepted to those they are a member of. */
  @Subscribe
  onInvitationAccepted(event: InvitationAccepted): void {
    const organization = event.id?.organization;
    if (organization === undefined) {
      return;
    }
    this.update((draft) => {
      if (!draft.organization.some((joined) => joined.uuid === organization.uuid)) {
        draft.organization.push(organization);
      }
    });
  }
}
