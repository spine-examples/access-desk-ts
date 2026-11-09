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

import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";

import { ACME, Calls, OTHER_KEY, Proofs, UNAUTHENTICATED } from "./given/forwarding-proof.js";
import {
  FORWARDING_PROOF_KEY,
  givenOrganization,
  organizationView,
} from "./server/given/hosted.js";

afterEach(() => Calls.close());

describe("The application server should", () => {
  it("take a call with the token of the shared key, as the gateway and the server itself make", async () => {
    const server = await Calls.server();
    await givenOrganization(server, ACME);

    const shown = await Calls.readAcme(
      Calls.callerOf(server, [await Calls.tokenOf(FORWARDING_PROOF_KEY)]),
    );

    expect(shown?.name).toBe("acme");
  });

  it("refuse a read without a token", async () => {
    const server = await Calls.server();
    await givenOrganization(server, ACME);

    await expect(Calls.readAcme(Calls.callerOf(server, []))).rejects.toMatchObject({
      code: UNAUTHENTICATED,
    });
  });

  it("refuse a command without a token", async () => {
    const server = await Calls.server();

    await expect(
      Calls.callerOf(server, []).post(
        CreateOrganizationSchema,
        create(CreateOrganizationSchema, { id: ACME, name: "Taken over" }),
      ),
    ).rejects.toMatchObject({ code: UNAUTHENTICATED });

    expect(await organizationView(server, ACME)).toBeUndefined();
  });

  it("refuse a call with the token of a key it does not share", async () => {
    const server = await Calls.server();
    await givenOrganization(server, ACME);

    await expect(
      Calls.readAcme(Calls.callerOf(server, [await Calls.tokenOf(OTHER_KEY)])),
    ).rejects.toMatchObject({ code: UNAUTHENTICATED });
  });
});

describe("The proof of a request the gateway passes on should", () => {
  /** The request, as the gateway passes it on. */
  const request = randomBytes(64);

  it("hold when the gateway signed the request with the shared key", async () => {
    const signature = await Proofs.signed(FORWARDING_PROOF_KEY, request);

    expect(await Proofs.checks(FORWARDING_PROOF_KEY, request, signature)).toBe(true);
  });

  it("not hold when another key signed the request", async () => {
    const signature = await Proofs.signed(OTHER_KEY, request);

    expect(await Proofs.checks(FORWARDING_PROOF_KEY, request, signature)).toBe(false);
  });

  it("not hold for another request than the one signed", async () => {
    const signature = await Proofs.signed(FORWARDING_PROOF_KEY, request);

    expect(await Proofs.checks(FORWARDING_PROOF_KEY, randomBytes(64), signature)).toBe(false);
  });

  it("not hold when the signature is not one", async () => {
    const signature = await Proofs.signed(FORWARDING_PROOF_KEY, request);

    for (const malformed of [
      "",
      "not a signature",
      signature.slice(1),
      `${signature}A`,
      `${signature.slice(0, -1)}!`,
    ]) {
      expect(await Proofs.checks(FORWARDING_PROOF_KEY, request, malformed)).toBe(false);
    }
  });
});
