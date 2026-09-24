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
  ResourceIdSchema,
  type OrganizationId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { equals } from "../proto/equals.js";
import {
  type OrganizationCreated,
  type OrganizationMemberAdded,
  type ResourceAdded,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import {
  OrganizationMemberSchema,
  OrganizationResourceSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

/**
 * Each organization with its members and the resources it owns.
 */
export class OrganizationViewProjection extends Projection<
  OrganizationId,
  typeof OrganizationViewSchema,
  bigint
> {
  /**
   * Records one organization in the catalog view.
   */
  @Subscribe
  onOrganizationCreated(event: OrganizationCreated): void {
    const id = event.id ?? this.id;
    this.update((draft) => {
      draft.id = id;
      draft.name = event.name;
    });
  }

  /**
   * Adds one member to the organization view.
   */
  @Subscribe
  onOrganizationMemberAdded(event: OrganizationMemberAdded): void {
    const person = event.person;
    if (person === undefined) {
      return;
    }
    this.update((draft) => {
      draft.id = event.organizationId ?? this.id;
      if (!draft.member.some((existing) => equals(PersonIdSchema, existing.person, person))) {
        draft.member = [
          ...draft.member,
          create(OrganizationMemberSchema, {
            person,
            name: event.name,
          }),
        ];
      }
    });
  }

  /**
   * Reflects a reserved resource in its organization's view.
   */
  @Subscribe
  onResourceAdded(event: ResourceAdded): void {
    const resourceId = event.resourceId;
    if (resourceId === undefined) {
      return;
    }
    this.update((draft) => {
      draft.id = event.organizationId ?? this.id;
      if (!draft.resource.some((existing) => equals(ResourceIdSchema, existing.id, resourceId))) {
        draft.resource = [
          ...draft.resource,
          create(OrganizationResourceSchema, { id: resourceId, name: event.name }),
        ];
      }
    });
  }
}
