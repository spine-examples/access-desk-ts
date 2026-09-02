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

import { clone, create } from "@bufbuild/protobuf";
import { Aggregate, Assign } from "@spine-event-engine/server";
import {
  OrganizationIdSchema,
  type OrganizationId,
} from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { type CreateOrganization } from "@access-desk/resources-model/generated/access_desk/resources/commands_pb.js";
import {
  OrganizationCreatedSchema,
  type OrganizationCreated,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import { OrganizationSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";

/**
 * Applies commands to one organization, identified by its `OrganizationId` —
 * which is also the tenant boundary this aggregate lives within.
 */
export class OrganizationAggregate extends Aggregate<
  OrganizationId,
  typeof OrganizationSchema,
  bigint
> {
  /**
   * Creates the organization and publishes the read-side input event.
   *
   * @param command The validated command carrying the organization name.
   * @returns The event that records the creation.
   */
  @Assign
  createOrganization(command: CreateOrganization): OrganizationCreated {
    const id = clone(OrganizationIdSchema, this.id);
    this.update((draft) => {
      Object.assign(draft, create(OrganizationSchema, { id, name: command.name }));
    });
    return create(OrganizationCreatedSchema, { id, name: command.name });
  }
}
