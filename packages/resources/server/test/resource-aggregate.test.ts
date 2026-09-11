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

import { Sensitivity } from "@access-desk/resources-model/generated/access_desk/resources/values_pb.js";
import {
  ResourceClosedForRequestsSchema,
  ResourceCreatedSchema,
  ResourceFallbackApproverAssignedSchema,
  ResourceOpenedForRequestsSchema,
  ResourcePrimaryApproverAssignedSchema,
} from "@access-desk/resources-model/generated/access_desk/resources/events_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "./given/resources-context.js";
import {
  assignFallbackApprover,
  assignPrimaryApprover,
  closeResource,
  createResource,
  openResource,
} from "./given/resource.js";
import { recordEvents } from "./given/events.js";

// The Resource aggregate is NONE-visibility, so each command handler is verified
// only through the policy fact it publishes.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceAggregate should", () => {
  describe("handle 'CreateResource', and", () => {
    it("emit 'ResourceCreated' carrying the initial closed policy at version one", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const events = await recordEvents(scope, ResourceCreatedSchema);

      expect((await createResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.value).toBe("payroll");
      expect(event.name).toBe("payroll");
      expect(event.description).toBe("Payroll production");
      expect(event.category).toBe("application");
      expect(event.policy?.policyVersion).toBe(1n);
      expect(event.policy).toMatchObject({
        openForRequests: false,
        sensitivity: Sensitivity.RESTRICTED,
        owner: { uuid: "owner" },
        primaryApprover: { uuid: "primary" },
        fallbackApprover: { uuid: "fallback" },
      });
      await events.cancel();
    });
  });

  describe("handle 'AssignResourcePrimaryApprover', and", () => {
    it("emit 'ResourcePrimaryApproverAssigned' with the complete next policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourcePrimaryApproverAssignedSchema);

      expect((await assignPrimaryApprover(scope, "payroll", "dana")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.value).toBe("payroll");
      expect(event.policy?.policyVersion).toBe(2n);
      expect(event.policy?.primaryApprover?.uuid).toBe("dana");
      // The complete next policy carries the unchanged fields forward.
      expect(event.policy?.sensitivity).toBe(Sensitivity.RESTRICTED);
      await events.cancel();
    });
  });

  describe("handle 'AssignResourceFallbackApprover', and", () => {
    it("emit 'ResourceFallbackApproverAssigned' with the complete next policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceFallbackApproverAssignedSchema);

      expect((await assignFallbackApprover(scope, "payroll", "erin")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.value).toBe("payroll");
      expect(event.policy?.policyVersion).toBe(2n);
      expect(event.policy?.fallbackApprover?.uuid).toBe("erin");
      expect(event.policy?.sensitivity).toBe(Sensitivity.RESTRICTED);
      await events.cancel();
    });
  });

  describe("handle 'OpenResourceForRequests', and", () => {
    it("emit 'ResourceOpenedForRequests' open at the next version", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceOpenedForRequestsSchema);

      expect((await openResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.value).toBe("payroll");
      expect(event.policy?.policyVersion).toBe(2n);
      expect(event.policy?.openForRequests).toBe(true);
      await events.cancel();
    });
  });

  describe("handle 'CloseResourceForRequests', and", () => {
    it("emit 'ResourceClosedForRequests' closed at the next version", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      expect((await openResource(scope, "payroll")).kind).toBe("ok");
      const events = await recordEvents(scope, ResourceClosedForRequestsSchema);

      expect((await closeResource(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.value).toBe("payroll");
      expect(event.policy?.policyVersion).toBe(3n);
      expect(event.policy?.openForRequests).toBe(false);
      await events.cancel();
    });
  });
});
