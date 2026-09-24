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
import { AccessRequestViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  AccessRequestStatus,
  type AccessRequestSnapshot,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import type { AccessRequestId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type { PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type {
  AccessExtensionRequestSubmitted,
  AccessRequestApproved,
  AccessRequestCanceled,
  AccessRequestDenied,
  AccessRequestSubmitted,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";

/**
 * An access request as its requester follows it: the request and its status,
 * from submission to a terminal decision.
 */
export class AccessRequestViewProjection extends Projection<
  AccessRequestId,
  typeof AccessRequestViewSchema,
  bigint
> {
  /** Seeds a newly submitted first-time request as pending a decision. */
  @Subscribe
  onAccessRequestSubmitted(event: AccessRequestSubmitted): void {
    this.seedPending(event.snapshot, event.manager);
  }

  /** Seeds a newly submitted extension request as pending a decision. */
  @Subscribe
  onAccessExtensionRequestSubmitted(event: AccessExtensionRequestSubmitted): void {
    this.seedPending(event.snapshot, event.manager);
  }

  /** Records an approved request as its terminal outcome. */
  @Subscribe
  onAccessRequestApproved(event: AccessRequestApproved): void {
    this.settle(AccessRequestStatus.APPROVED, event.snapshot);
  }

  /** Records a denied request as its terminal outcome. */
  @Subscribe
  onAccessRequestDenied(event: AccessRequestDenied): void {
    this.settle(AccessRequestStatus.DENIED, event.snapshot);
  }

  /** Records a canceled request as its terminal outcome. */
  @Subscribe
  onAccessRequestCanceled(event: AccessRequestCanceled): void {
    this.settle(AccessRequestStatus.CANCELED, event.snapshot);
  }

  private seedPending(
    snapshot: AccessRequestSnapshot | undefined,
    manager: readonly PersonId[],
  ): void {
    if (snapshot === undefined) {
      return;
    }
    this.update((draft) => {
      draft.id = this.id;
      draft.snapshot = snapshot;
      draft.manager = [...manager];
      draft.status = AccessRequestStatus.PENDING;
    });
  }

  private settle(status: AccessRequestStatus, snapshot: AccessRequestSnapshot | undefined): void {
    this.update((draft) => {
      draft.id = this.id;
      if (snapshot !== undefined) {
        draft.snapshot = snapshot;
      }
      draft.status = status;
    });
  }
}
