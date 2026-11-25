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
import { vi } from "vitest";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import type { AccessDesk } from "../../../src/gateway/access-desk.js";
import { routing } from "../../../src/gateway/routes/route.js";
import { sessionRoutes } from "../../../src/gateway/routes/session-routes.js";

const person = create(PersonIdSchema, { uuid: "person-1" });
export const organization = create(OrganizationIdSchema, { value: "acme" });

/** The person a session stands for, as the gateway signed it. */
const principal = {
  id: "person-1",
  attributes: { email: "maya@example.com", name: "Maya", organization: "acme" },
};

/**
 * Creates the session routes over sessions, ended sessions, and a desk that
 * are stand-ins.
 */
export function sessionRoutesFixture() {
  const sessions = {
    resolve: vi.fn().mockResolvedValue({ principal }),
    logout: vi.fn().mockResolvedValue({ kind: "revoked" }),
  };
  const ended = { purgeExpired: vi.fn().mockResolvedValue(0) };
  const desk = {
    profile: vi.fn().mockResolvedValue({
      accounts: [{ provider: "google", subject: "1" }],
      organization,
    }),
    organization: vi.fn().mockResolvedValue(
      create(OrganizationViewSchema, {
        id: organization,
        name: "Acme",
        member: [{ person, role: OrganizationRole.ADMINISTRATOR }],
      }),
    ),
  };
  const routes = sessionRoutes(
    routing(["https://app.test"], sessions),
    desk as unknown as AccessDesk,
    sessions,
    ended,
  );
  /**
   * Calls a route, with a session token unless told otherwise.
   *
   * @param path The route's path.
   * @param authorization The `Authorization` header. None when `null`.
   */
  const call = async (
    path: string,
    authorization: string | null = "Bearer token",
  ): Promise<Response> => {
    const route = routes.find((candidate) => candidate.path === path);
    if (route === undefined) {
      throw new Error(`Missing route ${path}`);
    }
    return route.onRequest(
      new Request(`https://gateway.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === null ? {} : { authorization }),
        },
        body: "{}",
      }),
      new AbortController().signal,
    );
  };
  return { sessions, ended, desk, routes, call };
}
