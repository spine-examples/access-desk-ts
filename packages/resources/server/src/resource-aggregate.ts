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

import {create} from "@bufbuild/protobuf";
import {Aggregate, Assign} from "@spine-event-engine/server";
import {
  type AssignResourceFallbackApprover,
  type AssignResourcePrimaryApprover,
  type CloseResourceForRequests,
  type CreateResource,
  type OpenResourceForRequests,
} from "@access-desk/resources-model/generated/access_desk/resources/commands_pb.js";
import {
  type ResourceClosedForRequests,
  ResourceClosedForRequestsSchema,
  type ResourceCreated,
  ResourceCreatedSchema,
  type ResourceFallbackApproverAssigned,
  ResourceFallbackApproverAssignedSchema,
  type ResourceOpenedForRequests,
  ResourceOpenedForRequestsSchema,
  type ResourcePrimaryApproverAssigned,
  ResourcePrimaryApproverAssignedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import {type ResourceId} from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import {ResourceSchema} from "@access-desk/resources-model/generated/access_desk/resources/resource_pb.js";
import {
  ResourcePolicySchema,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";

type PolicyChange = Partial<Omit<ResourcePolicy, "$typeName" | "$unknown" | "policyVersion">>;

/**
 * One resource and the access policy currently in force for it.
 *
 * Every change publishes the complete next policy at a strictly higher version.
 */
export class ResourceAggregate extends Aggregate<ResourceId, typeof ResourceSchema, bigint> {
  /**
   * Creates the initial closed policy at version one.
   *
   * Name uniqueness is enforced by the Resource-Creation process, not here.
   */
  @Assign
  createResource(command: CreateResource): ResourceCreated {
    const policy = create(ResourcePolicySchema, {
      openForRequests: false,
      sensitivity: command.sensitivity,
      owner: command.owner,
      accessLevel: command.accessLevel,
      maximumDuration: command.maximumDuration,
      primaryApprover: command.primaryApprover,
      fallbackApprover: command.fallbackApprover,
      policyVersion: 1n,
    });
    this.update((draft) => {
      Object.assign(draft, create(ResourceSchema, {
        id: command.id,
        name: command.name,
        description: command.description,
        category: command.category,
        policy
      }));
    });
    return create(ResourceCreatedSchema, {
      id: this.id,
      name: command.name,
      description: command.description,
      category: command.category,
      policy,
    });
  }

  /** Assigns a new primary approver and publishes the complete next policy. */
  @Assign
  assignResourcePrimaryApprover(
    command: AssignResourcePrimaryApprover,
  ): ResourcePrimaryApproverAssigned {
    const policy = this.nextPolicy({primaryApprover: command.approver});
    return create(ResourcePrimaryApproverAssignedSchema, {id: this.id, policy});
  }

  /** Assigns a new fallback approver and publishes the complete next policy. */
  @Assign
  assignResourceFallbackApprover(
    command: AssignResourceFallbackApprover,
  ): ResourceFallbackApproverAssigned {
    const policy = this.nextPolicy({fallbackApprover: command.approver});
    return create(ResourceFallbackApproverAssignedSchema, {id: this.id, policy});
  }

  /** Opens the resource. */
  @Assign
  openResourceForRequests(_command: OpenResourceForRequests): ResourceOpenedForRequests {
    const policy = this.nextPolicy({openForRequests: true});
    return create(ResourceOpenedForRequestsSchema, {id: this.id, policy});
  }

  /** Closes the resource. */
  @Assign
  closeResourceForRequests(_command: CloseResourceForRequests): ResourceClosedForRequests {
    const policy = this.nextPolicy({openForRequests: false});
    return create(ResourceClosedForRequestsSchema, {id: this.id, policy});
  }

  private nextPolicy(change: PolicyChange): ResourcePolicy {
    const current = this.state.policy ?? create(ResourcePolicySchema, {});
    const policy = create(ResourcePolicySchema, {
      openForRequests: current.openForRequests,
      sensitivity: current.sensitivity,
      owner: current.owner,
      accessLevel: current.accessLevel,
      maximumDuration: current.maximumDuration,
      primaryApprover: current.primaryApprover,
      fallbackApprover: current.fallbackApprover,
      ...change,
      policyVersion: current.policyVersion + 1n,
    });
    this.update((draft) => draft.policy = policy);
    return policy;
  }
}
