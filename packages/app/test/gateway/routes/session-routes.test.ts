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

import { describe, expect, it, vi } from "vitest";
import { organization, sessionRoutesFixture as fixture } from "../given/session-routes.js";

describe("Gateway session routes should", () => {
  it("serialize typed session values with the organization the session works in", async () => {
    const { call, desk } = fixture();

    const response = await call("/auth/session");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      person: { id: "person-1", email: "maya@example.com", name: "Maya" },
      accounts: [{ provider: "google", subject: "1" }],
      organization: { id: "acme", name: "Acme", role: "administrator" },
    });
    expect(desk.organization).toHaveBeenCalledWith(organization);
  });

  it("tell a person who belongs to no organization that they have none", async () => {
    const { call, sessions, desk } = fixture();
    sessions.resolve.mockResolvedValueOnce({
      principal: { id: "person-1", attributes: { email: "maya@example.com", name: "Maya" } },
    });

    const response = await call("/auth/session");

    expect(((await response.json()) as { organization: unknown }).organization).toBeNull();
    expect(desk.organization).not.toHaveBeenCalled();
  });

  it("return 401 for a session request without a resolved bearer session", async () => {
    const { call, sessions, desk } = fixture();
    sessions.resolve.mockResolvedValueOnce(undefined);

    const response = await call("/auth/session");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not signed in" });
    expect(desk.profile).not.toHaveBeenCalled();
  });

  it("answer 503 when the application server cannot be asked", async () => {
    const { call, desk } = fixture();
    desk.profile.mockRejectedValueOnce(new Error("The application server is away."));
    const silenced = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await call("/auth/session");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "try again" });
    expect(silenced).toHaveBeenCalled();
    silenced.mockRestore();
  });

  it("end the session of the token a request carries, and then forget the ended sessions that expired", async () => {
    const { call, sessions, ended } = fixture();

    const response = await call("/auth/sign-out");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(sessions.logout).toHaveBeenCalledWith({ kind: "bearer", value: "token" });
    expect(ended.purgeExpired).toHaveBeenCalledOnce();
  });

  it("end a token that does not resolve as well, and answer a request without a token", async () => {
    const { call, sessions, ended } = fixture();
    sessions.resolve.mockResolvedValue(undefined);
    sessions.logout.mockResolvedValueOnce({ kind: "expiryOnly" });

    expect((await call("/auth/sign-out")).status).toBe(200);
    expect(sessions.logout).toHaveBeenCalledOnce();
    // No session ended, so the gateway forgets nothing.
    expect(ended.purgeExpired).not.toHaveBeenCalled();

    sessions.logout.mockClear();
    expect((await call("/auth/sign-out", null)).status).toBe(200);
    expect(sessions.logout).not.toHaveBeenCalled();
  });

  it("ask to sign out again when the gateway could not remember that the session ended", async () => {
    const { call, sessions, ended } = fixture();
    const silenced = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sessions.logout.mockResolvedValueOnce({ kind: "unavailable" });

    const response = await call("/auth/sign-out");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "try again" });
    expect(ended.purgeExpired).not.toHaveBeenCalled();
    silenced.mockRestore();
  });

  it("sign out even when the ended sessions that expired cannot be forgotten", async () => {
    const { call, ended } = fixture();
    const silenced = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ended.purgeExpired.mockRejectedValueOnce(new Error("The store is down."));

    const response = await call("/auth/sign-out");

    expect(response.status).toBe(200);
    expect(silenced).toHaveBeenCalled();
    silenced.mockRestore();
  });
});
