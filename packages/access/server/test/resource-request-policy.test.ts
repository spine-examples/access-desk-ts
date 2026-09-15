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
  ResourceClosedForRequestsSchema,
  ResourceCreatedSchema,
  ResourceFallbackApproverAssignedSchema,
  ResourceOpenedForRequestsSchema,
  ResourcePrimaryApproverAssignedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import {
  Sensitivity,
  type ResourcePolicy,
} from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";
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
const dana = person("dana");
const erin = person("erin");

function person(uuid: string): NonNullable<ResourcePolicy["primaryApprover"]> {
  const defaultPerson = resourcePolicy().primaryApprover;
  if (defaultPerson === undefined) {
    throw new Error("The resource policy test fixture must include a primary approver.");
  }
  return { ...defaultPerson, uuid };
}

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
  it("builds its policy read model from every subscribed Resources policy fact", async () => {
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
    await publishResourceFact(source, ResourcePrimaryApproverAssignedSchema, {
      id: resourceId,
      policy: resourcePolicy({ primaryApprover: dana, policyVersion: 2n }),
    });
    await publishResourceFact(source, ResourceFallbackApproverAssignedSchema, {
      id: resourceId,
      policy: resourcePolicy({
        primaryApprover: dana,
        fallbackApprover: erin,
        policyVersion: 3n,
      }),
    });
    await publishResourceFact(source, ResourceOpenedForRequestsSchema, {
      id: resourceId,
      policy: resourcePolicy({
        primaryApprover: dana,
        fallbackApprover: erin,
        openForRequests: true,
        policyVersion: 4n,
      }),
    });
    await publishResourceFact(source, ResourceClosedForRequestsSchema, {
      id: resourceId,
      policy: resourcePolicy({
        primaryApprover: dana,
        fallbackApprover: erin,
        policyVersion: 5n,
      }),
    });

    const rows = await box.eventually(
      () => readPolicies(scope),
      (candidate) => candidate[0]?.policy?.policyVersion === 5n,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource?.value).toBe("payroll");
    expect(rows[0]?.policy).toMatchObject({
      openForRequests: false,
      sensitivity: Sensitivity.RESTRICTED,
      policyVersion: 5n,
      owner: { uuid: "owner" },
      primaryApprover: { uuid: "dana" },
      fallbackApprover: { uuid: "erin" },
    });
    expect(rows[0]?.policy?.accessLevel).toMatchObject([{ name: "Read", rank: 1 }]);
  });

  it("ignores stale facts and accepts an exact duplicate without changing its policy", async () => {
    const box = await accessBlackBox();
    const scope = box.onBehalfOf(actor);
    const source = await openResourcesSource();
    const closedPolicy = resourcePolicy({ openForRequests: false, policyVersion: 2n });

    await publishResourceFact(source, ResourceCreatedSchema, {
      id: resourceId,
      name: "payroll",
      description: "Payroll production",
      category: "application",
      policy: resourcePolicy({ openForRequests: true, policyVersion: 1n }),
    });
    await publishResourceFact(source, ResourceClosedForRequestsSchema, {
      id: resourceId,
      policy: closedPolicy,
    });
    await publishResourceFact(source, ResourceOpenedForRequestsSchema, {
      id: resourceId,
      policy: resourcePolicy({ openForRequests: true, policyVersion: 1n }),
    });
    await publishResourceFact(source, ResourceClosedForRequestsSchema, {
      id: resourceId,
      policy: closedPolicy,
    });

    const rows = await box.eventually(
      () => readPolicies(scope),
      (candidate) => candidate[0]?.policy?.policyVersion === 2n,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.policy).toMatchObject({ openForRequests: false, policyVersion: 2n });
  });
});
