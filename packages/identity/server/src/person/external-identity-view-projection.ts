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
import type { ExternalIdentityId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { ExternalIdentityLinked } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_events_pb.js";
import { ExternalIdentityViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";

/**
 * Each account people sign in with, and the person it belongs to.
 */
export class ExternalIdentityViewProjection extends Projection<
  ExternalIdentityId,
  typeof ExternalIdentityViewSchema
> {
  /** Creates the view of an account, with the person it was linked to. */
  @Subscribe
  onExternalIdentityLinked(event: ExternalIdentityLinked): void {
    this.update((draft) => {
      draft.id = event.id ?? this.id;
      if (event.person !== undefined) {
        draft.person = event.person;
      }
    });
  }
}
