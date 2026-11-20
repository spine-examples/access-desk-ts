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

import type { PersistentTokenRevocations, SignedSessions } from "@spine-event-engine/auth";
import { Time } from "@spine-event-engine/core/time";
import type { BrowserAuthRoute } from "@spine-event-engine/server/browser";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import type { AccessDesk } from "../access-desk.js";
import { SessionToken, UNAUTHENTICATED, UNAVAILABLE, type Route } from "./route.js";

/**
 * Creates the endpoints that show who is signed in, and sign them out.
 *
 * @param route Creates an endpoint.
 * @param desk Looks up people and organizations.
 * @param sessions The sessions of the people who have signed in.
 * @param ended The sessions people ended, kept while their tokens would
 *   still be taken.
 */
export function sessionRoutes(
  route: Route,
  desk: AccessDesk,
  sessions: Pick<SignedSessions, "logout">,
  ended: Pick<PersistentTokenRevocations, "purgeExpired">,
): BrowserAuthRoute[] {
  return [
    /**
     * Tells who is signed in and which organization they belong to.
     *
     * The page calls it when it opens, and again after the person signs in.
     *
     * Needs a session. Send `{}`.
     *
     * Answers `200` with:
     *
     * - `person: { id, email, name }`, the signed-in person;
     * - `accounts: [{ provider, subject }]`, the accounts they sign in with;
     * - `organization: { id, name, role }`, the organization the session
     *   works in, or `null`. `role` is `member` or `administrator`.
     *
     * Answers `401` without a session.
     */
    route("/auth/session", async (_body, session) => {
      if (session === undefined) {
        return UNAUTHENTICATED;
      }
      const { accounts } = await desk.profile(session.person);
      const view =
        session.organization === undefined
          ? undefined
          : await desk.organization(session.organization);
      const member = view?.member.find(
        (candidate) => candidate.person?.uuid === session.person.id.uuid,
      );
      return [
        200,
        {
          person: {
            id: session.person.id.uuid,
            email: session.person.email.value,
            name: session.person.name,
          },
          accounts,
          organization:
            view === undefined || session.organization === undefined
              ? null
              : {
                  id: session.organization.uuid,
                  name: view.name,
                  role: member === undefined ? null : OrganizationRole[member.role].toLowerCase(),
                },
        },
      ];
    }),

    /**
     * Signs the person out. Everything they watch stops, and the session no
     * longer works.
     *
     * A token that does not resolve is ended as well. It may still be good,
     * as when the gateway could not tell whether its session had ended.
     *
     * Send `{}`. Answers `200` with `{}`, with or without a session, and `503`
     * when the gateway could not remember that the session ended.
     */
    route("/auth/sign-out", async (_body, _session, request) => {
      const token = SessionToken.of(request);
      const outcome = token === undefined ? undefined : await sessions.logout(token);
      if (outcome?.kind === "unavailable") {
        console.warn("The gateway could not remember that a session ended.");
        return UNAVAILABLE;
      }
      if (outcome?.kind === "revoked") {
        try {
          await ended.purgeExpired(Time.currentTime());
        } catch (error) {
          console.warn("The gateway could not forget the sessions whose tokens expired.", error);
        }
      }
      return [200, {}];
    }),
  ];
}
