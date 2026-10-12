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

import type { BrowserAuthRoute } from "@spine-event-engine/server/browser";
import { create } from "@bufbuild/protobuf";
import { OrganizationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import type { AccessDesk } from "../access-desk.js";
import type { Sessions } from "../sessions.js";
import { REFUSED, UNAUTHENTICATED, UNAVAILABLE, type Route } from "./route.js";

/**
 * The addresses through which a signed-in person sees who they are, enters an
 * organization, and signs out.
 *
 * @param route How an address is made.
 * @param desk What the gateway asks of the application.
 * @param sessions The sessions of the people who have signed in.
 */
export function sessionRoutes(
  route: Route,
  desk: AccessDesk,
  sessions: Sessions,
): BrowserAuthRoute[] {
  return [
    /**
     * Tells who is signed in and which organizations are theirs. The page
     * asks when it opens, to learn whether the session it kept is still good,
     * and again after the person signs in, answers an invitation, or enters
     * an organization.
     *
     * Needs a session. Send `{}`.
     *
     * Answers `200` with:
     *
     * - `person: { id, email, name }`, the signed-in person;
     * - `accounts: [{ provider, subject }]`, the accounts they sign in with,
     *   such as `github` account `1001`;
     * - `organization`, the organization the session has entered, or `null`;
     * - `organizations: [{ id, name, standing, role }]`, every organization
     *   the person belongs to or is invited to. `standing` is `member` or
     *   `invited`. `role` is `member` or `administrator` for a member, and
     *   `null` for somebody only invited.
     *
     * Answers `401` when there is no session or it is no longer good.
     */
    route("/auth/session", async (_body, session) => {
      if (session === undefined) {
        return UNAUTHENTICATED;
      }
      // Which organizations are a person's to see is the application server's to say.
      const { accounts, standings } = await desk.profile(session.person);
      const views = await Promise.all(
        standings.map(({ organization }) => desk.organization(organization)),
      );
      const organizations = standings.flatMap(({ organization, standing }, index) => {
        const view = views[index];
        if (view === undefined) {
          return [];
        }
        const member = view.member.find(
          (candidate) => candidate.person?.uuid === session.person.id.uuid,
        );
        return [
          {
            id: organization.uuid,
            name: view.name,
            standing,
            role: member === undefined ? null : OrganizationRole[member.role].toLowerCase(),
          },
        ];
      });
      return [
        200,
        {
          person: {
            id: session.person.id.uuid,
            email: session.person.email.value,
            name: session.person.name,
          },
          accounts,
          organization: session.organization?.uuid ?? null,
          organizations,
        },
      ];
    }),

    /**
     * Enters an organization. The page calls it when the person chooses one
     * of the organizations they are a member of. Everything the person does
     * afterwards happens in that organization.
     *
     * Needs a session. Send `{ organization }`, the `id` of an organization
     * from `/auth/session` whose `standing` is `member`.
     *
     * Answers `200` with `{ token, person: { id, email, name }, organization }`.
     * `token` is a new session, bound to the organization. The earlier
     * session stops working, so whatever was open under it closes. To enter
     * another organization, call this again with the new session.
     *
     * Answers `401` without a session, `403` when the person is not a member
     * of that organization, and `503` when the session could not be issued
     * just now.
     */
    route("/auth/organization", async (body, session) => {
      const organization = body.organization;
      if (session === undefined) {
        return UNAUTHENTICATED;
      }
      const organizationId =
        typeof organization === "string" && organization !== ""
          ? create(OrganizationIdSchema, { uuid: organization })
          : undefined;
      // Only an organization Identity lists for the person is asked about
      // them. A made-up identifier never reaches an organization.
      if (
        organizationId === undefined ||
        !(await desk.joined(session.person.id, organizationId)) ||
        (await desk.member(organizationId, session.person.id)) === undefined
      ) {
        return REFUSED;
      }
      const entered = await sessions.issue(session.person, organizationId);
      if (entered === undefined) {
        return UNAVAILABLE;
      }
      await sessions.end(session);
      return [200, entered];
    }),

    /**
     * Ends the session, so its token stops working. The page calls it when
     * the person signs out.
     *
     * Send `{}` with the session to end.
     *
     * Answers `200` with `{}`, also when there was no session to end.
     */
    route("/auth/sign-out", async (_body, session) => {
      if (session !== undefined) {
        await sessions.end(session);
      }
      return [200, {}];
    }),
  ];
}
