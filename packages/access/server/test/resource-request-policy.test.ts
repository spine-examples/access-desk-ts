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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ResourceCreatedSchema,
  ResourceOpenedForRequestsSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import { AccessLevel } from "@access-desk/resources-model/generated/access_desk/resources/access_level_pb.js";
import { Sensitivity } from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";
import {
  ResourceRequestPolicySchema,
  type ResourceRequestPolicy,
} from "@access-desk/access-model/generated/access_desk/access/resource_request_policy_pb.js";

import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  configureAccessEnvironment,
  loadAccessContext,
  readAll,
  resetAccessEnvironment,
} from "./given/access-context.js";
import {
  closeResourcesSources,
  openResourcesSource,
  publishResourceFact,
  resourcePolicy,
} from "./given/resources-integration.js";
import { type BlackBoxScope } from "@spine-event-engine/testing";

const resourceId = { value: "payroll" };

function readPolicies(scope: BlackBoxScope): Promise<readonly ResourceRequestPolicy[]> {
  return readAll(scope, ResourceRequestPolicySchema, "query-resource-request-policy");
}

// The Access read side never queries Resources back; it builds its model from the
// complete, versioned policy facts Resources publishes as external events.
beforeAll(loadAccessContext, 30_000);
beforeEach(configureAccessEnvironment);
afterEach(async () => {
  await closeAccessBlackBoxes();
  await closeResourcesSources();
  await resetAccessEnvironment();
});

describe("ResourceRequestPolicyProjection should", () => {
  it("build its policy read model from external Resources facts", async () => {
    const box = await accessBlackBox();
    const scope = box.onBehalfOf(actor);
    const source = await openResourcesSource();

    await publishResourceFact(source, ResourceCreatedSchema, {
      id: resourceId,
      name: "payroll",
      description: "Payroll production",
      category: "application",
      policy: resourcePolicy({ policyVersion: 1n }),
    });
    await publishResourceFact(source, ResourceOpenedForRequestsSchema, {
      id: resourceId,
      policy: resourcePolicy({ openForRequests: true, policyVersion: 2n }),
    });

    const rows = await box.eventually(
      () => readPolicies(scope),
      (candidate) => candidate[0]?.policy?.policyVersion === 2n,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource?.value).toBe("payroll");
    expect(rows[0]?.policy).toMatchObject({
      openForRequests: true,
      sensitivity: Sensitivity.RESTRICTED,
      policyVersion: 2n,
      owner: { uuid: "owner" },
      primaryApprover: { uuid: "primary" },
    });
    expect(rows[0]?.policy?.accessLevel).toEqual([AccessLevel.READ]);
  });
});
