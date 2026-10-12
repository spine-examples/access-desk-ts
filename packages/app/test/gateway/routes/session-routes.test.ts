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
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { describe, expect, it, vi } from "vitest";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import type { AccessDesk } from "../../../src/gateway/access_desk.js";
import { routing } from "../../../src/gateway/routes/route.js";
import { sessionRoutes } from "../../../src/gateway/routes/session-routes.js";
import type { Issued, Session, Sessions } from "../../../src/gateway/sessions.js";

const person = {
  id: create(PersonIdSchema, { uuid: "person-1" }),
  email: create(EmailAddressSchema, { value: "maya@example.com" }),
  name: "Maya",
};
const organization = create(OrganizationIdSchema, { uuid: "acme" });
const session: Session = {
  credential: { kind: "cookie", value: "old-token" },
  person,
  organization: undefined,
};

function fixture() {
  const sessions = {
    of: vi.fn().mockResolvedValue(session),
    issue: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const desk = {
    standings: vi.fn().mockResolvedValue([{ organization, standing: "member" }]),
    organization: vi.fn().mockResolvedValue(
      create(OrganizationViewSchema, {
        id: organization,
        name: "Acme",
        member: [{ person: person.id, role: OrganizationRole.ADMINISTRATOR }],
      }),
    ),
    accounts: vi.fn().mockResolvedValue([{ provider: "github", subject: "1" }]),
    member: vi.fn().mockResolvedValue({ person: person.id, role: OrganizationRole.ADMINISTRATOR }),
  };
  const routes = sessionRoutes(
    routing(["https://app.test"], sessions as unknown as Sessions),
    desk as unknown as AccessDesk,
    sessions as unknown as Sessions,
  );
  const call = async (path: string, body: object = {}): Promise<Response> => {
    const route = routes.find((candidate) => candidate.path === path);
    if (route === undefined) {
      throw new Error(`Missing route ${path}`);
    }
    return route.onRequest(
      new Request(`https://gateway.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      new AbortController().signal,
    );
  };
  return { sessions, desk, routes, call };
}

describe("Gateway session routes should", () => {
  it("serialize typed session values and skip organizations without a view", async () => {
    const { call, desk } = fixture();
    const missing = create(OrganizationIdSchema, { uuid: "missing" });
    desk.standings.mockResolvedValueOnce([
      { organization, standing: "member" },
      { organization: missing, standing: "invited" },
    ]);
    desk.organization
      .mockResolvedValueOnce(
        create(OrganizationViewSchema, {
          id: organization,
          name: "Acme",
          member: [{ person: person.id, role: OrganizationRole.ADMINISTRATOR }],
        }),
      )
      .mockResolvedValueOnce(undefined);

    const response = await call("/auth/session");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      person: { id: "person-1", email: "maya@example.com", name: "Maya" },
      accounts: [{ provider: "github", subject: "1" }],
      organization: null,
      organizations: [{ id: "acme", name: "Acme", standing: "member", role: "administrator" }],
    });
    expect(desk.organization).toHaveBeenCalledWith(organization);
  });

  it("return 401 for a session request without a resolved bearer session", async () => {
    const { call, sessions, desk } = fixture();
    sessions.of.mockResolvedValueOnce(undefined);

    const response = await call("/auth/session");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not signed in" });
    expect(desk.standings).not.toHaveBeenCalled();
  });

  it("return 503 without ending the old session when a replacement cannot be issued", async () => {
    const { call, sessions, desk } = fixture();

    const response = await call("/auth/organization", { organization: "acme" });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "try again" });
    expect(desk.member).toHaveBeenCalledWith(expect.objectContaining({ uuid: "acme" }), person.id);
    expect(sessions.issue).toHaveBeenCalledWith(person, expect.objectContaining({ uuid: "acme" }));
    expect(sessions.end).not.toHaveBeenCalled();
  });

  it("end the earlier session only after issuing a replacement", async () => {
    const { call, sessions } = fixture();
    const issued: Issued = {
      token: "new-token",
      person: { id: "person-1", email: "maya@example.com", name: "Maya" },
      organization: "acme",
    };
    sessions.issue.mockResolvedValueOnce(issued);

    const response = await call("/auth/organization", { organization: "acme" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(issued);
    expect(sessions.end).toHaveBeenCalledWith(session);
  });

  it("sign out with or without a session", async () => {
    const { call, sessions } = fixture();
    const signedOut = await call("/auth/sign-out");
    expect(signedOut.status).toBe(200);
    expect(sessions.end).toHaveBeenCalledWith(session);

    sessions.end.mockClear();
    sessions.of.mockResolvedValueOnce(undefined);
    const alreadyOut = await call("/auth/sign-out");
    expect(alreadyOut.status).toBe(200);
    expect(sessions.end).not.toHaveBeenCalled();
  });
});
