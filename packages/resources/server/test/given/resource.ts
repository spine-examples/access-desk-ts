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
  CloseResourceForRequestsSchema,
  CreateResourceSchema,
  DeleteResourceSchema,
  OpenResourceForRequestsSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/commands_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/access_desk/resources/resource_registration_commands_pb.js";
import {
  ResourceCatalogueItemSchema,
  type ResourceCatalogueItem,
} from "@access-desk/resources-model/generated/access_desk/resources/resource_pb.js";
import {
  AccessLevelSchema,
  Sensitivity,
  type AccessLevel,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";

import { organizationId, readAll } from "./resources-context.js";

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

/** Reads every `ResourceCatalogueItem` in the organization's tenant. */
export function readCatalogue(scope: BlackBoxScope): Promise<readonly ResourceCatalogueItem[]> {
  return readAll(scope, ResourceCatalogueItemSchema, "query-resource-catalogue");
}

/** Waits until the catalogue item with the given id satisfies the predicate. */
export async function awaitCatalogueItem(
  box: BlackBox,
  scope: BlackBoxScope,
  resource: string,
  accept: (item: ResourceCatalogueItem) => boolean = () => true,
): Promise<ResourceCatalogueItem> {
  const matches = (item: ResourceCatalogueItem): boolean =>
    item.id?.uuid === resource && accept(item);
  const items = await box.eventually(
    () => readCatalogue(scope),
    (rows) => rows.some(matches),
  );
  const found = items.find(matches);
  if (found === undefined) {
    throw new Error(`Catalogue item "${resource}" not found.`);
  }
  return found;
}
