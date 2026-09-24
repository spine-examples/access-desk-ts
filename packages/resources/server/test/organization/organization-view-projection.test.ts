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

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  organizationId,
  resourcesBlackBox,
} from "../given/resources-context.js";
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
      expect(view?.member.map((member) => member.person?.uuid)).toEqual(["maya", "noah"]);
    });

    it("keep a member listed once when added again", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");

      expect((await addOrganizationMember(scope, "noah")).kind).toBe("ok");
      const [view] = await awaitOrganizationView(box, scope, (v) =>
        v.member.some((member) => member.person?.uuid === "noah"),
      );
      expect(view?.member.map((member) => member.person?.uuid)).toEqual(["maya", "noah"]);
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
      expect(view?.resource.map((resource) => resource.id?.uuid)).toEqual(["payroll", "ledger"]);
    });

    it("keep a resource listed once when recorded again", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await addResource(scope, "payroll")).kind).toBe("ok");
      expect((await addResource(scope, "payroll")).kind).toBe("ok");

      expect((await addResource(scope, "ledger")).kind).toBe("ok");
      const [view] = await awaitOrganizationView(box, scope, (v) =>
        v.resource.some((resource) => resource.id?.uuid === "ledger"),
      );
      expect(view?.resource.map((resource) => resource.id?.uuid)).toEqual(["payroll", "ledger"]);
    });
  });
});
