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

import { create, type MessageShape } from "@bufbuild/protobuf";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import {
  ApproveAccessRequestSchema,
  CancelAccessRequestSchema,
  DenyAccessRequestSchema,
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_commands_pb.js";
import {
  AccessRequestViewSchema,
  type AccessRequestView,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import { AccessRequestStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import { actor, organizationId, readAll } from "../../../given/resources-context.js";
import { managerHasTask } from "./access-decision-assignment.js";
import {
  addOrganizationMember,
  awaitOrganizationView,
  createOrganization,
} from "../../../organization/given/organization.js";
import {
  awaitCatalogItem,
  createResource,
  openResource,
  type ResourceDraft,
} from "../../../resource/given/resource.js";

/** The resource requested across the access-request tests. */
export const resourceUuid = "payroll";

/**
 * Seeds the organization, its members, and the requested resource with its
 * policy — all through real Resources commands — then waits until both the
 * organization membership and the resource catalog item are visible.
 *
 * The resource's manager defaults to `primary`. The resource is opened for
 * requests unless `openForRequests` is false.
 */
export async function seed(
  box: BlackBox,
  members: readonly string[],
  options: { openForRequests?: boolean; policy?: Partial<ResourceDraft> } = {},
): Promise<void> {
  const scope = box.onBehalfOf(actor);
  await createOrganization(scope);
  for (const member of members) {
    await addOrganizationMember(scope, member);
  }
  await createResource(scope, resourceUuid, {
    manager: [{ uuid: "primary" }],
    ...options.policy,
  });
  const open = options.openForRequests ?? true;
  if (open) {
    await openResource(scope, resourceUuid);
  }
  await awaitCatalogItem(
    box,
    scope,
    resourceUuid,
    (item) => (item.policy?.openForRequests ?? false) === open,
  );
  await awaitOrganizationView(
    box,
    scope,
    (view) => view.id?.uuid === organizationId && view.member.length >= members.length,
  );
}

/** Builds a `SubmitAccessRequest` with defaults for one immediate first-time request. */
export function submitRequest(
  id: string,
  overrides: Record<string, unknown> = {},
): MessageShape<typeof SubmitAccessRequestSchema> {
  return create(SubmitAccessRequestSchema, {
    id: { uuid: id },
    requester: { uuid: actor },
    resource: { uuid: resourceUuid },
    accessLevel: { name: "Read", rank: 1 },
    justification: "Need payroll review",
    period: { kind: { case: "immediateDuration", value: { seconds: 60n } } },
    ...overrides,
  });
}

/** Builds a `SubmitAccessExtensionRequest` renewing an existing grant. */
export function submitExtensionRequest(
  id: string,
  overrides: Record<string, unknown> = {},
): MessageShape<typeof SubmitAccessExtensionRequestSchema> {
  return create(SubmitAccessExtensionRequestSchema, {
    id: { uuid: id },
    requester: { uuid: actor },
    grant: { uuid: "grant-1" },
    resource: { uuid: resourceUuid },
    duration: { seconds: 120n },
    justification: "Keep payroll access a little longer",
    ...overrides,
  });
}

/** Submits a first-time request and waits until every named manager holds its task. */
export async function submitAndAssign(
  box: BlackBox,
  requester: BlackBoxScope,
  id: string,
  manager: string | readonly string[],
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await requester.post(SubmitAccessRequestSchema, submitRequest(id, overrides));
  const managers: readonly string[] = typeof manager === "string" ? [manager] : manager;
  await box.eventually(
    () => Promise.all(managers.map((manager) => managerHasTask(requester, manager, id))),
    (held) => held.every(Boolean),
    { timeoutMs: 20000, intervalMs: 50 },
  );
}

/** Posts `ApproveAccessRequest` naming `manager` as the deciding manager. */
export function approveAccessRequest(scope: BlackBoxScope, id: string, manager: string) {
  return scope.post(
    ApproveAccessRequestSchema,
    create(ApproveAccessRequestSchema, { id: { uuid: id }, manager: { uuid: manager } }),
  );
}

/** Posts `DenyAccessRequest` with a reason, naming `manager` as the deciding manager. */
export function denyAccessRequest(
  scope: BlackBoxScope,
  id: string,
  manager: string,
  reason: string,
) {
  return scope.post(
    DenyAccessRequestSchema,
    create(DenyAccessRequestSchema, { id: { uuid: id }, manager: { uuid: manager }, reason }),
  );
}

/** Posts `CancelAccessRequest` for the request. */
export function cancelAccessRequest(scope: BlackBoxScope, id: string) {
  return scope.post(
    CancelAccessRequestSchema,
    create(CancelAccessRequestSchema, { id: { uuid: id } }),
  );
}

/** Every access request visible to the reader. */
export function readRequests(reader: BlackBoxScope): Promise<AccessRequestView[]> {
  return readAll(reader, AccessRequestViewSchema, "requests");
}

/** The lifecycle status of one request, or `undefined` when it is absent. */
export async function statusOf(
  reader: BlackBoxScope,
  id: string,
): Promise<AccessRequestStatus | undefined> {
  const rows = await readRequests(reader);
  return rows.find((row) => row.id?.uuid === id)?.status;
}
