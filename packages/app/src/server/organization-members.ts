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
import {
  type OrganizationId,
  OrganizationIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  type OrganizationMemberAdded,
  OrganizationMemberAddedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { PATIENCE_MS, postAndAwait, readById, ServerConnection } from "./client.js";

/** The name under which the application itself acts. */
const SYSTEM = "access-desk";

/** The service that adds members to organizations, with the connection it holds. */
export interface ReachedOrganizationMembers extends OrganizationMembers {
  /** Closes the connection to the organizations. */
  close(): Promise<void>;
}

/**
 * Adds people to the members of organizations, through the application
 * server.
 *
 * An organization keeps its members itself, as its own tenant in Resources.
 * So Identity adds a person who accepted an invitation the way any client of
 * the server would:
 *
 * 1. It checks whether the person is a member already. If so, nothing more
 *    is done, and they keep the role they hold.
 * 2. It asks the organization to add the person, and waits for
 *    the organization to confirm.
 * 3. If no confirmation comes in time, it checks once more whether the
 *    person is a member. If they are not, it logs that and fails.
 *
 * So an acceptance that failed halfway can be given again.
 *
 * @param server Returns the address of the application server, once it listens.
 * @param patienceMs How long to wait for the organization to confirm. Ten
 *   seconds when left out.
 * @returns The service, as Identity uses it.
 */
export function organizationMembersThrough(
  server: () => string,
  patienceMs: number = PATIENCE_MS,
): ReachedOrganizationMembers {
  const connection = new ServerConnection(server);
  const organizationOf = (organization: OrganizationId) =>
    connection.in(organization).onBehalfOf(SYSTEM);

  const alreadyMember = async ({ organization, person, role }: NewMember): Promise<boolean> => {
    const view = await readById(
      organizationOf(organization),
      OrganizationViewSchema,
      OrganizationIdSchema,
      organization,
    );
    const held = view?.member.find((member) => member.person?.uuid === person.uuid);
    if (held !== undefined && held.role !== role) {
      console.warn(
        `Organization ${organization.uuid} already has person ${person.uuid} ` +
          "as a member, in another role than the one they were to be added with.",
      );
    }
    return held !== undefined;
  };

  return {
    async add(member: NewMember): Promise<void> {
      const { organization, person, name, role } = member;
      if (await alreadyMember(member)) {
        return;
      }
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
      if (added === undefined && !(await alreadyMember(member))) {
        console.warn(
          `Organization ${organization.uuid} did not add person ${person.uuid} to its members.`,
        );
        throw new Error("The organization did not add the person to its members.");
      }
    },

    close: () => connection.close(),
  };
}
