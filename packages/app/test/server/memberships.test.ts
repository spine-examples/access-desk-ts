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

import { isMessage } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { MemberClaimedSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import { MemberClaimedByOtherOrganizationSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections_pb.js";

import { closeOpened } from "./given/closing.js";
import { givenRunningServer } from "./given/hosted.js";
import { ACME, claimOf, givenMemberships, GLOBEX } from "./given/memberships.js";

afterEach(closeOpened);

describe("The memberships, reached through the application server, should", () => {
  it("claim the person under an address as a member, and name them", async () => {
    const server = await givenRunningServer();
    const memberships = await givenMemberships(() => server.url);

    const claimed = await memberships.claim(claimOf(ACME, "noah@acme.example"));

    expect(isMessage(claimed, MemberClaimedSchema)).toBe(true);
    expect(isMessage(claimed, MemberClaimedSchema) ? claimed.person?.uuid : "").toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("name the same person when the organization claims them again", async () => {
    const server = await givenRunningServer();
    const memberships = await givenMemberships(() => server.url);
    const first = await memberships.claim(claimOf(ACME, "noah@acme.example"));

    const again = await memberships.claim(claimOf(ACME, "noah@acme.example"));

    expect(again).toEqual(first);
  });

  it("name the same person to two claims of the organization at once", async () => {
    const server = await givenRunningServer();
    const memberships = await givenMemberships(() => server.url);

    const [first, second] = await Promise.all([
      memberships.claim(claimOf(ACME, "noah@acme.example")),
      memberships.claim(claimOf(ACME, "noah@acme.example")),
    ]);

    expect(isMessage(first, MemberClaimedSchema)).toBe(true);
    expect(second).toEqual(first);
  });

  it("answer that another organization claimed the person already", async () => {
    const server = await givenRunningServer();
    const memberships = await givenMemberships(() => server.url);
    await memberships.claim(claimOf(ACME, "noah@acme.example"));

    const taken = await memberships.claim(claimOf(GLOBEX, "noah@acme.example"));

    expect(isMessage(taken, MemberClaimedByOtherOrganizationSchema)).toBe(true);
  });

  it("try the claim again while the patience lasts, and then give up with the reason", async () => {
    const memberships = await givenMemberships(() => "http://127.0.0.1:1", 1_500);
    const started = Date.now();

    const failed = memberships.claim(claimOf(ACME, "noah@acme.example"));

    await expect(failed).rejects.toThrow("did not claim the person under noah@acme.example");
    await expect(failed).rejects.toHaveProperty("cause");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });
});
