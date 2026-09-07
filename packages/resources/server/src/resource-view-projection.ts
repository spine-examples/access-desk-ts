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
  type ResourceClosedForRequests,
  type ResourceCreated,
  type ResourceFallbackApproverAssigned,
  type ResourceOpenedForRequests,
  type ResourcePrimaryApproverAssigned,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { ResourceCatalogueItemSchema } from "@access-desk/resources-model/generated/access_desk/resources/resource_pb.js";

type PolicyEvent =
  | ResourceCreated
  | ResourcePrimaryApproverAssigned
  | ResourceFallbackApproverAssigned
  | ResourceOpenedForRequests
  | ResourceClosedForRequests;

/**
 * The organization's catalogue of resources, each with the access rules
 * currently in force, answering catalogue and detail queries.
 */
export class ResourceCatalogueProjection extends Projection<
  ResourceId,
  typeof ResourceCatalogueItemSchema,
  bigint
> {
  /**
   * Starts a catalogue entry from the resource's complete creation fact.
   */
  @Subscribe
  onResourceCreated(event: ResourceCreated): void {
    this.apply(event, event.name, event.description, event.category);
  }

  /**
   * Updates the catalogue policy after the primary approver changes.
   */
  @Subscribe
  onResourcePrimaryApproverAssigned(event: ResourcePrimaryApproverAssigned): void {
    this.apply(event);
  }

  /**
   * Updates the catalogue policy after the fallback approver changes.\
   */
  @Subscribe
  onResourceFallbackApproverAssigned(event: ResourceFallbackApproverAssigned): void {
    this.apply(event);
  }

  /**
   * Updates the catalogue policy when the resource becomes requestable.
   */
  @Subscribe
  onResourceOpenedForRequests(event: ResourceOpenedForRequests): void {
    this.apply(event);
  }

  /**
   * Updates the catalogue policy when the resource stops accepting requests.
   */
  @Subscribe
  onResourceClosedForRequests(event: ResourceClosedForRequests): void {
    this.apply(event);
  }

  /**
   * Applies a complete policy fact without allowing an older version to roll back the view.
   *
   * Creation supplies the immutable catalogue fields; later events omit them and
   * intentionally retain their projected values.
   *
   * @param event The policy-bearing event to apply.
   * @param name The resource name when supplied by the creation event.
   * @param description The description when supplied by the creation event.
   * @param category The category when supplied by the creation event.
   */
  private apply(event: PolicyEvent, name?: string, description?: string, category?: string): void {
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
        create(ResourceCatalogueItemSchema, {
          id: event.id ?? this.id,
          name: name ?? this.state.name,
          description: description ?? this.state.description,
          category: category ?? this.state.category,
          policy,
        }),
      );
    });
  }
}
