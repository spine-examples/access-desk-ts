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
  resourcesBlackBox,
} from "./given/resources-context.js";
import {
  awaitCatalogItem,
  closeResource,
  createResource,
  openResource,
} from "./given/resource.js";

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
      expect(item.policy?.policyVersion).toBe(1n);
      expect(item.policy?.openForRequests).toBe(false);
      expect(item.policy?.manager.map((person) => person.uuid)).toEqual(["manager"]);
    });
  });

  describe("react on 'ResourceOpenedForRequests', and", () => {
    it("show the resource open at the next version", async () => {
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
      expect(item.policy?.policyVersion).toBe(2n);
    });
  });

  describe("react on 'ResourceClosedForRequests', and", () => {
    it("show the resource closed at the next version", async () => {
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
        (i) => i.policy?.policyVersion === 3n,
      );
      expect(item.policy?.openForRequests).toBe(false);
    });
  });

  it("advance the policy monotonically while retaining the immutable fields", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createResource(scope, "payroll")).kind).toBe("ok");

    expect((await openResource(scope, "payroll")).kind).toBe("ok");
    expect((await closeResource(scope, "payroll")).kind).toBe("ok");

    // Version 3: created (1) -> opened (2) -> closed (3).
    const item = await awaitCatalogItem(
      box,
      scope,
      "payroll",
      (i) => i.policy?.policyVersion === 3n,
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
