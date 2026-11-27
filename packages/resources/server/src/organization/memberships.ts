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

import type { ClaimMember } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import type { MemberClaimed } from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import type { MemberClaimedByOtherOrganization } from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections_pb.js";

/**
 * The memberships of people in organizations, which the Identity bounded
 * context keeps for all organizations at once.
 */
export interface Memberships {
  /**
   * Claims the person under an email address as a member of an organization.
   *
   * Registers the person when nobody has signed in under the address yet.
   * Claiming the person again for the same organization answers with the same
   * claim, once it is finished.
   *
   * @param command The command of the Identity bounded context that claims the
   *   person.
   * @returns `MemberClaimed` once the person joined the organization, or
   *   `MemberClaimedByOtherOrganization` when another organization has them.
   * @throws Error when the claim could not be finished just now.
   */
  claim(command: ClaimMember): Promise<MemberClaimed | MemberClaimedByOtherOrganization>;
}
