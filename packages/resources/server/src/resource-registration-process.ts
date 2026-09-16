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
  DeleteResourceSchema,
  type DeleteResource,
} from "@access-desk/resources-model/generated/access_desk/resources/commands_pb.js";
import { type RegisterResource } from "@access-desk/resources-model/generated/access_desk/resources/resource_registration_commands_pb.js";
import { type ResourceAdded } from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { type OrganizationResourceNameAlreadyUsed } from "@access-desk/resources-model/generated/access_desk/resources/organization_rejections_pb.js";
import {
  type ResourceCreated,
  type ResourceDeleted,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import {
  ResourceRegistrationRequestedSchema,
  type ResourceRegistrationRequested,
} from "@access-desk/resources-model/generated/access_desk/resources/resource_registration_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { ResourceRegistrationSchema } from "@access-desk/resources-model/generated/access_desk/resources/resource_registration_pb.js";
import { type ResourceAlreadyExists } from "@access-desk/resources-model/generated/access_desk/resources/rejections_pb.js";

/**
 * The registration of a new resource in an organization, step by step:
 *
 * 1. A member requests the resource, and the request is remembered here.
 * 2. The resource is created with the requested policy.
 * 3. The created resource is recorded among the organization's resources; the
 *    organization rejects the recording when the name is already used.
 * 4. If recording is rejected because the name is taken, the unchanged resource
 *    is deleted. A changed resource stops for manual resolution.
 * 5. The registration is complete and the process deletes itself after recording
 *    or deletion.
 */
export class ResourceRegistrationProcessManager extends ProcessManager<
  ResourceId,
  typeof ResourceRegistrationSchema,
  bigint
> {
  /**
   * Remembers a registration request and starts the process.
   */
  @Assign
  onRegisterResource(command: RegisterResource): ResourceRegistrationRequested {
    this.update((draft) => {
      Object.assign(
        draft,
        create(ResourceRegistrationSchema, {
          id: this.id,
          organizationId: command.organizationId,
          name: command.name,
          description: command.description,
          category: command.category,
          sensitivity: command.sensitivity,
          accessLevel: command.accessLevel,
          maximumDuration: command.maximumDuration,
          owner: command.owner,
          accessAdministrator: command.accessAdministrator,
          primaryApprover: command.primaryApprover,
          fallbackApprover: command.fallbackApprover,
        }),
      );
    });
    return create(ResourceRegistrationRequestedSchema, { id: this.id });
  }

  /**
   * Creates the resource with the requested policy once registration starts.
   */
  @Command
  onResourceRegistrationRequested(_event: ResourceRegistrationRequested): CreateResource {
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
      accessAdministrator: state.accessAdministrator,
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
   * Compensates a rejected organization recording by deleting the created resource.
   */
  @Command
  onOrganizationResourceNameAlreadyUsed(
    _rejection: OrganizationResourceNameAlreadyUsed,
  ): DeleteResource {
    return create(DeleteResourceSchema, { id: this.id });
  }

  /**
   * Abandons the registration when the resource already exists, deleting the process.
   */
  @Subscribe
  onResourceAlreadyExists(_rejection: ResourceAlreadyExists): void {
    if (this.isDeleted) {
      return;
    }
    this.markDraftDeleted();
  }

  /**
   * Completes and deletes the process once the resource belongs to the organization.
   */
  @Subscribe
  onResourceAdded(_event: ResourceAdded): void {
    if (this.isDeleted) {
      return;
    }
    this.markDraftDeleted();
  }

  /**
   * Completes compensation after the unrecorded resource is deleted.
   */
  @Subscribe
  onResourceDeleted(_event: ResourceDeleted): void {
    this.markDraftDeleted();
  }
}
