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
import type { PersonId } from "@access-desk/identity-model/generated/access_desk/identity/identifiers_pb.js";
import type {
  AccessExtensionRequestSubmitted,
  AccessRequestApproved,
  AccessRequestCanceled,
  AccessRequestDenied,
  AccessRequestSubmitted,
} from "@access-desk/access-model/generated/access_desk/access/access_request_events_pb.js";

/**
 * Each access request as clients read it, from submission to a terminal decision.
 *
 * Built from the request's own lifecycle facts so a requester can list requests
 * and follow their status. A submitted request — first-time or extension — is
 * seeded as pending, and each terminal fact moves it to its outcome.
 */
export class AccessRequestViewProjection extends Projection<
  AccessRequestId,
  typeof AccessRequestViewSchema,
  bigint
> {
  /** Seeds a newly submitted first-time request as pending a decision. */
  @Subscribe
  onAccessRequestSubmitted(event: AccessRequestSubmitted): void {
    this.seedPending(event.snapshot, event.candidateManager);
  }

  /** Seeds a newly submitted extension request as pending a decision. */
  @Subscribe
  onAccessExtensionRequestSubmitted(event: AccessExtensionRequestSubmitted): void {
    this.seedPending(event.snapshot, event.candidateManager);
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
    candidateManager: readonly PersonId[],
  ): void {
    if (snapshot === undefined) {
      return;
    }
    this.update((draft) => {
      draft.id = this.id;
      draft.snapshot = snapshot;
      draft.candidateManager = [...candidateManager];
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
