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
import { Assign, Command, ProcessManager, Subscribe } from "@spine-event-engine/server";
import {
  AddResourceSchema,
  type AddResource,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_commands_pb.js";
import {
  CreateResourceSchema,
  type CreateResource,
} from "@access-desk/resources-model/generated/access_desk/resources/commands_pb.js";
import { type RequestResourceCreation } from "@access-desk/resources-model/generated/access_desk/resources/resource_creation_commands_pb.js";
import { type ResourceAdded } from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { type ResourceCreated } from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import {
  ResourceCreationRequestedSchema,
  type ResourceCreationRequested,
} from "@access-desk/resources-model/generated/access_desk/resources/resource_creation_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { ResourceCreationSchema } from "@access-desk/resources-model/generated/access_desk/resources/resource_creation_pb.js";

/**
 * The introduction of a new resource into an organization, step by step:
 *
 * 1. A member requests the resource, and the request is stored.
 * 2. The resource is created with the requested policy.
 * 3. The created resource is recorded among the organization's resources.
 * 4. The process is complete and deletes itself.
 */
export class ResourceCreationProcessManager extends ProcessManager<
  ResourceId,
  typeof ResourceCreationSchema,
  bigint
> {
  /**
   * Stores the requested resource and its initial policy, then starts the process
   */
  @Assign
  onRequestResourceCreation(command: RequestResourceCreation): ResourceCreationRequested {
    // TODO:mykyta.pimonov:2026-09-07: Reject with `ResourceNameAlreadyUsed` if the name is already in use.
    this.update((draft) => {
      Object.assign(
        draft,
        create(ResourceCreationSchema, {
          id: this.id,
          organizationId: command.organizationId,
          name: command.name,
          description: command.description,
          category: command.category,
          sensitivity: command.sensitivity,
          accessLevel: command.accessLevel,
          maximumDuration: command.maximumDuration,
          owner: command.owner,
          primaryApprover: command.primaryApprover,
          fallbackApprover: command.fallbackApprover,
        }),
      );
    });
    return create(ResourceCreationRequestedSchema, { id: this.id });
  }

  /**
   * Creates the resource with the requested policy once the process starts.
   */
  @Command
  onResourceCreationRequested(_event: ResourceCreationRequested): CreateResource {
    const state = this.state;
    return create(CreateResourceSchema, {
      id: this.id,
      name: state.name,
      description: state.description,
      category: state.category,
      sensitivity: state.sensitivity,
      accessLevel: state.accessLevel,
      maximumDuration: state.maximumDuration,
      owner: state.owner,
      primaryApprover: state.primaryApprover,
      fallbackApprover: state.fallbackApprover,
    });
  }

  /**
   * Records the created resource in its organization.
   */
  @Command
  onResourceCreated(event: ResourceCreated): AddResource {
    return create(AddResourceSchema, {
      organizationId: this.state.organizationId,
      resourceId: event.id ?? this.id,
    });
  }

  /**
   * Completes and deletes the process once the resource belongs to the organization.
   */
  @Subscribe
  onResourceAdded(_event: ResourceAdded): void {
    this.markDraftDeleted();
  }
}
