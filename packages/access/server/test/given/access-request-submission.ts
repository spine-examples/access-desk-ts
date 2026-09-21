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

import { create, type MessageShape } from "@bufbuild/protobuf";
import type { BlackBox, BlackBoxScope } from "@spine-event-engine/testing";
import { OrganizationMemberAddedSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { ResourceCreatedSchema } from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import {
  OrganizationMembershipSchema,
  ResourceRequestPolicySchema,
} from "@access-desk/access-model/generated/access_desk/access/resources_integration_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_submission_commands_pb.js";

import { actor, organizationId, readAll, resourceUuid } from "./access-context.js";
import { managerHasTask } from "./access-decision-assignment.js";
import { publishResourceFact, resourcePolicy, resourcesSystemActor } from "./resources-integration.js";

/** One organization member and their initial activity. */
export interface Member {
  readonly person: string;
  readonly active?: boolean;
}

/**
 * Seeds Access's local membership and policy facts for the resource, then waits
 * until both mirrored projections are visible.
 */
export async function seed(
  box: BlackBox,
  members: readonly (string | Member)[],
  options: { openForRequests?: boolean; policy?: Record<string, unknown> } = {},
): Promise<void> {
  const resources = box.onBehalfOf(resourcesSystemActor);
  const normalized = members.map((m) => (typeof m === "string" ? { person: m, active: true } : m));
  for (const member of normalized) {
    await resources.postExternalEvent(
      OrganizationMemberAddedSchema,
      create(OrganizationMemberAddedSchema, {
        organizationId: { uuid: organizationId },
        person: { uuid: member.person },
        active: member.active ?? true,
        membershipVersion: 1n,
        name: member.person,
      }),
    );
  }
  await publishResourceFact(resources, ResourceCreatedSchema, {
    id: { uuid: resourceUuid },
    name: "payroll",
    description: "Payroll",
    category: "system",
    policy: resourcePolicy({
      openForRequests: options.openForRequests ?? true,
      policyVersion: 1n,
      ...options.policy,
    }),
  });
  const scope = box.onBehalfOf(actor);
  await box.eventually(
    () => readAll(scope, OrganizationMembershipSchema, "seed-members"),
    (items) => items.length === normalized.length,
  );
  await box.eventually(
    () => readAll(scope, ResourceRequestPolicySchema, "seed-policy"),
    (items) => items.length === 1,
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
  candidateManager: string | readonly string[],
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await requester.post(SubmitAccessRequestSchema, submitRequest(id, overrides));
  const managers: readonly string[] =
    typeof candidateManager === "string" ? [candidateManager] : candidateManager;
  await box.eventually(
    () => Promise.all(managers.map((manager) => managerHasTask(requester, manager, id))),
    (held) => held.every(Boolean),
    { timeoutMs: 20000, intervalMs: 50 },
  );
}
