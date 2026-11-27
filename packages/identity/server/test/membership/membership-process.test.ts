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
import { MemberClaimStartedSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import {
  MemberAlreadyClaimedSchema,
  MemberClaimedByOtherOrganizationSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections_pb.js";

import {
  actor,
  closeIdentityBlackBoxes,
  expectRejection,
  identityBlackBox,
  loadIdentityContext,
  recordEvents,
} from "../given/identity-context.js";
import { awaitMembership, claimMember, organizationId } from "./given/membership.js";

beforeAll(loadIdentityContext, 30_000);
afterEach(closeIdentityBlackBoxes);

describe("MembershipProcessManager should", () => {
  describe("handle 'ClaimMember', and", () => {
    it("emit 'MemberClaimStarted'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      const started = await recordEvents(scope, MemberClaimStartedSchema);

      expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");

      expect(await started.waitFor(box)).toEqual(
        create(MemberClaimStartedSchema, {
          id: { emailAddress: { value: "noah@acme.example" } },
          organization: { value: organizationId },
        }),
      );
      await started.cancel();
    });

    it("reject claiming the person again for the same organization with 'MemberAlreadyClaimed', while the first claim goes on to its end", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");

      const rejection = await expectRejection(box, scope, MemberAlreadyClaimedSchema, () =>
        claimMember(scope, " Noah@Acme.example "),
      );

      expect(rejection.organization?.value).toBe(organizationId);
      expect((await awaitMembership(box, scope, "noah@acme.example")).person?.uuid).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    it("reject a person another organization claimed with 'MemberClaimedByOtherOrganization'", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await claimMember(scope, "noah@acme.example")).kind).toBe("ok");

      const rejection = await expectRejection(
        box,
        scope,
        MemberClaimedByOtherOrganizationSchema,
        () => claimMember(scope, "noah@acme.example", "globex"),
      );

      expect(rejection.organization?.value).toBe("globex");
    });

    it("find the membership by the email address in lower case, however it is written", async () => {
      const box = await identityBlackBox();
      const scope = box.onBehalfOf(actor);
      expect((await claimMember(scope, " Noah@Acme.example ")).kind).toBe("ok");
      await awaitMembership(box, scope, "noah@acme.example");

      await expectRejection(box, scope, MemberClaimedByOtherOrganizationSchema, () =>
        claimMember(scope, "NOAH@ACME.EXAMPLE", "globex"),
      );
    });
  });
});
