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

import type {
  OrganizationId,
  PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

/** A person who is to become a member of an organization. */
export interface NewMember {
  /** The organization the person joins. */
  readonly organization: OrganizationId;
  /** The person who joins. */
  readonly person: PersonId;
  /** The person's display name. */
  readonly name: string;
  /** The role the person will hold in the organization. */
  readonly role: OrganizationRole;
}

/**
 * A service that adds a person to the members of an organization.
 */
export interface OrganizationMembers {
  /**
   * Adds a person to an organization's members.
   *
   * @param member Who joins which organization, and with which role.
   * @returns Resolves once the organization has the person as a member, and
   *   rejects when it does not.
   */
  add(member: NewMember): Promise<void>;
}
