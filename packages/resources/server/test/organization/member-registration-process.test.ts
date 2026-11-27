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
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import {
  MemberRegisteredSchema,
  MemberRegistrationFailedSchema,
  MemberRegistrationStartedSchema,
  MemberResolvedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_events_pb.js";
import {
  MemberAlreadyRegisteredSchema,
  MemberOfOtherOrganizationSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_rejections_pb.js";

import { eventRecording } from "../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  organizationId,
  memberships,
  resourcesBlackBox,
  testActorContext,
} from "../given/resources-context.js";
import { registerMember, awaitMember } from "./given/member-registration.js";
import { createOrganization } from "./given/organization.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("MemberRegistrationProcessManager should", () => {
  describe("handle 'RegisterMember', and", () => {
    it("emit 'MemberRegistrationStarted' with the organization and the role", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      const started = await recordEvents(scope, MemberRegistrationStartedSchema);

      expect(
        (await registerMember(scope, "noah@acme.example", OrganizationRole.ADMINISTRATOR)).kind,
      ).toBe("ok");

      expect(await started.waitFor(box)).toEqual(
        create(MemberRegistrationStartedSchema, {
          id: { emailAddress: { value: "noah@acme.example" } },
          organization: { value: organizationId },
          role: OrganizationRole.ADMINISTRATOR,
        }),
      );
      await started.cancel();
    });

    it("run a registration again whose claim did not finish", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      memberships.failing.add("noah@acme.example");
      expect((await registerMember(scope, "noah@acme.example")).kind).toBe("ok");
      await box.eventually(
        () => Promise.resolve(memberships.claims),
        (claims) => claims > 0,
      );
      memberships.failing.clear();

      expect((await registerMember(scope, "noah@acme.example")).kind).toBe("ok");

      await awaitMember(box, scope, "noah@acme.example");
    });

    it("claim the person by the address in lower case, however it is written", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);

      expect((await registerMember(scope, " Noah@Acme.example ")).kind).toBe("ok");

      await awaitMember(box, scope, "noah@acme.example");
      expect([...memberships.claimed.keys()]).toEqual(["noah@acme.example"]);
    });

    it("reject a person the organization lists already with 'MemberAlreadyRegistered'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      const registered = await recordEvents(scope, MemberRegisteredSchema);
      await registerMember(scope, "noah@acme.example");
      await registered.waitFor(box);
      await registered.cancel();

      const rejection = await expectRejection(box, scope, MemberAlreadyRegisteredSchema, () =>
        registerMember(scope, "noah@acme.example", OrganizationRole.ADMINISTRATOR),
      );

      expect(rejection.person?.uuid).toBe(memberships.personOf("noah@acme.example"));
    });
  });

  describe("handle 'ResolveMember', and", () => {
    it("emit 'MemberResolved' for the person the address names", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      const claimed = await recordEvents(scope, MemberResolvedSchema);

      expect((await registerMember(scope, "noah@acme.example")).kind).toBe("ok");

      expect(await claimed.waitFor(box)).toEqual(
        create(MemberResolvedSchema, {
          id: { emailAddress: { value: "noah@acme.example" } },
          organization: { value: organizationId },
          person: { uuid: memberships.personOf("noah@acme.example") },
        }),
      );
      await claimed.cancel();
    });

    it("reject a person another organization claimed with 'MemberOfOtherOrganization'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      memberships.belongTo("noah@globex.example", "globex");

      const rejection = await expectRejection(box, scope, MemberOfOtherOrganizationSchema, () =>
        registerMember(scope, "noah@globex.example"),
      );

      expect(rejection.organization?.value).toBe(organizationId);
    });
  });

  describe("react on 'MemberOfOtherOrganization', and", () => {
    it("emit 'MemberRegistrationFailed'", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      memberships.belongTo("noah@globex.example", "globex");
      const failed = await recordEvents(scope, MemberRegistrationFailedSchema);

      expect((await registerMember(scope, "noah@globex.example")).kind).toBe("ok");

      expect(await failed.waitFor(box)).toEqual(
        create(MemberRegistrationFailedSchema, {
          id: { emailAddress: { value: "noah@globex.example" } },
          organization: { value: organizationId },
        }),
      );
      await failed.cancel();
    });
  });

  describe("react on 'MemberAlreadyAdded', and", () => {
    it("emit 'MemberRegistered' for an address of a person the organization lists under another", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      const first = await recordEvents(scope, MemberRegisteredSchema);
      await registerMember(scope, "noah@acme.example");
      await first.waitFor(box);
      await first.cancel();
      memberships.claimed.set("n.smith@acme.example", {
        organization: organizationId,
        person: memberships.personOf("noah@acme.example"),
      });
      const registered = await recordEvents(scope, MemberRegisteredSchema);

      await registerMember(scope, "n.smith@acme.example");

      expect(await registered.waitFor(box)).toMatchObject({
        id: { emailAddress: { value: "n.smith@acme.example" } },
        person: { uuid: memberships.personOf("noah@acme.example") },
      });
      await registered.cancel();
    });
  });

  describe("react on 'MemberAdded', and", () => {
    it("emit 'MemberRegistered' with the organization administrator who registered the person", async () => {
      const box = await resourcesBlackBox();
      const scope = box.onBehalfOf(actor);
      await createOrganization(scope);
      const registered = await recordEvents(scope, MemberRegisteredSchema);

      await registerMember(scope, "maya@acme.example", OrganizationRole.MEMBER, "person-olivia");

      expect(await registered.waitFor(box)).toEqual(
        create(MemberRegisteredSchema, {
          id: { emailAddress: { value: "maya@acme.example" } },
          organization: { value: organizationId },
          person: { uuid: memberships.personOf("maya@acme.example") },
          role: OrganizationRole.MEMBER,
          registeredBy: { uuid: "person-olivia" },
        }),
      );
      await registered.cancel();
    });
  });
});
