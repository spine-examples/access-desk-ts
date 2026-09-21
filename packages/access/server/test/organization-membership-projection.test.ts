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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  OrganizationMemberActivatedSchema,
  OrganizationMemberAddedSchema,
  OrganizationMemberDeactivatedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import {
  OrganizationMembershipSchema,
  type OrganizationMembership,
} from "@access-desk/access-model/generated/access_desk/access/resources_integration_pb.js";
import { type BlackBoxScope } from "@spine-event-engine/testing";
import {
  accessBlackBox,
  actor,
  closeAccessBlackBoxes,
  loadAccessContext,
  organizationId,
  readAll,
} from "./given/access-context.js";
import { publishResourceFact, resourcesSystemActor } from "./given/resources-integration.js";

function readMemberships(scope: BlackBoxScope): Promise<readonly OrganizationMembership[]> {
  return readAll(scope, OrganizationMembershipSchema, "query-organization-membership");
}

function member(person: string, active: boolean, membershipVersion: bigint) {
  return {
    organizationId: { uuid: organizationId },
    person: { uuid: person },
    active,
    membershipVersion,
    name: person,
  };
}

beforeAll(loadAccessContext, 30_000);
afterEach(closeAccessBlackBoxes);

describe("OrganizationMembershipProjection should", () => {
  it("record active and inactive added members separately", async () => {
    const box = await accessBlackBox();
    const scope = box.onBehalfOf(actor);
    const resourcesScope = box.onBehalfOf(resourcesSystemActor);

    await publishResourceFact(
      resourcesScope,
      OrganizationMemberAddedSchema,
      member("maya", true, 1n),
    );
    await publishResourceFact(
      resourcesScope,
      OrganizationMemberAddedSchema,
      member("noah", false, 1n),
    );

    const memberships = await box.eventually(
      () => readMemberships(scope),
      (rows) => rows.length === 2,
    );
    expect(
      memberships.some(
        (row) => row.id?.uuid === "maya" && row.active && row.membershipVersion === 1,
      ),
    ).toBe(true);
    expect(
      memberships.some(
        (row) => row.id?.uuid === "noah" && !row.active && row.membershipVersion === 1,
      ),
    ).toBe(true);
  });

  it("applies activation and deactivation in their membership revision order", async () => {
    const box = await accessBlackBox();
    const scope = box.onBehalfOf(actor);
    const resourcesScope = box.onBehalfOf(resourcesSystemActor);

    await publishResourceFact(
      resourcesScope,
      OrganizationMemberAddedSchema,
      member("maya", false, 1n),
    );
    await box.eventually(
      () => readMemberships(scope),
      (rows) =>
        rows.some((row) => row.id?.uuid === "maya" && !row.active && row.membershipVersion === 1),
    );

    await publishResourceFact(resourcesScope, OrganizationMemberActivatedSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: "maya" },
      membershipVersion: 2n,
    });
    await box.eventually(
      () => readMemberships(scope),
      (rows) =>
        rows.some((row) => row.id?.uuid === "maya" && row.active && row.membershipVersion === 2),
    );

    await publishResourceFact(resourcesScope, OrganizationMemberDeactivatedSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: "maya" },
      membershipVersion: 3n,
    });
    const memberships = await box.eventually(
      () => readMemberships(scope),
      (rows) =>
        rows.some((row) => row.id?.uuid === "maya" && !row.active && row.membershipVersion === 3),
    );
    expect(memberships.find((row) => row.id?.uuid === "maya")).toMatchObject({
      active: false,
      membershipVersion: 3,
    });
  });

  it("ignores stale and duplicate activity facts after their delivery is fenced", async () => {
    const box = await accessBlackBox();
    const scope = box.onBehalfOf(actor);
    const resourcesScope = box.onBehalfOf(resourcesSystemActor);

    await publishResourceFact(
      resourcesScope,
      OrganizationMemberAddedSchema,
      member("maya", true, 1n),
    );
    await box.eventually(
      () => readMemberships(scope),
      (rows) =>
        rows.some((row) => row.id?.uuid === "maya" && row.active && row.membershipVersion === 1),
    );
    await publishResourceFact(resourcesScope, OrganizationMemberDeactivatedSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: "maya" },
      membershipVersion: 2n,
    });
    await box.eventually(
      () => readMemberships(scope),
      (rows) =>
        rows.some((row) => row.id?.uuid === "maya" && !row.active && row.membershipVersion === 2),
    );

    await publishResourceFact(resourcesScope, OrganizationMemberActivatedSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: "maya" },
      membershipVersion: 1n,
    });
    await publishResourceFact(resourcesScope, OrganizationMemberActivatedSchema, {
      organizationId: { uuid: organizationId },
      person: { uuid: "maya" },
      membershipVersion: 2n,
    });
    await publishResourceFact(
      resourcesScope,
      OrganizationMemberAddedSchema,
      member("delivery-fence", true, 1n),
    );

    const memberships = await box.eventually(
      () => readMemberships(scope),
      (rows) =>
        rows.some((row) => row.id?.uuid === "delivery-fence" && row.membershipVersion === 1),
    );
    expect(memberships.find((row) => row.id?.uuid === "maya")).toMatchObject({
      active: false,
      membershipVersion: 2,
    });
  });
});
