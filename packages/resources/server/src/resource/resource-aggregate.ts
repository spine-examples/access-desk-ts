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
import { Aggregate, Assign, Throws } from "@spine-event-engine/server";
import {
  type CloseResourceForRequests,
  type CreateResource,
  type DeleteResource,
  type OpenResourceForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_commands_pb.js";
import {
  type ResourceClosedForRequests,
  ResourceClosedForRequestsSchema,
  type ResourceCreated,
  ResourceCreatedSchema,
  type ResourceDeleted,
  ResourceDeletedSchema,
  type ResourceOpenedForRequests,
  ResourceOpenedForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { ResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import {
  ResourceAlreadyClosedForRequests,
  ResourceAlreadyExists,
  ResourceAlreadyOpenForRequests,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_rejections.js";
import {
  ResourcePolicySchema,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

type PolicyChange = Partial<Omit<ResourcePolicy, "$typeName" | "$unknown">>;

/**
 * One resource and the access policy currently in force for it.
 *
 * Every change publishes the complete current policy.
 */
export class ResourceAggregate extends Aggregate<ResourceId, typeof ResourceSchema, bigint> {
  /**
   * Creates the initial closed policy.
   *
   * Name uniqueness is enforced by the Organization during resource registration.
   */
  @Assign
  @Throws(ResourceAlreadyExists)
  createResource(command: CreateResource): ResourceCreated {
    if (this.state.name !== "") {
      throw ResourceAlreadyExists.create({ id: this.id });
    }
    const policy = create(ResourcePolicySchema, {
      openForRequests: false,
      sensitivity: command.sensitivity,
      manager: command.manager,
      accessLevel: command.accessLevel,
      maximumDuration: command.maximumDuration,
    });
    this.update((draft) => {
      Object.assign(
        draft,
        create(ResourceSchema, {
          id: command.id,
          name: command.name,
          description: command.description,
          category: command.category,
          policy,
        }),
      );
    });
    return create(ResourceCreatedSchema, {
      id: this.id,
      name: command.name,
      description: command.description,
      category: command.category,
      policy,
    });
  }

  /** Deletes a resource, used to compensate a creation the organization rejected. */
  @Assign
  deleteResource(_command: DeleteResource): ResourceDeleted {
    this.markDraftDeleted();
    return create(ResourceDeletedSchema, { id: this.id });
  }

  /**
   * Opens the resource, rejecting the command when it is already open.
   */
  @Assign
  @Throws(ResourceAlreadyOpenForRequests)
  openResourceForRequests(_command: OpenResourceForRequests): ResourceOpenedForRequests {
    if (this.state.policy?.openForRequests === true) {
      throw ResourceAlreadyOpenForRequests.create({ id: this.id });
    }
    const policy = this.nextPolicy({ openForRequests: true });
    return create(ResourceOpenedForRequestsSchema, { id: this.id, policy });
  }

  /**
   * Closes the resource, rejecting the command when it is already closed.
   */
  @Assign
  @Throws(ResourceAlreadyClosedForRequests)
  closeResourceForRequests(_command: CloseResourceForRequests): ResourceClosedForRequests {
    if (this.state.policy?.openForRequests === false) {
      throw ResourceAlreadyClosedForRequests.create({ id: this.id });
    }
    const policy = this.nextPolicy({ openForRequests: false });
    return create(ResourceClosedForRequestsSchema, { id: this.id, policy });
  }

  private nextPolicy(change: PolicyChange): ResourcePolicy {
    const current = this.state.policy ?? create(ResourcePolicySchema, {});
    const policy = create(ResourcePolicySchema, {
      openForRequests: current.openForRequests,
      sensitivity: current.sensitivity,
      manager: current.manager,
      accessLevel: current.accessLevel,
      maximumDuration: current.maximumDuration,
      ...change,
    });
    this.update((draft) => (draft.policy = policy));
    return policy;
  }
}
