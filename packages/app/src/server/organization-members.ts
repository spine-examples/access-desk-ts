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
import type { NewMember, OrganizationMembers } from "@access-desk/identity-server";
import { AddOrganizationMemberSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import type { OrganizationId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  type OrganizationMemberAdded,
  OrganizationMemberAddedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { PATIENCE_MS, postAndAwait, ServerConnection } from "./client.js";

/** The name under which the application itself acts. */
const SYSTEM = "access-desk";

/** The organizations' members, with the connections that reach them. */
export interface ReachedOrganizationMembers extends OrganizationMembers {
  /** Closes the connection to the organizations. */
  close(): Promise<void>;
}

/**
 * Reaches the organizations' members through the application server.
 *
 * An organization keeps its members itself, in the Resources context, as its
 * own tenant. An accepted invitation lives in Identity. To add the person,
 * Identity asks the organization as any client of the server would:
 *
 * 1. It starts watching the organization for a member being added.
 * 2. It asks the organization to add the person.
 * 3. It waits until the organization says that it has added them.
 *
 * Whether the person may be added is the organization's to decide. This only
 * asks, and says so on the console when the organization does not add them.
 *
 * @param server Tells the address of the application server, once it listens.
 * @param patienceMs How long an organization has to say that it added a
 *   person. Ten seconds when left out.
 * @returns The organizations' members, as Identity reaches them.
 */
export function organizationMembersThrough(
  server: () => string,
  patienceMs: number = PATIENCE_MS,
): ReachedOrganizationMembers {
  const connection = new ServerConnection(server);
  const organizationOf = (organization: OrganizationId) =>
    connection.in(organization).onBehalfOf(SYSTEM);

  return {
    async add(member: NewMember): Promise<void> {
      const { organization, person, name, role } = member;
      const awaited = {
        command: AddOrganizationMemberSchema,
        message: create(AddOrganizationMemberSchema, {
          organizationId: { uuid: organization.uuid },
          person: { uuid: person.uuid },
          name,
          role,
        }),
        event: OrganizationMemberAddedSchema,
        answers: (event: OrganizationMemberAdded) => event.person?.uuid === person.uuid,
      };
      const added = await postAndAwait(organizationOf(organization), awaited, patienceMs);
      if (added === undefined) {
        console.warn(
          `Organization ${organization.uuid} did not add person ${person.uuid} to its members.`,
        );
        throw new Error("The organization did not add the person to its members.");
      }
    },

    close: () => connection.close(),
  };
}
