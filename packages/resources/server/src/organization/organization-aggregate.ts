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
  ResourceIdSchema,
  type OrganizationId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { equals } from "../proto/equals.js";
import {
  type AddOrganizationMember,
  type AddResource,
  type CreateOrganization,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import {
  OrganizationCreatedSchema,
  OrganizationMemberAddedSchema,
  ResourceAddedSchema,
  type OrganizationCreated,
  type OrganizationMemberAdded,
  type ResourceAdded,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { OrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import {
  OrganizationMemberSchema,
  OrganizationResourceSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  OrganizationAlreadyExists,
  OrganizationMemberAlreadyAdded,
  OrganizationResourceNameAlreadyUsed,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections.js";

/**
 * One organization - the boundary that owns resources and members and within
 * which access to those resources is granted.
 */
export class OrganizationAggregate extends Aggregate<
  OrganizationId,
  typeof OrganizationSchema,
  bigint
> {
  /**
   * Brings the organization into existence, rejecting a second creation.
   */
  @Assign
  @Throws(OrganizationAlreadyExists)
  createOrganization(command: CreateOrganization): OrganizationCreated {
    if (this.state.name !== "") {
      throw OrganizationAlreadyExists.create({ id: this.id });
    }
    this.update((draft) => {
      Object.assign(draft, create(OrganizationSchema, { id: this.id, name: command.name }));
    });
    return create(OrganizationCreatedSchema, { id: this.id, name: command.name });
  }

  /**
   * Makes a person a member of the organization, at most once each.
   */
  @Assign
  @Throws(OrganizationMemberAlreadyAdded)
  addOrganizationMember(command: AddOrganizationMember): OrganizationMemberAdded {
    const person = command.person;
    if (person === undefined) {
      throw new Error("AddOrganizationMember requires a person.");
    }
    if (this.state.membership.some((item) => equals(PersonIdSchema, item.person, person))) {
      throw OrganizationMemberAlreadyAdded.create({ organizationId: this.id, person });
    }
    this.update((draft) => {
      draft.membership = [
        ...draft.membership,
        create(OrganizationMemberSchema, {
          person,
          name: command.name,
        }),
      ];
    });
    return create(OrganizationMemberAddedSchema, {
      organizationId: this.id,
      person,
      name: command.name,
    });
  }

  /**
   * Records a resource in this organization when its name is still available.
   */
  @Assign
  @Throws(OrganizationResourceNameAlreadyUsed)
  addResource(command: AddResource): ResourceAdded {
    const resourceId = command.resourceId;
    if (resourceId === undefined) {
      throw new Error("AddResource requires a resource id.");
    }
    const existing = this.state.resource.find((reserved) =>
      equals(ResourceIdSchema, reserved.id, resourceId),
    );
    if (existing === undefined) {
      const requestedName = normalizeName(command.name);
      const nameTaken = this.state.resource.some(
        (reserved) => normalizeName(reserved.name) === requestedName,
      );
      if (nameTaken) {
        throw OrganizationResourceNameAlreadyUsed.create({ resourceId, name: command.name });
      }
      this.update((draft) => {
        draft.resource = [
          ...draft.resource,
          create(OrganizationResourceSchema, { id: resourceId, name: command.name }),
        ];
      });
    }
    return create(ResourceAddedSchema, {
      resourceId,
      organizationId: this.id,
      name: command.name,
    });
  }
}

/** Normalizes a resource name for case-insensitive within-organization comparison. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
