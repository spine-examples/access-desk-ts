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
  type ResourceDeleted,
  type ResourceOpenedForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";

type PolicyEvent = ResourceCreated | ResourceOpenedForRequests | ResourceClosedForRequests;

/**
 * The organization's catalog of resources, each with the access rules
 * currently in force, answering catalog and detail queries.
 */
export class ResourceCatalogProjection extends Projection<
  ResourceId,
  typeof ResourceCatalogItemSchema,
  bigint
> {
  /**
   * Starts a catalog entry from the resource's complete creation fact.
   */
  @Subscribe
  onResourceCreated(event: ResourceCreated): void {
    this.apply(event, event.name, event.description, event.category);
  }

  /** Removes a deleted resource from catalog queries. */
  @Subscribe
  onResourceDeleted(_event: ResourceDeleted): void {
    if (this.isDeleted) {
      return;
    }
    this.markDraftDeleted();
  }

  /**
   * Updates the catalog policy when the resource becomes requestable.
   */
  @Subscribe
  onResourceOpenedForRequests(event: ResourceOpenedForRequests): void {
    this.apply(event);
  }

  /**
   * Updates the catalog policy when the resource stops accepting requests.
   */
  @Subscribe
  onResourceClosedForRequests(event: ResourceClosedForRequests): void {
    this.apply(event);
  }

  /**
   * Applies a complete policy fact.
   *
   * Creation supplies the immutable catalog fields; later events omit them and
   * intentionally retain their projected values.
   *
   * @param event The policy-bearing event to apply.
   * @param name The resource name when supplied by the creation event.
   * @param description The description when supplied by the creation event.
   * @param category The category when supplied by the creation event.
   */
  private apply(event: PolicyEvent, name?: string, description?: string, category?: string): void {
    if (this.isDeleted) {
      return;
    }
    const policy = event.policy;
    if (policy === undefined) {
      return;
    }
    this.update((draft) => {
      Object.assign(
        draft,
        create(ResourceCatalogItemSchema, {
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
