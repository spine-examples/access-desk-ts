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
  type ResourceClosedForRequests,
  type ResourceCreated,
  type ResourceDeleted,
  type ResourceOpenedForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
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
