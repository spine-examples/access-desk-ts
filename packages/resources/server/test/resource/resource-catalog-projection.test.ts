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
  resourcesBlackBox,
} from "../given/resources-context.js";
import { awaitCatalogItem, closeResource, createResource, openResource } from "./given/resource.js";

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceCatalogProjection should", () => {
  describe("react on 'ResourceCreated', and", () => {
    it("start a catalog entry from the resource's creation fact", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      const item = await awaitCatalogItem(box, scope, "payroll");
      expect(item.id?.uuid).toBe("payroll");
      expect(item.name).toBe("payroll");
      expect(item.description).toBe("Payroll production");
      expect(item.category).toBe("application");
      expect(item.policy?.openForRequests).toBe(false);
      expect(item.policy?.manager.map((person) => person.uuid)).toEqual(["manager"]);
    });
  });

  describe("react on 'ResourceOpenedForRequests', and", () => {
    it("show the resource open", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      expect((await openResource(scope, "payroll")).kind).toBe("ok");

      const item = await awaitCatalogItem(
        box,
        scope,
        "payroll",
        (i) => i.policy?.openForRequests === true,
      );
      expect(item.policy?.openForRequests).toBe(true);
    });
  });

  describe("react on 'ResourceClosedForRequests', and", () => {
    it("show the resource closed", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      expect((await openResource(scope, "payroll")).kind).toBe("ok");
      await awaitCatalogItem(box, scope, "payroll", (i) => i.policy?.openForRequests === true);

      expect((await closeResource(scope, "payroll")).kind).toBe("ok");

      const item = await awaitCatalogItem(
        box,
        scope,
        "payroll",
        (i) => i.policy?.openForRequests === false,
      );
      expect(item.policy?.openForRequests).toBe(false);
    });
  });

  it("retain immutable fields across policy changes", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createResource(scope, "payroll")).kind).toBe("ok");

    expect((await openResource(scope, "payroll")).kind).toBe("ok");
    expect((await closeResource(scope, "payroll")).kind).toBe("ok");

    const item = await awaitCatalogItem(
      box,
      scope,
      "payroll",
      (i) => i.policy?.openForRequests === false,
    );
    // The creation-only fields survive every later policy event.
    expect(item.name).toBe("payroll");
    expect(item.description).toBe("Payroll production");
    expect(item.category).toBe("application");
    // The latest policy is in force, and the managers set at creation are retained.
    expect(item.policy?.manager.map((person) => person.uuid)).toEqual(["manager"]);
    expect(item.policy?.openForRequests).toBe(false);
  });
});
