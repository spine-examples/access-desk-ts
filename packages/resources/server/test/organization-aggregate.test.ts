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

import { create } from "@bufbuild/protobuf";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  OrganizationCreatedSchema,
  OrganizationMemberActivatedSchema,
  OrganizationMemberAddedSchema,
  OrganizationMemberDeactivatedSchema,
  ResourceAddedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import {
  OrganizationAlreadyExistsSchema,
  OrganizationMemberAlreadyActiveSchema,
  OrganizationMemberAlreadyAddedSchema,
  OrganizationMemberAlreadyInactiveSchema,
  OrganizationResourceNameAlreadyUsedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_rejections_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  organizationId,
  resourcesBlackBox,
} from "./given/resources-context.js";
import {
  activateOrganizationMember,
  addOrganizationMember,
  addResource,
  deactivateOrganizationMember,
  awaitOrganizationView,
  createOrganization,
  readOrganizationViews,
} from "./given/organization.js";
import { expectRejection, recordEvents } from "./given/events.js";

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
          active: true,
          membershipVersion: 1n,
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

  describe("handle 'ActivateOrganizationMember', and", () => {
    it("emit 'OrganizationMemberActivated' when reactivating, advancing the revision again", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");
      expect((await deactivateOrganizationMember(scope, "maya")).kind).toBe("ok");
      const events = await recordEvents(scope, OrganizationMemberActivatedSchema);

      expect((await activateOrganizationMember(scope, "maya")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event).toEqual(
        create(OrganizationMemberActivatedSchema, {
          organizationId: { uuid: organizationId },
          person: { uuid: "maya" },
          membershipVersion: 3n,
        }),
      );
      await events.cancel();
    });

    it("reject reactivating an already-active member with 'OrganizationMemberAlreadyActive'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");

      // The member is added active, so activating again changes nothing.
      await expectRejection(box, scope, OrganizationMemberAlreadyActiveSchema, () =>
        activateOrganizationMember(scope, "maya"),
      );
    });
  });

  describe("handle 'DeactivateOrganizationMember', and", () => {
    it("emit 'OrganizationMemberDeactivated' at the next revision", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");
      const events = await recordEvents(scope, OrganizationMemberDeactivatedSchema);

      expect((await deactivateOrganizationMember(scope, "maya")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event).toEqual(
        create(OrganizationMemberDeactivatedSchema, {
          organizationId: {uuid: organizationId},
          person: {uuid: "maya"},
          membershipVersion: 2n,
        }),
      );
      await events.cancel();
    });

    it("reject deactivating an already-inactive member with 'OrganizationMemberAlreadyInactive'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope)).kind).toBe("ok");
      expect((await addOrganizationMember(scope, "maya")).kind).toBe("ok");
      expect((await deactivateOrganizationMember(scope, "maya")).kind).toBe("ok");

      // The member is already inactive, so deactivating again changes nothing.
      await expectRejection(box, scope, OrganizationMemberAlreadyInactiveSchema, () =>
        deactivateOrganizationMember(scope, "maya"),
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
