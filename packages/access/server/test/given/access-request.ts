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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";

import {
  ApproveAccessRequestSchema,
  CancelAccessRequestSchema,
  CreateAccessRequestSchema,
  DenyAccessRequestSchema,
} from "@access-desk/access-model/generated/access_desk/access/access_request_commands_pb.js";
import {
  AccessRequestSchema,
  type AccessRequest,
} from "@access-desk/access-model/generated/access_desk/access/access_request_pb.js";
import {
  AccessRequestSnapshotSchema,
  AccessRequestStatus,
} from "@access-desk/access-model/generated/access_desk/access/values_pb.js";

import { actor, readAll, resourceUuid } from "./access-context.js";

/** The requester used for a created request unless a spec names another. */
export const requesterId = actor;

/** The candidate manager eligible to decide a created request by default. */
export const managerId = "primary";

/** The descriptive and target fields of a first-time request snapshot. */
export interface RequestDetails {
  readonly requester: string;
  readonly justification: string;
  readonly resource: string;
  readonly accessLevel: { readonly name: string; readonly rank: number };
  readonly durationSeconds: bigint;
}

/** Builds an immutable first-time-request snapshot with sensible defaults. */
export function requestSnapshot(
  overrides: Partial<RequestDetails> = {},
): MessageShape<typeof AccessRequestSnapshotSchema> {
  const details: RequestDetails = {
    requester: requesterId,
    justification: "Need payroll review",
    resource: resourceUuid,
    accessLevel: { name: "Read", rank: 1 },
    durationSeconds: 60n,
    ...overrides,
  };
  return create(AccessRequestSnapshotSchema, {
    requester: { uuid: details.requester },
    justification: details.justification,
    kind: {
      case: "newRequest",
      value: {
        resource: { uuid: details.resource },
        accessLevel: details.accessLevel,
        period: { kind: { case: "immediateDuration", value: { seconds: details.durationSeconds } } },
      },
    },
  });
}

/** The fields that shape a `CreateAccessRequest` command. */
export interface CreateOptions extends Partial<RequestDetails> {
  /** The active managers eligible to decide the request; at least one. */
  readonly candidateManager?: readonly string[];
}

/**
 * Posts `CreateAccessRequest` directly to the aggregate.
 *
 * This bypasses the submission process manager, so the aggregate handler is
 * exercised on its own with an already-accepted snapshot and manager pool.
 */
export function createAccessRequest(scope: BlackBoxScope, id: string, options: CreateOptions = {}) {
  const { candidateManager = [managerId], ...details } = options;
  return scope.post(
    CreateAccessRequestSchema,
    create(CreateAccessRequestSchema, {
      id: { uuid: id },
      snapshot: requestSnapshot(details),
      candidateManager: candidateManager.map((uuid) => ({ uuid })),
    }),
  );
}

/** Creates a request and waits until it is stored and pending a decision. */
export async function givenCreatedRequest(
  box: BlackBox,
  scope: BlackBoxScope,
  id: string,
  options: CreateOptions = {},
): Promise<void> {
  await createAccessRequest(scope, id, options);
  await box.eventually(
    () => readAll(scope, AccessRequestSchema, `created-${id}`),
    (requests) =>
      requests.some((request) => request.id?.uuid === id && request.status === AccessRequestStatus.PENDING),
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
export function denyAccessRequest(scope: BlackBoxScope, id: string, manager: string, reason: string) {
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
export function readRequests(reader: BlackBoxScope): Promise<AccessRequest[]> {
  return readAll(reader, AccessRequestSchema, "requests");
}

/** The lifecycle status of one request, or `undefined` when it is absent. */
export async function statusOf(
  reader: BlackBoxScope,
  id: string,
): Promise<AccessRequestStatus | undefined> {
  const rows = await readRequests(reader);
  return rows.find((row) => row.id?.uuid === id)?.status;
}
