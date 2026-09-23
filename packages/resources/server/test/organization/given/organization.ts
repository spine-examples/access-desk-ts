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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";

import {
  AddOrganizationMemberSchema,
  AddResourceSchema,
  CreateOrganizationSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

import { organizationId, readAll } from "../../given/resources-context.js";

/** Posts `CreateOrganization` for the tenant organization under the given name. */
export function createOrganization(scope: BlackBoxScope, name = "Acme") {
  return scope.post(
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: { uuid: organizationId }, name }),
  );
}

/** Posts `AddOrganizationMember` for the person with the given identifier and name. */
export function addOrganizationMember(scope: BlackBoxScope, person: string, name: string = person) {
  return scope.post(
    AddOrganizationMemberSchema,
    create(AddOrganizationMemberSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: person },
      name,
    }),
  );
}

/** Posts `AddResource`, recording the resource among the organization's resources. */
export function addResource(scope: BlackBoxScope, resource: string, name: string = resource) {
  return scope.post(
    AddResourceSchema,
    create(AddResourceSchema, {
      organizationId: { uuid: organizationId },
      resourceId: { uuid: resource },
      name,
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
