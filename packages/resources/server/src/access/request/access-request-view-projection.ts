/*
 * Copyright 2026, TeamDev. All rights reserved.
 * Licensed under the Apache License, Version 2.0.
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
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_events_pb.js";

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
