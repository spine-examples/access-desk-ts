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
import { Aggregate, Assign, Throws } from "@spine-event-engine/server";
import { type OrganizationId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import {
  type AddOrganizationMember,
  type AddResource,
  type CreateOrganization,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_commands_pb.js";
import {
  OrganizationCreatedSchema,
  OrganizationMemberAddedSchema,
  ResourceAddedSchema,
  type OrganizationCreated,
  type OrganizationMemberAdded,
  type ResourceAdded,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { OrganizationSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";
import {
  OrganizationMemberSchema,
  OrganizationResourceSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";
import {
  OrganizationAlreadyExists,
  OrganizationMemberAlreadyAdded,
  OrganizationResourceNameAlreadyUsed,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_rejections.js";

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
   * Makes a person an active member of the organization, at most once each.
   */
  @Assign
  @Throws(OrganizationMemberAlreadyAdded)
  addOrganizationMember(command: AddOrganizationMember): OrganizationMemberAdded {
    const person = command.person;
    if (person === undefined) {
      throw new Error("AddOrganizationMember requires a person.");
    }
    if (this.state.membership.some((item) => item.person?.uuid === person.uuid)) {
      throw OrganizationMemberAlreadyAdded.create({ organizationId: this.id, person });
    }
    this.update((draft) => {
      draft.membership = [
        ...draft.membership,
        create(OrganizationMemberSchema, { person, active: true }),
      ];
    });
    return create(OrganizationMemberAddedSchema, {
      organizationId: this.id,
      person,
      active: true,
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
    const existing = this.state.resource.find((reserved) => reserved.id?.uuid === resourceId.uuid);
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
