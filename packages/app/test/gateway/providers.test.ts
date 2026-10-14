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

import { describe, expect, it } from "vitest";
import { IdentityProvider } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { ConfirmedIdentity } from "../../src/gateway/providers.js";

describe("Gateway provider mapping should", () => {
  it("carry a confirmed account's issuer, subject, email, and display name", () => {
    const identity = ConfirmedIdentity.of(
      "https://provider.test",
      "subject-1",
      "maya@example.com",
      "Maya Chen",
    );

    expect(identity).toMatchObject({
      issuer: "https://provider.test",
      subject: "subject-1",
      claims: { email: "maya@example.com", name: "Maya Chen" },
    });
    expect(ConfirmedIdentity.personIn(IdentityProvider.GOOGLE, identity)).toMatchObject({
      id: { provider: IdentityProvider.GOOGLE, subject: "subject-1" },
      email: { value: "maya@example.com" },
      name: "Maya Chen",
    });
  });

  it("use the verified email as a display-name fallback", () => {
    const identity = ConfirmedIdentity.of("issuer", "subject-2", "no-name@example.com", undefined);

    expect(identity.claims?.name).toBe("no-name@example.com");
    expect(ConfirmedIdentity.personIn(IdentityProvider.GOOGLE, identity)?.name).toBe(
      "no-name@example.com",
    );
  });

  it("refuse an identity with no verified email claim", () => {
    expect(
      ConfirmedIdentity.personIn(IdentityProvider.GOOGLE, {
        issuer: "issuer",
        subject: "subject-3",
        claims: { name: "No email" },
      }),
    ).toBeUndefined();
  });
});
