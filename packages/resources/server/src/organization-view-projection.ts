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

import { Projection, Subscribe } from "@spine-event-engine/server";
import { type OrganizationId } from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import {
  type OrganizationCreated,
  type OrganizationMemberAdded,
  type ResourceAdded,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";

/**
 * Each organization with its members and the resources it owns.
 */
export class OrganizationViewProjection extends Projection<
  OrganizationId,
  typeof OrganizationViewSchema,
  number
> {
  /**
   * Records one organization in the catalogue view.
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
      if (!draft.member.some((existing) => existing.uuid === person.uuid)) {
        draft.member = [...draft.member, person];
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
      if (!draft.resource.some((existing) => existing.value === resourceId.value)) {
        draft.resource = [...draft.resource, resourceId];
      }
    });
  }
}
