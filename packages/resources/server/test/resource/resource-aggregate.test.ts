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

import { Sensitivity } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import {
  ResourceClosedForRequestsSchema,
  ResourceCreatedSchema,
  ResourceDeletedSchema,
  ResourceOpenedForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import {
  ResourceAlreadyClosedForRequestsSchema,
  ResourceAlreadyExistsSchema,
  ResourceAlreadyOpenForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/rejections_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
  testActorContext,
} from "../given/resources-context.js";
import { closeResource, createResource, deleteResource, openResource } from "./given/resource.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

// The Resource aggregate is NONE-visibility, so each command handler is verified
// only through the policy fact it publishes.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceAggregate should", () => {
  describe("handle 'CreateResource', and", () => {
    it("emit 'ResourceCreated' carrying the initial closed policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const events = await recordEvents(scope, ResourceCreatedSchema);

      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.uuid).toBe("payroll");
      expect(event.name).toBe("payroll");
      expect(event.description).toBe("Payroll production");
      expect(event.category).toBe("application");
      expect(event.policy).toMatchObject({
        openForRequests: false,
        sensitivity: Sensitivity.RESTRICTED,
        manager: [{ uuid: "manager" }],
      });
      await events.cancel();
    });

    it("reject a duplicate creation with 'ResourceAlreadyExists'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      await expectRejection(box, scope, ResourceAlreadyExistsSchema, () =>
        createResource(scope, "payroll"),
      );
    });
  });

  describe("handle 'DeleteResource', and", () => {
    it("emit 'ResourceDeleted'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceDeletedSchema);
      try {
        expect((await deleteResource(scope, "payroll")).kind).toBe("ok");
        expect((await events.waitFor(box)).id?.uuid).toBe("payroll");
      } finally {
        await events.cancel();
      }
    });
  });

  describe("handle 'OpenResourceForRequests', and", () => {
    it("emit 'ResourceOpenedForRequests' with the open policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceOpenedForRequestsSchema);

      expect((await openResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.uuid).toBe("payroll");
      expect(event.policy?.openForRequests).toBe(true);
      await events.cancel();
    });

    it("reject opening an already-open resource", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      expect((await openResource(scope, "payroll")).kind).toBe("ok");

      await expectRejection(box, scope, ResourceAlreadyOpenForRequestsSchema, () =>
        openResource(scope, "payroll"),
      );
    });
  });

  describe("handle 'CloseResourceForRequests', and", () => {
    it("emit 'ResourceClosedForRequests' with the closed policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      expect((await openResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceClosedForRequestsSchema);

      expect((await closeResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.uuid).toBe("payroll");
      expect(event.policy?.openForRequests).toBe(false);
      await events.cancel();
    });

    it("reject closing an already-closed resource", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      // A freshly created resource is already closed.
      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      await expectRejection(box, scope, ResourceAlreadyClosedForRequestsSchema, () =>
        closeResource(scope, "payroll"),
      );
    });
  });
});
