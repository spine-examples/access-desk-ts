/*
 * Copyright 2026, TeamDev. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Redistribution and use in source and/or binary forms, with or without
 * modification, must retain the above copyright notice and the following
 * disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { create } from "@bufbuild/protobuf";
import { Projection, Subscribe } from "@spine-event-engine/server";
import {
  AccessDecisionAssignmentSchema,
  AccessDecisionAssignment_AccessDecisionTaskSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_decision_assignment_pb.js";
import {
  AccessRequestIdSchema,
  type AccessRequestId,
} from "@access-desk/access-model/generated/access_desk/access/identifiers_pb.js";
import type { AccessRequestSnapshot } from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import type { PersonId } from "@access-desk/identity-model/generated/access_desk/identity/identifiers_pb.js";
import type {
  AccessRequestApproved,
  AccessRequestCanceled,
  AccessRequestCreated,
  AccessRequestDenied,
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";
import { equals } from "@access-desk/base/proto";

/**
 * One manager's queue of access requests awaiting their decision.
 *
 * Keyed by the manager; the organization is the tenant. A created request —
 * whether a first-time request or an extension — is added as a task carrying the
 * full request snapshot, for each of its eligible managers, and leaves every
 * manager's queue as soon as the request reaches a terminal decision.
 */
export class AccessDecisionAssignmentProjection extends Projection<
  PersonId,
  typeof AccessDecisionAssignmentSchema,
  bigint
> {
  /** Adds a newly created request to this manager's decision queue. */
  @Subscribe
  onAccessRequestCreated(event: AccessRequestCreated): void {
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
