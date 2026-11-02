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

import { useEntityQuery } from "@spine-event-engine/client-react";
import { AnyPacker } from "@spine-event-engine/core";
import { useState, type ReactElement } from "react";
import { Navigate } from "react-router";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import type { Membership } from "../api/authentication.js";
import { SpineClient } from "../api/spine-client.js";
import { Session } from "../session/session.js";

/** The organization page, showing its details and members. */
export const Organization = {
  /**
   * Renders organization details and members for the signed-in user.
   *
   * Redirects users without an organization to `/`.
   */
  Page: (): ReactElement => {
    const { token, info } = Session.useSignedIn();
    if (info.organization === null) {
      return <Navigate to="/" replace />;
    }
    return (
      <SpineClient.Scope token={token} person={info.person.id} organization={info.organization.id}>
        <Organization.Members membership={info.organization} />
      </SpineClient.Scope>
    );
  },

  /**
   * Renders organization details, member email addresses, and roles.
   *
   * Loads members from the Access Desk API, shows loading and error states,
   * and provides a button to refresh the list.
   */
  Members: ({ membership }: { readonly membership: Membership }): ReactElement => {
    const [reading, setReading] = useState(0);
    const read = useEntityQuery(
      () => SpineClient.organization(membership.id),
      [membership.id, reading],
    );
    const state = read.status === "success" ? read.value.message[0]?.state : undefined;
    const view = state === undefined ? undefined : AnyPacker.unpack(state, OrganizationViewSchema);
    return (
      <section>
        <h1>{membership.name}</h1>
        <p>
          Identifier <code>{membership.id}</code>. You are its {membership.role ?? "guest"}.
        </p>
        <h2>Members</h2>
        {read.status === "idle" || read.status === "loading" ? (
          <p>Reading…</p>
        ) : view === undefined ? (
          <p role="alert">The query was refused, or found nothing.</p>
        ) : (
          <ul>
            {view.member.map((member) => (
              <li key={member.person?.uuid}>
                {member.emailAddress?.value}, {OrganizationRole[member.role].toLowerCase()}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => {
            setReading((count) => count + 1);
          }}
        >
          Read again
        </button>
      </section>
    );
  },
};
