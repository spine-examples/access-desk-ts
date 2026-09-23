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
  CloseResourceForRequestsSchema,
  CreateResourceSchema,
  DeleteResourceSchema,
  OpenResourceForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/commands_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import {
  ResourceCatalogItemSchema,
  type ResourceCatalogItem,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import {
  AccessLevelSchema,
  Sensitivity,
  type AccessLevel,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import { organizationId, readAll } from "../../given/resources-context.js";

/** The descriptive and policy fields shared by resource registration commands. */
export interface ResourceDraft {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly sensitivity: Sensitivity;
  readonly manager: { readonly uuid: string }[];
  readonly accessLevel: AccessLevel[];
  readonly maximumDuration: { readonly seconds: bigint };
}

/** A restricted, read-only payroll resource used as the baseline in every spec. */
export function resourceDraft(overrides: Partial<ResourceDraft> = {}): ResourceDraft {
  return {
    name: "payroll",
    description: "Payroll production",
    category: "application",
    sensitivity: Sensitivity.RESTRICTED,
    manager: [{ uuid: "manager" }],
    accessLevel: [create(AccessLevelSchema, { name: "Read", rank: 1 })],
    maximumDuration: { seconds: 3600n },
    ...overrides,
  };
}

/** Posts `CreateResource` directly, bypassing the registration process. */
export function createResource(
  scope: BlackBoxScope,
  resource: string,
  overrides: Partial<ResourceDraft> = {},
) {
  return scope.post(
    CreateResourceSchema,
    create(CreateResourceSchema, { id: { uuid: resource }, ...resourceDraft(overrides) }),
  );
}

/** Posts `DeleteResource` to remove a resource during compensation. */
export function deleteResource(scope: BlackBoxScope, resource: string) {
  return scope.post(DeleteResourceSchema, create(DeleteResourceSchema, { id: { uuid: resource } }));
}

/**
 * Posts `RegisterResource`, the entry point of the registration process.
 *
 * The resource identifier and its display name are separate: `resource` is the
 * system-generated id, and `name` defaults to it but can differ, so two distinct
 * resources can be requested under the same name to exercise uniqueness.
 */
export function registerResource(
  scope: BlackBoxScope,
  resource: string,
  name: string = resource,
  overrides: Partial<ResourceDraft> = {},
) {
  return scope.post(
    RegisterResourceSchema,
    create(RegisterResourceSchema, {
      id: { uuid: resource },
      organizationId: { uuid: organizationId },
      ...resourceDraft({ name, ...overrides }),
    }),
  );
}

/** Posts `OpenResourceForRequests` for the resource. */
export function openResource(scope: BlackBoxScope, resource: string) {
  return scope.post(
    OpenResourceForRequestsSchema,
    create(OpenResourceForRequestsSchema, { id: { uuid: resource } }),
  );
}

/** Posts `CloseResourceForRequests` for the resource. */
export function closeResource(scope: BlackBoxScope, resource: string) {
  return scope.post(
    CloseResourceForRequestsSchema,
    create(CloseResourceForRequestsSchema, { id: { uuid: resource } }),
  );
}

/** Reads every `ResourceCatalogItem` in the organization's tenant. */
export function readCatalog(scope: BlackBoxScope): Promise<readonly ResourceCatalogItem[]> {
  return readAll(scope, ResourceCatalogItemSchema, "query-resource-catalog");
}

/** Waits until the catalog item with the given id satisfies the predicate. */
export async function awaitCatalogItem(
  box: BlackBox,
  scope: BlackBoxScope,
  resource: string,
  accept: (item: ResourceCatalogItem) => boolean = () => true,
): Promise<ResourceCatalogItem> {
  const matches = (item: ResourceCatalogItem): boolean =>
    item.id?.uuid === resource && accept(item);
  const items = await box.eventually(
    () => readCatalog(scope),
    (rows) => rows.some(matches),
  );
  const found = items.find(matches);
  if (found === undefined) {
    throw new Error(`Catalog item "${resource}" not found.`);
  }
  return found;
}
