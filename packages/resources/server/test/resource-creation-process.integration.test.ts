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

import { ResourceAddedSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { ResourceCreatedSchema } from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";
import { ResourceCreationRequestedSchema } from "@access-desk/resources-model/generated/access_desk/resources/resource_creation_events_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "./given/resources-context.js";
import { awaitCatalogueItem, requestResourceCreation } from "./given/resource.js";
import { awaitOrganizationView, createOrganization } from "./given/organization.js";
import { recordEvents } from "./given/events.js";

// The process manager is NONE-visibility, so it is observed through the resource
// it brings into the catalogue rather than by reading its own state.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceCreationProcessManager should", () => {
  it("integrates resource creation from request through organization reservation", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    await awaitOrganizationView(box, scope, (view) => view.name === "Acme");

    const requested = await recordEvents(scope, ResourceCreationRequestedSchema);
    const created = await recordEvents(scope, ResourceCreatedSchema);
    const added = await recordEvents(scope, ResourceAddedSchema);
    try {
      expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");

      expect((await requested.waitFor(box)).id?.value).toBe("payroll");
      expect((await created.waitFor(box)).policy?.policyVersion).toBe(1n);
      const catalogueItem = await awaitCatalogueItem(box, scope, "payroll");
      expect(catalogueItem).toMatchObject({
        id: { value: "payroll" },
        name: "payroll",
        policy: { policyVersion: 1n },
      });

      // The ResourceAdded fact completes the process by reserving the resource
      // in its organization's view.
      expect((await added.waitFor(box)).resourceId?.value).toBe("payroll");
      const views = await awaitOrganizationView(box, scope, (view) =>
        view.resource.some((resource) => resource.value === "payroll"),
      );
      expect(views[0]?.resource.some((resource) => resource.value === "payroll")).toBe(true);
    } finally {
      await Promise.all([requested.cancel(), created.cancel(), added.cancel()]);
    }
  });
});
