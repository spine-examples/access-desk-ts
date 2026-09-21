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

import { type External, Projection, Subscribe } from "@spine-event-engine/server";
import type {
  OrganizationMemberActivated,
  OrganizationMemberAdded,
  OrganizationMemberDeactivated,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { OrganizationMembershipSchema } from "@access-desk/access-model/generated/access_desk/access/resources_integration_pb.js";
import type { PersonId } from "@access-desk/identity-model/generated/access_desk/identity/identifiers_pb.js";

/**
 * The current membership activity that Access can safely use without querying
 * Resources.
 */
export class OrganizationMembershipProjection extends Projection<
  PersonId,
  typeof OrganizationMembershipSchema,
  bigint
> {
  /** Records the initial active membership at revision one. */
  @Subscribe
  onOrganizationMemberAdded(event: External<OrganizationMemberAdded>): void {
    this.apply(event.person, event.active, event.membershipVersion);
  }

  /** Records a member becoming active at a complete newer revision. */
  @Subscribe
  onOrganizationMemberActivated(event: External<OrganizationMemberActivated>): void {
    this.apply(event.person, true, event.membershipVersion);
  }

  /** Records a member becoming inactive at a complete newer revision. */
  @Subscribe
  onOrganizationMemberDeactivated(event: External<OrganizationMemberDeactivated>): void {
    this.apply(event.person, false, event.membershipVersion);
  }

  private apply(
    person: OrganizationMemberAdded["person"],
    active: boolean,
    membershipVersion: bigint,
  ): void {
    if (person === undefined) {
      return;
    }
    if (this.state.id !== undefined && membershipVersion <= this.state.membershipVersion) {
      return;
    }
    this.update((draft) => {
      draft.active = active;
      draft.membershipVersion = membershipVersion;
    });
  }
}
