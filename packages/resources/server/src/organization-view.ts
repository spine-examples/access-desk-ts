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
import { Projection, Subscribe } from "@spine-event-engine/server";
import {
  OrganizationIdSchema,
  type OrganizationId,
} from "@access-desk/resources-model/generated/access_desk/resources/identifiers_pb.js";
import { type OrganizationCreated } from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";

/**
 * Builds the read-side view of each organization from Resources events.
 */
export class OrganizationViewProjection extends Projection<
  OrganizationId,
  typeof OrganizationViewSchema,
  number
> {
  /**
   * Records one organization in the catalogue view.
   *
   * @param event The event whose organization fields become the row state.
   */
  @Subscribe
  onOrganizationCreated(event: OrganizationCreated): void {
    const id = clone(OrganizationIdSchema, event.id ?? this.id);
    this.update((draft) => {
      Object.assign(draft, create(OrganizationViewSchema, { id, name: event.name }));
    });
  }
}
