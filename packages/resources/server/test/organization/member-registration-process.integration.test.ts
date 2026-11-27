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
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import {
  MemberRegisteredSchema,
  MemberRegistrationFailedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_events_pb.js";
import { MemberAlreadyRegisteredSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/member_registration_rejections_pb.js";

import { eventRecording } from "../given/event-recording.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  memberships,
  resourcesBlackBox,
  testActorContext,
} from "../given/resources-context.js";
import { registerMember, awaitMember } from "./given/member-registration.js";
import { awaitOrganizationView, createOrganization } from "./given/organization.js";

const { expectRejection, recordEvents } = eventRecording(testActorContext);

beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("MemberRegistrationProcessManager should", () => {
  it("make the first organization administrator a member, registered by no organization administrator", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    await createOrganization(scope);
    const registered = await recordEvents(scope, MemberRegisteredSchema);

    expect(
      (await registerMember(scope, "olivia@acme.example", OrganizationRole.ADMINISTRATOR)).kind,
    ).toBe("ok");

    expect((await registered.waitFor(box)).registeredBy).toBeUndefined();
    await registered.cancel();
    const view = await awaitMember(box, scope, "olivia@acme.example");
    expect(view.member).toMatchObject([
      {
        person: { uuid: memberships.personOf("olivia@acme.example") },
        emailAddress: { value: "olivia@acme.example" },
        role: OrganizationRole.ADMINISTRATOR,
      },
    ]);
  });

  it("make a person a member the organization administrator registers after the first one", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    await createOrganization(scope);
    await registerMember(scope, "olivia@acme.example", OrganizationRole.ADMINISTRATOR);
    await awaitMember(box, scope, "olivia@acme.example");
    const olivia = memberships.personOf("olivia@acme.example");
    const registered = await recordEvents(scope, MemberRegisteredSchema);

    expect(
      (await registerMember(scope, "maya@acme.example", OrganizationRole.MEMBER, olivia)).kind,
    ).toBe("ok");

    expect(
      await registered.waitFor(
        box,
        (event) => event.id?.emailAddress?.value === "maya@acme.example",
      ),
    ).toMatchObject({
      id: { emailAddress: { value: "maya@acme.example" } },
      person: { uuid: memberships.personOf("maya@acme.example") },
      role: OrganizationRole.MEMBER,
      registeredBy: { uuid: olivia },
    });
    await registered.cancel();
    const view = await awaitMember(box, scope, "maya@acme.example");
    expect(view.member).toHaveLength(2);
    const maya = view.member.find(
      (member) => member.person?.uuid === memberships.personOf("maya@acme.example"),
    );
    expect(maya?.role).toBe(OrganizationRole.MEMBER);
  });

  it("reject registering a person the organization lists already, and keep them listed once", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    await createOrganization(scope);
    await registerMember(scope, "noah@acme.example");
    await awaitMember(box, scope, "noah@acme.example");

    const rejection = await expectRejection(box, scope, MemberAlreadyRegisteredSchema, () =>
      registerMember(scope, "noah@acme.example", OrganizationRole.ADMINISTRATOR),
    );

    expect(rejection.person?.uuid).toBe(memberships.personOf("noah@acme.example"));
    const [view] = await awaitOrganizationView(box, scope, () => true);
    expect(view?.member).toHaveLength(1);
    expect(view?.member[0]?.role).toBe(OrganizationRole.MEMBER);
  });

  it("not make a person a member while the Identity bounded context does not answer the claim", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    await createOrganization(scope);
    memberships.failing.add("noah@acme.example");

    expect((await registerMember(scope, "noah@acme.example")).kind).toBe("ok");

    await box.eventually(
      () => Promise.resolve(memberships.claims),
      (claims) => claims > 0,
    );
    const [view] = await awaitOrganizationView(box, scope, () => true);
    expect(view?.member).toEqual([]);
  });

  it("fail to register a person of another organization", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);
    await createOrganization(scope);
    memberships.belongTo("noah@globex.example", "globex");

    const failed = await recordEvents(scope, MemberRegistrationFailedSchema);

    expect((await registerMember(scope, "noah@globex.example")).kind).toBe("ok");

    await failed.waitFor(box);
    await failed.cancel();

    const [view] = await awaitOrganizationView(box, scope, () => true);
    expect(view?.member).toEqual([]);
  });
});
