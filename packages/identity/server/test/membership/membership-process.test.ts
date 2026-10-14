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
import { MemberAddingStartedSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import { AlreadyMemberOfOtherOrganizationSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  expectRejection,
  identityBlackBox,
  loadIdentityContext,
  recordEvents,
} from "../given/identity-context.js";
import { addMember, awaitMembership, organizationId } from "./given/membership.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("MembershipProcessManager should", () => {
  describe("handle 'AddMember', and", () => {
    it("emit 'MemberAddingStarted'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const started = await recordEvents(scope, MemberAddingStartedSchema);

      expect(
        (await addMember(scope, "noah@acme.example", OrganizationRole.ADMINISTRATOR)).kind,
      ).toBe("ok");

      expect(await started.waitFor(box)).toEqual(
        create(MemberAddingStartedSchema, {
          id: { emailAddress: { value: "noah@acme.example" } },
          organization: { uuid: organizationId },
          role: OrganizationRole.ADMINISTRATOR,
        }),
      );
      await started.cancel();
    });

    it("start again for an address added to the same organization again", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");
      await awaitMembership(box, scope, "noah@acme.example");
      const started = await recordEvents(scope, MemberAddingStartedSchema);

      expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");

      expect((await started.waitFor(box)).organization?.uuid).toBe(organizationId);
      await started.cancel();
    });

    it("reject an address that belongs to another organization with 'AlreadyMemberOfOtherOrganization'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await addMember(scope, "noah@acme.example")).kind).toBe("ok");

      await expectRejection(box, scope, AlreadyMemberOfOtherOrganizationSchema, () =>
        addMember(scope, "noah@acme.example", OrganizationRole.ADMINISTRATOR, "globex"),
      );
    });

    it("find the membership by the email address in lower case, however it is written", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await addMember(scope, " Noah@Acme.example ")).kind).toBe("ok");
      await awaitMembership(box, scope, "noah@acme.example");

      await expectRejection(box, scope, AlreadyMemberOfOtherOrganizationSchema, () =>
        addMember(scope, "NOAH@ACME.EXAMPLE", OrganizationRole.MEMBER, "globex"),
      );
    });
  });
});
