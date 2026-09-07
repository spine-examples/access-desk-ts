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
import { type External, Projection, Subscribe } from "@spine-event-engine/server";
import {
  type ResourceClosedForRequests,
  type ResourceCreated,
  type ResourceFallbackApproverAssigned,
  type ResourceOpenedForRequests,
  type ResourcePrimaryApproverAssigned,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { ResourceRequestPolicySchema } from "@access-desk/access-model/generated/access_desk/access/resource_request_policy_pb.js";

type PolicyEvent =
  | ResourceCreated
  | ResourcePrimaryApproverAssigned
  | ResourceFallbackApproverAssigned
  | ResourceOpenedForRequests
  | ResourceClosedForRequests;

/**
 * Each resource's access rules as the Access context knows them, so it can
 * decide access requests without reaching back to Resources.
 *
 * Built only from {@link External} facts the Resources context publishes; a
 * stale or duplicate fact never rolls the rules back to an earlier version.
 */
export class ResourceRequestPolicyProjection extends Projection<
  ResourceId,
  typeof ResourceRequestPolicySchema,
  bigint
> {
  /**
   * Seeds Access's local policy from a resource creation fact.
   */
  @Subscribe
  onResourceCreated(event: External<ResourceCreated>): void {
    this.apply(event);
  }

  /**
   * Applies a newer complete policy after the primary approver changes.
   */
  @Subscribe
  onResourcePrimaryApproverAssigned(event: External<ResourcePrimaryApproverAssigned>): void {
    this.apply(event);
  }

  /**
   * Applies a newer complete policy after the fallback approver changes.
   */
  @Subscribe
  onResourceFallbackApproverAssigned(event: External<ResourceFallbackApproverAssigned>): void {
    this.apply(event);
  }

  /**
   * Applies a newer complete policy that permits new access requests.
   */
  @Subscribe
  onResourceOpenedForRequests(event: External<ResourceOpenedForRequests>): void {
    this.apply(event);
  }

  /**
   * Applies a newer complete policy that stops new access requests.
   */
  @Subscribe
  onResourceClosedForRequests(event: External<ResourceClosedForRequests>): void {
    this.apply(event);
  }

  /**
   * Stores a complete external policy only when it cannot regress this resource's version.
   *
   * Equal versions are accepted so replayed facts converge on the same state;
   * older versions are ignored to preserve monotonic consumer state.
   *
   * @param event The complete external policy fact to apply.
   */
  private apply(event: PolicyEvent): void {
    const policy = event.policy;
    if (
      policy === undefined ||
      (this.state.policy !== undefined && policy.policyVersion < this.state.policy.policyVersion)
    ) {
      return;
    }
    this.update((draft) => {
      Object.assign(
        draft,
        create(ResourceRequestPolicySchema, { resource: event.id ?? this.id, policy }),
      );
    });
  }
}
