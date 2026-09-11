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

import { ResourceCreationRequestedSchema } from "@access-desk/resources-model/generated/access_desk/resources/resource_creation_events_pb.js";

import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "./given/resources-context.js";
import {
  awaitCatalogueItem,
  createResource,
  readCatalogue,
  requestResourceCreation,
} from "./given/resource.js";
import { recordEvents } from "./given/events.js";

// The process manager is NONE-visibility, so it is observed through the resource
// it brings into the catalogue rather than by reading its own state.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("ResourceCreationProcessManager should", () => {
  describe("handle 'RequestResourceCreation', and", () => {
    it("emit 'ResourceCreationRequested'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      const events = await recordEvents(scope, ResourceCreationRequestedSchema);

      expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");

      const event = await events.waitFor(box);
      expect(event.id?.value).toBe("payroll");
      await events.cancel();
    });

    it("create the requested resource with its requested policy", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      // The process stores the request, then issues CreateResource; the resource
      // reaches the catalogue at version one.
      //
      // The later hop that reserves the resource in the organization
      // (ResourceCreated -> AddResource) is cross-repository and does not deliver on
      // this Spine snapshot, so the reservation and the process's terminal deletion
      // stall. See TICKET-spine-cross-repo-pm-event-delivery.md.
      expect((await requestResourceCreation(scope, "payroll")).kind).toBe("ok");

      const item = await awaitCatalogueItem(box, scope, "payroll");
      expect(item.name).toBe("payroll");
      expect(item.description).toBe("Payroll production");
      expect(item.policy?.policyVersion).toBe(1n);
    });

    // TODO:mykyta.pimonov:11-08-2026: Blocked: rejecting a request whose name is already taken
    //  is not implemented yet. Unskip once the process records accepted names and rejects duplicates.
    it.skip("reject a request whose name is already taken", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);

      // A resource named "payroll" already exists, so its name is allocated.
      expect((await createResource(scope, "payroll")).kind).toBe("ok");
      await awaitCatalogueItem(box, scope, "payroll");

      // The process must reject the taken name, so no resource is created for it; a
      // request for a free name is accepted and creates one.
      expect(
        (await requestResourceCreation(scope, "payroll-again", { name: "payroll" })).kind,
      ).toBe("ok");
      expect((await requestResourceCreation(scope, "alpha")).kind).toBe("ok");

      // Fence on the accepted resource, then confirm the rejected one never appeared.
      await awaitCatalogueItem(box, scope, "alpha");
      const ids = (await readCatalogue(scope)).map((item) => item.id?.value);
      expect(ids).toContain("alpha");
      expect(ids).not.toContain("payroll-again");
    });
  });
});
