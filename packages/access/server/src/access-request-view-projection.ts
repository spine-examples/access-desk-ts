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

import { Projection, Subscribe } from "@spine-event-engine/server";
import { AccessRequestViewSchema } from "@access-desk/access-model/generated/access_desk/access/access_request_view_pb.js";
import {
  AccessRequestStatus,
  type AccessRequestSnapshot,
} from "@access-desk/access-model/generated/access_desk/access/values_pb.js";
import type { AccessRequestId } from "@access-desk/access-model/generated/access_desk/access/identifiers_pb.js";
import type {
  AccessRequestApproved,
  AccessRequestCanceled,
  AccessRequestCreated,
  AccessRequestDenied,
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";

/**
 * Each access request as clients read it, from submission to a terminal decision.
 *
 * Built from the request aggregate's own lifecycle facts so a requester can list
 * requests and follow their status without querying the aggregate. A created
 * request is seeded as pending, and each terminal fact moves it to its outcome.
 */
export class AccessRequestViewProjection extends Projection<
  AccessRequestId,
  typeof AccessRequestViewSchema,
  bigint
> {
  /** Seeds a newly created request as pending a decision. */
  @Subscribe
  onAccessRequestCreated(event: AccessRequestCreated): void {
    if (event.snapshot !== undefined) {
      this.update((draft) => {
        draft.id = this.id;
        draft.snapshot = event.snapshot;
        draft.candidateManager = [...event.candidateManager];
        draft.status = AccessRequestStatus.PENDING;
      });
    }
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
