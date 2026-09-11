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
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  organizationId,
  resourcesBlackBox,
} from "./given/resources-context.js";
import {
  addOrganizationMember,
  addResource,
  awaitOrganizationView,
  createOrganization,
} from "./given/organization.js";

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("OrganizationViewProjection should", () => {
  describe("react on 'OrganizationCreated', and", () => {
    it("record the organization under its name", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      expect((await createOrganization(scope, "Acme")).kind).toBe("ok");

      const [view] = await awaitOrganizationView(box, scope, (v) => v.name === "Acme");
      expect(view?.id?.uuid).toBe(organizationId);
      expect(view?.name).toBe("Acme");
      expect(view?.member).toEqual([]);
      expect(view?.resource).toEqual([]);
    });
  });

  describe("react on 'OrganizationMemberAdded', and", () => {
    it("accumulate every member the organization gains", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "noah")).kind).toBe("ok");

      const [view] = await awaitOrganizationView(box, scope, (v) => v.member.length === 2);
      expect(view?.member.map((person) => person.uuid)).toEqual(["maya", "noah"]);
    });

    it("keep a member listed once when added again", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");

      expect((await addOrganizationMember(scope, "noah")).kind).toBe("ok");
      const [view] = await awaitOrganizationView(box, scope, (v) =>
        v.member.some((person) => person.uuid === "noah"),
      );
      expect(view?.member.map((person) => person.uuid)).toEqual(["maya", "noah"]);
    });
  });

  describe("react on 'ResourceAdded', and", () => {
    it("accumulate every resource the organization records", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await addResource(scope, "payroll")).kind).toBe("ok");
      expect((await addResource(scope, "ledger")).kind).toBe("ok");

      const [view] = await awaitOrganizationView(box, scope, (v) => v.resource.length === 2);
      expect(view?.resource.map((resource) => resource.value)).toEqual(["payroll", "ledger"]);
    });

    it("keep a resource listed once when recorded again", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await addResource(scope, "payroll")).kind).toBe("ok");
      expect((await addResource(scope, "payroll")).kind).toBe("ok");

      expect((await addResource(scope, "ledger")).kind).toBe("ok");
      const [view] = await awaitOrganizationView(box, scope, (v) =>
        v.resource.some((resource) => resource.value === "ledger"),
      );
      expect(view?.resource.map((resource) => resource.value)).toEqual(["payroll", "ledger"]);
    });
  });
});
