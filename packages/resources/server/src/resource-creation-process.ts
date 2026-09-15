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
import { Assign, Command, ProcessManager, Subscribe, Throws } from "@spine-event-engine/server";
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
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";
import { ResourceNameAlreadyUsed } from "@access-desk/resources-model/generated/access_desk/resources/rejections.js";
import { type ResourceAlreadyExists } from "@access-desk/resources-model/generated/access_desk/resources/rejections_pb.js";

/** Normalizes a resource name for case-insensitive within-organization comparison. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The creation of a new resource in an organization, step by step:
 *
 * 1. A member requests the resource. The request is admitted only when its name
 *    is not already used by another resource in the organization; otherwise it
 *    is rejected with {@link ResourceNameAlreadyUsed}.
 * 2. The resource is created with the requested policy.
 * 3. The created resource is recorded among the organization's resources.
 * 4. The creation is complete and the process deletes itself.
 */
export class ResourceCreationProcessManager extends ProcessManager<
  ResourceId,
  typeof ResourceCreationSchema,
  bigint
> {
  /**
   * Admits a creation request whose name is free within the organization.
   *
   * Reads the organization's own catalogue view to reject a name already used by
   * another resource before any resource is created. The read is eventually
   * consistent, so it is a best-effort guard rather than a strict lock.
   */
  @Assign
  @Throws(ResourceNameAlreadyUsed)
  async onRequestResourceCreation(
    command: RequestResourceCreation,
  ): Promise<ResourceCreationRequested> {
    const organizationId = command.organizationId;
    const organization = await this.select(OrganizationViewSchema, {}).findById(organizationId as never);
    const requestedName = normalizeName(command.name);
    const nameTaken =
      organization?.resource.some((resource) => normalizeName(resource.name) === requestedName) ??
      false;
    if (nameTaken) {
      throw ResourceNameAlreadyUsed.create({ id: this.id, name: command.name });
    }
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
   * Creates the resource with the requested policy once creation starts.
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
   * Records the created resource in its organization, carrying its display name.
   */
  @Command
  onResourceCreated(event: ResourceCreated): AddResource {
    return create(AddResourceSchema, {
      organizationId: this.state.organizationId,
      resourceId: event.id ?? this.id,
      name: this.state.name,
    });
  }

  /**
   * Abandons the creation when the resource already exists, deleting the process.
   */
  @Subscribe
  onResourceAlreadyExists(_rejection: ResourceAlreadyExists): void {
    this.markDraftDeleted();
  }

  /**
   * Completes and deletes the process once the resource belongs to the organization.
   */
  @Subscribe
  onResourceAdded(_event: ResourceAdded): void {
    this.markDraftDeleted();
  }
}
