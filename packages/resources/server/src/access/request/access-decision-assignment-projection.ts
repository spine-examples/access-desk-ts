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
  AccessDecisionAssignmentSchema,
  AccessDecisionAssignment_AccessDecisionTaskSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import {
  AccessRequestIdSchema,
  type AccessRequestId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import type { AccessRequestSnapshot } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import type { PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type {
  AccessExtensionRequestSubmitted,
  AccessRequestApproved,
  AccessRequestCanceled,
  AccessRequestDenied,
  AccessRequestSubmitted,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import { equals } from "@access-desk/base/proto";

/**
 * One manager's queue of access requests awaiting their decision.
 *
 * Keyed by the manager; the organization is the tenant. A submitted request —
 * whether a first-time request or an extension — is added as a task carrying the
 * full request snapshot, for each of its eligible managers, and leaves every
 * manager's queue as soon as the request reaches a terminal decision.
 */
export class AccessDecisionAssignmentProjection extends Projection<
  PersonId,
  typeof AccessDecisionAssignmentSchema,
  bigint
> {
  /** Adds a newly submitted first-time request to this manager's decision queue. */
  @Subscribe
  onAccessRequestSubmitted(event: AccessRequestSubmitted): void {
    this.assign(event.id, event.snapshot);
  }

  /** Adds a newly submitted extension request to this manager's decision queue. */
  @Subscribe
  onAccessExtensionRequestSubmitted(event: AccessExtensionRequestSubmitted): void {
    this.assign(event.id, event.snapshot);
  }

  /** Clears an approved request from this manager's decision queue. */
  @Subscribe
  onAccessRequestApproved(event: AccessRequestApproved): void {
    this.close(event.id);
  }

  /** Clears a denied request from this manager's decision queue. */
  @Subscribe
  onAccessRequestDenied(event: AccessRequestDenied): void {
    this.close(event.id);
  }

  /** Clears a canceled request from this manager's decision queue. */
  @Subscribe
  onAccessRequestCanceled(event: AccessRequestCanceled): void {
    this.close(event.id);
  }

  private assign(
    request: AccessRequestId | undefined,
    snapshot: AccessRequestSnapshot | undefined,
  ): void {
    if (request === undefined || snapshot === undefined) {
      return;
    }
    this.update((draft) => {
      draft.id = this.id;
      if (!draft.task.some((task) => equals(AccessRequestIdSchema, task.request, request))) {
        draft.task = [
          ...draft.task,
          create(AccessDecisionAssignment_AccessDecisionTaskSchema, { request, snapshot }),
        ];
      }
    });
  }

  private close(request: AccessRequestId | undefined): void {
    if (request === undefined) {
      return;
    }
    this.update((draft) => {
      draft.task = draft.task.filter(
        (task) => !equals(AccessRequestIdSchema, task.request, request),
      );
    });
  }
}
