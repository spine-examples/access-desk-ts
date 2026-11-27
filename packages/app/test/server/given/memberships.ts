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
import type { OrganizationId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { ClaimMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";

import { organizationId } from "./client.js";
import { closeAfterTest } from "./closing.js";

type MembershipsModule = typeof import("../../../dist/src/server/memberships.js");

/** The organization that claims people first. */
export const ACME = organizationId("acme");

/** The organization that claims the people of Acme too late. */
export const GLOBEX = organizationId("globex");

/** Builds the claim of an organization for the person under an email address. */
export function claimOf(organization: OrganizationId, address: string) {
  return create(ClaimMemberSchema, { id: { emailAddress: { value: address } }, organization });
}

/** Reaches the memberships through an application server, until the test ends. */
export async function givenMemberships(address: () => string, patienceMs?: number) {
  const { ReachedMemberships }: MembershipsModule =
    await import("../../../dist/src/server/memberships.js");
  const memberships = ReachedMemberships.through(address, patienceMs);
  closeAfterTest(() => memberships.close());
  return memberships;
}
