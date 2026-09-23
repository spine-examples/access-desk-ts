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
import { eventRecording } from "@access-desk/base/testing";

import { ResourceAddedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { ResourceCreatedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import { OrganizationResourceNameAlreadyUsedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections_pb.js";
import {
  ResourceRegisteredSchema,
  ResourceRegistrationFailedSchema,
  ResourceRegistrationRequestedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../given/resources-context.js";
import { awaitCatalogItem, readCatalog, registerResource } from "./given/resource.js";
import {
  awaitOrganizationView,
  createOrganization,
  readOrganizationViews,
} from "../organization/given/organization.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The process manager is NONE-visibility, so it is observed through the resource
// it brings into the catalog rather than by reading its own state.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceRegistrationProcessManager should", () => {
  it("integrates resource registration through organization recording", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    await awaitOrganizationView(box, scope, (view) => view.name === "Acme");

    const requested = await recordEvents(scope, ResourceRegistrationRequestedSchema);
    const created = await recordEvents(scope, ResourceCreatedSchema);
    const added = await recordEvents(scope, ResourceAddedSchema);
    const registered = await recordEvents(scope, ResourceRegisteredSchema);
    try {
      expect((await registerResource(scope, "payroll")).kind).toBe("ok");

      expect((await requested.waitFor(box)).id?.uuid).toBe("payroll");
      expect((await created.waitFor(box)).policy?.openForRequests).toBe(false);
      const catalogItem = await awaitCatalogItem(box, scope, "payroll");
      expect(catalogItem).toMatchObject({
        id: { uuid: "payroll" },
        name: "payroll",
        policy: { openForRequests: false },
      });

      // ResourceAdded records the resource in its organization's view, then the
      // registration process emits its terminal fact and deletes itself.
      expect((await added.waitFor(box)).resourceId?.uuid).toBe("payroll");
      expect((await registered.waitFor(box)).id?.uuid).toBe("payroll");
      const views = await awaitOrganizationView(box, scope, (view) =>
        view.resource.some((resource) => resource.id?.uuid === "payroll"),
      );
      expect(views[0]?.resource.some((resource) => resource.id?.uuid === "payroll")).toBe(true);
    } finally {
      await Promise.all([
        requested.cancel(),
        created.cancel(),
        added.cancel(),
        registered.cancel(),
      ]);
    }
  });

  it("compensates a name conflict by deleting the created resource", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    expect((await createOrganization(scope)).kind).toBe("ok");
    await awaitOrganizationView(box, scope, (view) => view.name === "Acme");

    // The first resource reserves the name "payroll" in the organization.
    expect((await registerResource(scope, "payroll-1", "payroll")).kind).toBe("ok");
    await awaitCatalogItem(box, scope, "payroll-1");
    await awaitOrganizationView(box, scope, (view) =>
      view.resource.some((resource) => resource.id?.uuid === "payroll-1"),
    );

    const failed = await recordEvents(scope, ResourceRegistrationFailedSchema);
    try {
      // The second resource is created, then rejected by the organization for the
      // duplicate name; the process compensates by deleting the created resource.
      await expectRejection(box, scope, OrganizationResourceNameAlreadyUsedSchema, () =>
        registerResource(scope, "payroll-2", "payroll"),
      );
      expect((await failed.waitFor(box)).id?.uuid).toBe("payroll-2");

      // The compensated resource must leave the catalog, while the organization
      // keeps only the first resource under the reserved name.
      const catalog = await box.eventually(
        () => readCatalog(scope),
        (rows) => !rows.some((item) => item.id?.uuid === "payroll-2"),
      );
      expect(catalog.some((item) => item.id?.uuid === "payroll-2")).toBe(false);
      expect(catalog.some((item) => item.id?.uuid === "payroll-1")).toBe(true);

      const views = await readOrganizationViews(scope);
      expect(views[0]?.resource).toMatchObject([{ id: { uuid: "payroll-1" }, name: "payroll" }]);
      expect(views[0]?.resource).toHaveLength(1);
    } finally {
      await failed.cancel();
    }
  });
});
