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

import { create } from "@bufbuild/protobuf";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eventRecording } from "@access-desk/base/testing";

import {
  OrganizationCreatedSchema,
  OrganizationMemberAddedSchema,
  ResourceAddedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_events_pb.js";
import {
  OrganizationAlreadyExistsSchema,
  OrganizationMemberAlreadyAddedSchema,
  OrganizationResourceNameAlreadyUsedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_rejections_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  organizationId,
  resourcesBlackBox,
  testActorContext,
} from "../given/resources-context.js";
import {
  addOrganizationMember,
  addResource,
  awaitOrganizationView,
  createOrganization,
  readOrganizationViews,
} from "./given/organization.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The Organization aggregate is NONE-visibility, so each command handler is
// verified through the fact it publishes.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("OrganizationAggregate should", () => {
  describe("handle 'CreateOrganization', and", () => {
    it("emit 'OrganizationCreated'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const events = await recordEvents(scope, OrganizationCreatedSchema);

      expect((await createOrganization(scope, "Acme")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event).toEqual(
        create(OrganizationCreatedSchema, { id: { uuid: organizationId }, name: "Acme" }),
      );
      await events.cancel();
    });

    it("reject a second creation with 'OrganizationAlreadyExists'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope, "Acme")).kind).toBe("ok");

      await expectRejection(box, scope, OrganizationAlreadyExistsSchema, () =>
        createOrganization(scope, "Evil"),
      );
    });
  });

  describe("handle 'AddOrganizationMember', and", () => {
    it("emit 'OrganizationMemberAdded'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      const events = await recordEvents(scope, OrganizationMemberAddedSchema);

      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event).toEqual(
        create(OrganizationMemberAddedSchema, {
          organizationId: { uuid: organizationId },
          person: { uuid: "maya" },
          name: "maya",
        }),
      );
      await events.cancel();
    });

    it("reject a duplicate member with 'OrganizationMemberAlreadyAdded'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");

      await expectRejection(box, scope, OrganizationMemberAlreadyAddedSchema, () =>
        addOrganizationMember(scope, "maya"),
      );
    });
  });

  describe("handle 'AddResource', and", () => {
    it("emit 'ResourceAdded'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceAddedSchema);

      expect((await addResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event).toEqual(
        create(ResourceAddedSchema, {
          organizationId: { uuid: organizationId },
          resourceId: { uuid: "payroll" },
          name: "payroll",
        }),
      );
      await events.cancel();
    });

    it("emit a duplicate resource-added fact without duplicating organization state", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addResource(scope, "payroll")).kind).toBe("ok");
      await awaitOrganizationView(box, scope, (view) =>
        view.resource.some((resource) => resource.id?.uuid === "payroll"),
      );

      const events = await recordEvents(scope, ResourceAddedSchema);
      try {
        expect((await addResource(scope, "payroll")).kind).toBe("ok");
        await events.waitFor(box, (event) => event.resourceId?.uuid === "payroll");

        expect(events.received).toEqual([
          create(ResourceAddedSchema, {
            organizationId: { uuid: organizationId },
            resourceId: { uuid: "payroll" },
            name: "payroll",
          }),
        ]);
        const views = await readOrganizationViews(scope);
        expect(views[0]?.resource).toMatchObject([{ id: { uuid: "payroll" }, name: "payroll" }]);
        expect(views[0]?.resource).toHaveLength(1);
      } finally {
        await events.cancel();
      }
    });

    it("reject a differently identified resource with the same name, ignoring case", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addResource(scope, "payroll-a", "Payroll")).kind).toBe("ok");

      const rejection = await expectRejection(
        box,
        scope,
        OrganizationResourceNameAlreadyUsedSchema,
        () => addResource(scope, "payroll-b", " payroll "),
      );

      expect(rejection).toMatchObject({ resourceId: { uuid: "payroll-b" }, name: " payroll " });
      const views = await readOrganizationViews(scope);
      expect(views[0]?.resource).toMatchObject([{ id: { uuid: "payroll-a" }, name: "Payroll" }]);
      expect(views[0]?.resource).toHaveLength(1);
    });
  });
});
