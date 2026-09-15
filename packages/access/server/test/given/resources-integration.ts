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

import { create, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { BlackBoxScope } from "@spine-event-engine/testing";

import {
  AccessLevelSchema,
  ResourcePolicySchema,
  Sensitivity,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";

/** The producer identity used when Resources publishes external facts to Access. */
export const resourcesSystemActor = "resources-system";

/** The complete access policy in force for a resource, restricted and read-only by default. */
export function resourcePolicy(
  overrides: Partial<Omit<ResourcePolicy, "$typeName" | "$unknown">> = {},
): ResourcePolicy {
  return create(ResourcePolicySchema, {
    openForRequests: false,
    sensitivity: Sensitivity.RESTRICTED,
    owner: { uuid: "owner" },
    accessLevel: [create(AccessLevelSchema, { name: "Read", rank: 1 })],
    maximumDuration: { seconds: 3600n },
    primaryApprover: { uuid: "primary" },
    fallbackApprover: { uuid: "fallback" },
    policyVersion: 1n,
    ...overrides,
  });
}

/** Posts one Resources fact through Access's external-event intake. */
export function publishResourceFact<Schema extends GenMessage<Message>>(
  scope: BlackBoxScope,
  schema: Schema,
  fact: MessageInitShape<Schema>,
): Promise<void> {
  return scope.postExternalEvent(schema, create(schema, fact));
}
