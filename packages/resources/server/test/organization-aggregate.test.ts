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
  OrganizationMemberAddedSchema,
  ResourceAddedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_events_pb.js";
import { OrganizationAlreadyExistsSchema } from "@access-desk/resources-model/generated/access_desk/resources/organization_rejections_pb.js";

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
  readOrganizationViews,
} from "./given/organization.js";
import { recordEvents } from "./given/events.js";

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

    it("reject a second creation without changing the organization", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createOrganization(scope, "Acme")).kind).toBe("ok");
      await awaitOrganizationView(box, scope, (v) => v.name === "Acme");

      const rejections = await recordEvents(scope, OrganizationAlreadyExistsSchema);
      expect((await createOrganization(scope, "Evil")).kind).toBe("ok");
      const rejection = await rejections.waitFor(box);
      expect(rejection).toEqual(
        create(OrganizationAlreadyExistsSchema, { id: { uuid: organizationId } }),
      );
      await rejections.cancel();

      const views = await readOrganizationViews(scope);
      expect(views).toHaveLength(1);
      expect(views[0]?.name).toBe("Acme");
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
          active: true,
        }),
      );
      await events.cancel();
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
          resourceId: { value: "payroll" },
        }),
      );
      await events.cancel();
    });
  });
});
