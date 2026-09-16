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
import { ResourceAlreadyExistsSchema } from "@access-desk/resources-model/generated/access_desk/resources/rejections_pb.js";
import { OrganizationResourceNameAlreadyUsedSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_rejections_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  organizationId,
  resourcesBlackBox,
} from "./given/resources-context.js";
import { expectRejection, recordEvents } from "./given/events.js";
import { awaitOrganizationView, createOrganization } from "./given/organization.js";
import { awaitCatalogueItem, createResource, requestResourceCreation } from "./given/resource.js";

// The process manager is NONE-visibility, so each handler is observed through
// the domain facts and projections it produces.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceCreationProcessManager should", () => {
  describe("handle 'RequestResourceCreation', and", () => {
    it("admit a free name and emit 'ResourceCreationRequested'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const requested = await recordEvents(scope, ResourceCreationRequestedSchema);
      try {
        expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");
        expect((await requested.waitFor(box)).id?.uuid).toBe("payroll");
      } finally {
        await requested.cancel();
      }
    });

    it("reject recording a name already used in the organization", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await requestResourceCreation(scope, "payroll-1", "Payroll")).kind).toBe("ok");
      await awaitOrganizationView(box, scope, (view) =>
        view.resource.some((resource) => resource.id?.uuid === "payroll-1"),
      );

      await expectRejection(box, scope, OrganizationResourceNameAlreadyUsedSchema, () =>
        requestResourceCreation(scope, "payroll-2", "payroll"),
      );
    });

    it("abandon the creation when the resource already exists", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      await expectRejection(box, scope, ResourceAlreadyExistsSchema, () =>
        requestResourceCreation(scope, "payroll"),
      );
    });
  });

  describe("handle 'ResourceCreationRequested', and", () => {
    it("create the requested resource with its initial policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const created = await recordEvents(scope, ResourceCreatedSchema);
      try {
        expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");
        const event = await created.waitFor(box);
        expect(event.id?.uuid).toBe("payroll");
        expect(event.policy?.policyVersion).toBe(1n);
      } finally {
        await created.cancel();
      }
    });
  });

  describe("handle 'ResourceCreated', and", () => {
    it("emit 'ResourceAdded' for the organization that owns the resource", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      const added = await recordEvents(scope, ResourceAddedSchema);
      try {
        expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");
        expect(await added.waitFor(box)).toMatchObject({
          organizationId: { uuid: organizationId },
          resourceId: { uuid: "payroll" },
          name: "payroll",
        });
      } finally {
        await added.cancel();
      }
    });
  });

  describe("handle 'ResourceAdded', and", () => {
    it("complete once the resource is created and recorded", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");

      expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");
      const item = await awaitCatalogueItem(box, scope, "payroll");
      expect(item.name).toBe("payroll");
    });
  });
});
