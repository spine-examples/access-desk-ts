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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";

import {
  AddOrganizationMemberSchema,
  AddResourceSchema,
  CreateOrganizationSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_commands_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";

import { organizationId, readAll } from "./resources-context.js";

/** Posts `CreateOrganization` for the tenant organization under the given name. */
export function createOrganization(scope: BlackBoxScope, name = "Acme") {
  return scope.post(
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: { uuid: organizationId }, name }),
  );
}

/** Posts `AddOrganizationMember` for the person with the given identifier. */
export function addOrganizationMember(scope: BlackBoxScope, person: string) {
  return scope.post(
    AddOrganizationMemberSchema,
    create(AddOrganizationMemberSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: person },
    }),
  );
}

/** Posts `AddResource`, recording the resource among the organization's resources. */
export function addResource(scope: BlackBoxScope, resource: string) {
  return scope.post(
    AddResourceSchema,
    create(AddResourceSchema, {
      organizationId: { uuid: organizationId },
      resourceId: { value: resource },
    }),
  );
}

/** Reads every `OrganizationView` in the organization's tenant. */
export function readOrganizationViews(scope: BlackBoxScope): Promise<readonly OrganizationView[]> {
  return readAll(scope, OrganizationViewSchema, "query-organization-view");
}

/** Waits until some `OrganizationView` satisfies the predicate, then returns all views. */
export function awaitOrganizationView(
  box: BlackBox,
  scope: BlackBoxScope,
  accept: (view: OrganizationView) => boolean,
): Promise<readonly OrganizationView[]> {
  return box.eventually(
    () => readOrganizationViews(scope),
    (views) => views.some(accept),
  );
}
