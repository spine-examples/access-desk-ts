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
import { Assign, Command, ProcessManager, React } from "@spine-event-engine/server";
import {
  AddResourceSchema,
  type AddResource,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_commands_pb.js";
import {
  CreateResourceSchema,
  type CreateResource,
  DeleteResourceSchema,
  type DeleteResource,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_commands_pb.js";
import { type RegisterResource } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import { type ResourceAdded } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_events_pb.js";
import { type OrganizationResourceNameAlreadyUsed } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_rejections_pb.js";
import {
  ResourceRegistrationRequestedSchema,
  type ResourceRegistrationRequested,
  ResourceRegisteredSchema,
  type ResourceRegistered,
  ResourceRegistrationFailedSchema,
  type ResourceRegistrationFailed,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";
import {
  type ResourceCreated,
  type ResourceDeleted,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_events_pb.js";
import { type ResourceId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { ResourceRegistrationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_pb.js";
import { type ResourceAlreadyExists } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_rejections_pb.js";

/**
 * The registration of a new resource in an organization, step by step:
 *
 * 1. A member requests the resource, and the request is remembered here.
 * 2. The resource is created with the requested policy.
 * 3. The created resource is recorded among the organization's resources; the
 *    organization rejects the recording when the name is already used.
 * 4. If recording is rejected because the name is taken, the created resource is
 *    deleted, undoing the half-completed registration.
 * 5. The process emits a registration result and deletes itself after recording
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
          manager: command.manager,
          accessLevel: command.accessLevel,
          maximumDuration: command.maximumDuration,
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
      manager: state.manager,
      accessLevel: state.accessLevel,
      maximumDuration: state.maximumDuration,
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
   * Announces failed registration and deletes the process when the resource already exists.
   */
  @React
  onResourceAlreadyExists(_rejection: ResourceAlreadyExists): ResourceRegistrationFailed {
    if (!this.isDeleted) {
      this.markDraftDeleted();
    }
    return create(ResourceRegistrationFailedSchema, { id: this.id });
  }

  /**
   * Announces successful registration and deletes the process once the resource belongs to the organization.
   */
  @React
  onResourceAdded(_event: ResourceAdded): ResourceRegistered {
    if (!this.isDeleted) {
      this.markDraftDeleted();
    }
    return create(ResourceRegisteredSchema, { id: this.id });
  }

  /**
   * Announces failed registration and deletes the process after the unrecorded resource is deleted.
   */
  @React
  onResourceDeleted(_event: ResourceDeleted): ResourceRegistrationFailed {
    if (!this.isDeleted) {
      this.markDraftDeleted();
    }
    return create(ResourceRegistrationFailedSchema, { id: this.id });
  }
}
