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

import { afterEach, describe, expect, it } from "vitest";
import type { InvitationView } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import {
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import { call, eventually, givenGateway, request, stopGateways } from "./given/gateway.js";
import {
  acceptInvitation,
  declineInvitation,
  givenInvited,
  givenMaya,
  givenMember,
  invitation,
  inviteMember,
  member,
  readInvitations,
  revokeInvitation,
} from "./given/membership.js";
import {
  accessRequest,
  catalogItem,
  givenOpenResource,
  givenTold,
  readRequests,
  registerResource,
  submitRequest,
  watchCatalog,
} from "./given/resources.js";
import {
  challenge,
  complete,
  enter,
  entering,
  session,
  signIn,
  signInWith,
  signOut,
  start,
  verifier,
} from "./given/sign-in.js";

afterEach(stopGateways);

describe("The gateway should", () => {
  describe("sign a person in, and", () => {
    it("tell them who they are and which invitations wait for them, in no organization", async () => {
      const running = await givenGateway();

      const noah = await signIn(running, "noah");

      expect((await session(running, noah.token)).body).toEqual({
        person: { id: noah.person, email: "noah@acme.example", name: "Noah Reyes" },
        accounts: [{ provider: "github", subject: "noah" }],
        organization: null,
        organizations: [{ id: "acme", name: "acme", standing: "invited", role: null }],
      });
    });

    it("know the same person again at their next sign-in", async () => {
      const running = await givenGateway();

      const first = await signIn(running, "noah");
      const again = await signIn(running, "noah");

      expect(again.person).toBe(first.person);
      expect(again.token).not.toBe(first.token);
    });

    it("know them as the same person through another provider, by their email address", async () => {
      const running = await givenGateway();

      const throughGitHub = await signIn(running, "noah", "github");
      const throughGoogle = await signIn(running, "noah", "google");

      expect(throughGoogle.person).toBe(throughGitHub.person);
      expect(throughGitHub.person).toMatch(/^[0-9a-f-]{36}$/);
      expect((await session(running, throughGoogle.token)).body.accounts).toEqual([
        { provider: "github", subject: "noah" },
        { provider: "google", subject: "noah" },
      ]);
    });

    it("keep people with different email addresses apart", async () => {
      const running = await givenGateway();

      const noah = await signIn(running, "noah");
      const maya = await signIn(running, "maya");

      expect(maya.person).not.toBe(noah.person);
    });

    it("refuse a caller without a session", async () => {
      const running = await givenGateway();

      expect((await session(running)).status).toBe(401);
      expect((await session(running, "no-such-token")).status).toBe(401);
    });

    it("refuse a call from a page it was not told about", async () => {
      const running = await givenGateway();

      const answered = await request(running, "/auth/options", "{}", {
        origin: "https://elsewhere.example",
      });

      expect(answered.status).toBe(403);
    });

    it("refuse malformed, scalar, and array JSON at a browser auth endpoint", async () => {
      const running = await givenGateway();

      for (const body of ["not-json", "null", "7", '"word"', "[]"]) {
        const response = await request(running, "/auth/options", body);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "refused" });
      }
    });

    it("answer auth routes as noncacheable JSON", async () => {
      const running = await givenGateway();

      const response = await request(running, "/auth/options", "{}");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("tell a sign-in page which identity providers it may offer", async () => {
      const running = await givenGateway();

      const { status, body } = await call(running, "/auth/options");

      expect(status).toBe(200);
      expect(body).toEqual({
        external: [
          { key: "fake", label: "Fake" },
          { key: "other", label: "Fake" },
        ],
      });
    });

    it("end the session when they sign out", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect((await signOut(running, noah.token)).status).toBe(200);

      expect((await session(running, noah.token)).status).toBe(401);
    });

    it("allow sign-out without a session and refuse malformed session credentials", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect(await signOut(running)).toEqual({ status: 200, body: {} });
      expect((await session(running, `not-${noah.token}`)).status).toBe(401);
      expect((await session(running, noah.token)).status).toBe(200);
    });
  });

  describe("sign a person in through an outside identity provider, and", () => {
    it("give them a session once the provider has confirmed them", async () => {
      const running = await givenGateway();
      const state = await start(running);

      const completed = await complete(running, { state, code: "1001:Noah@Acme.example" });

      expect(completed.status).toBe(200);
      expect((await session(running, completed.body.token as string)).body).toMatchObject({
        person: { email: "noah@acme.example", name: "Noah@Acme.example" },
        organizations: [{ id: "acme", standing: "invited" }],
      });
    });

    it("sign in the same person through a second provider under the same email address", async () => {
      const running = await givenGateway();

      const first = await signInWith(running, "fake", "1001:noah@acme.example");
      const second = await signInWith(running, "other", "g-7:noah@acme.example");
      const somebodyElse = await signInWith(running, "other", "g-8:maya@acme.example");

      expect(second.person).toBe(first.person);
      expect(somebodyElse.person).not.toBe(first.person);
    });

    it("refuse a provider it was not set up with", async () => {
      const running = await givenGateway();

      const started = await call(running, "/auth/external/start", {
        provider: "unknown",
        codeChallenge: challenge,
      });

      expect(started.status).toBe(403);
    });

    it("refuse missing or nonstring sign-in inputs", async () => {
      const running = await givenGateway();

      for (const body of [
        {},
        { provider: 7, codeChallenge: challenge },
        { provider: "fake" },
        { provider: "fake", codeChallenge: 7 },
      ]) {
        expect((await call(running, "/auth/external/start", body)).status).toBe(403);
      }
      for (const body of [
        {},
        { provider: 7, state: "x", code: "x", codeVerifier: verifier },
        { provider: "fake", state: 7, code: "x", codeVerifier: verifier },
        { provider: "fake", state: "x", code: 7, codeVerifier: verifier },
        { provider: "fake", state: "x", code: "x", codeVerifier: 7 },
      ]) {
        expect((await call(running, "/auth/external/complete", body)).status).toBe(403);
      }
    });

    it("refuse an answer for a sign-in it never started, or one already used", async () => {
      const running = await givenGateway();
      const answer = { state: await start(running), code: "1001:noah@acme.example" };

      expect((await complete(running, { ...answer, state: "not-issued" })).status).toBe(403);
      expect((await complete(running, answer)).status).toBe(200);
      expect((await complete(running, answer)).status).toBe(403);
    });

    it("refuse an answer from a browser that does not hold the secret the sign-in started with", async () => {
      const running = await givenGateway();
      const state = await start(running);

      const completed = await complete(running, {
        state,
        code: "1001:noah@acme.example",
        codeVerifier: "w".repeat(43),
      });

      expect(completed.status).toBe(403);
    });

    it("refuse an account the provider has verified no email address for", async () => {
      const running = await givenGateway();
      const state = await start(running);

      const completed = await complete(running, { state, code: "1001:" });

      expect(completed.status).toBe(403);
    });
  });

  describe("let a signed-in person into an organization, and", () => {
    it("make them a member when they accept the invitation waiting for them", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect(await acceptInvitation(running, noah, "acme")).toBe("ok");

      const told = await eventually(
        () => session(running, noah.token),
        ({ body }) => (body.organizations as { standing: string }[])[0]?.standing === "member",
      );
      expect(told.body.organizations).toEqual([
        { id: "acme", name: "acme", standing: "member", role: "administrator" },
      ]);
      expect(await member(running, "acme", noah.person)).toMatchObject({
        name: "Noah Reyes",
        role: OrganizationRole.ADMINISTRATOR,
      });
    });

    it("drop the invitation they decline, so they can no longer accept it", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect(await declineInvitation(running, noah, "acme")).toBe("ok");

      await eventually(
        () => session(running, noah.token),
        ({ body }) => (body.organizations as unknown[]).length === 0,
      );
      await acceptInvitation(running, noah, "acme");
      expect((await entering(running, noah.token, "acme")).status).toBe(403);
      expect(await member(running, "acme", noah.person)).toBeUndefined();
    });

    it("refuse an answer to an invitation sent to somebody else", async () => {
      const running = await givenGateway();
      const maya = await signIn(running, "maya");
      const sentToNoah = { invitee: "noah@acme.example" };

      const accepted = await acceptInvitation(running, maya, "acme", sentToNoah);
      const declined = await declineInvitation(running, maya, "acme", sentToNoah);

      expect(accepted).not.toBe("ok");
      expect(declined).not.toBe("ok");
      expect((await invitation(running, "acme", "noah@acme.example"))?.status).toBe(
        InvitationStatus.PENDING,
      );
      expect(await member(running, "acme", maya.person)).toBeUndefined();
    });

    it("refuse an answer given in another person's name", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      const accepted = await acceptInvitation(running, noah, "acme", { person: "somebody-else" });

      expect(accepted).not.toBe("ok");
      expect(await member(running, "acme", "somebody-else")).toBeUndefined();
    });

    it("keep out of an organization that did not invite them", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      await acceptInvitation(running, noah, "globex");

      expect((await entering(running, noah.token, "globex")).status).toBe(403);
      expect(await member(running, "globex", noah.person)).toBeUndefined();
    });

    it("refuse entering an organization without a session or scalar organization id", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect((await entering(running, undefined, "acme")).status).toBe(401);
      for (const organization of [undefined, null, 7, { uuid: "acme" }]) {
        expect((await entering(running, noah.token, organization)).status).toBe(403);
      }
    });

    it("refuse an empty organization id without rotating the session", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      const entered = await entering(running, noah.token, "");

      expect(entered).toEqual({ status: 403, body: { error: "refused" } });
      const current = await session(running, noah.token);
      expect(current.status).toBe(200);
      expect(current.body.organization).toBeNull();
    });

    it("exchange the session when they enter, so the earlier one stops working", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");
      await acceptInvitation(running, noah, "acme");
      await eventually(
        () => member(running, "acme", noah.person),
        (joined) => joined !== undefined,
      );

      const entered = await enter(running, noah, "acme");

      expect(entered.token).not.toBe(noah.token);
      expect((await session(running, noah.token)).status).toBe(401);
      expect((await session(running, entered.token)).body.organization).toBe("acme");
    });
  });

  describe("carry a member's commands and queries, and", () => {
    it("let a member submit a request in their own name and read it back", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      expect(await submitRequest(running, maya, "req-1")).toBe("ok");

      const requests = await eventually(
        () => readRequests(running, maya),
        (views) => views !== "refused" && views.length === 1,
      );
      expect(requests).toMatchObject([
        { id: { uuid: "req-1" }, snapshot: { requester: { uuid: maya.person } } },
      ]);
    });

    it("show a member their own requests, and nobody else's", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);
      expect(await submitRequest(running, maya, "req-maya")).toBe("ok");
      expect(await submitRequest(running, noah, "req-noah")).toBe("ok");

      const own = await eventually(
        () => readRequests(running, maya),
        (views) => views !== "refused" && views.length === 1,
      );

      expect(own).toMatchObject([{ id: { uuid: "req-maya" } }]);
      // Everything of the organization, and what somebody else asked for, are not hers to see.
      expect(await readRequests(running, maya, "all")).toBe("refused");
      expect(await readRequests(running, maya, { requester: noah.person })).toBe("refused");
    });

    it("show a manager the requests for a resource they manage, and no other member", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);
      expect(await submitRequest(running, maya, "req-maya")).toBe("ok");

      const managed = await eventually(
        () => readRequests(running, noah, { resource: "payroll" }),
        (views) => views !== "refused" && views.length === 1,
      );

      expect(managed).toMatchObject([
        { id: { uuid: "req-maya" }, requester: { uuid: maya.person } },
      ]);
      expect(await readRequests(running, maya, { resource: "payroll" })).toBe("refused");
    });

    it("refuse an administrator a resource registered for another organization", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const outcome = await registerResource(running, noah, "ledger", "globex");

      expect(outcome).not.toBe("ok");
      expect(await catalogItem(running, "acme", "ledger")).toBeUndefined();
    });

    it("tell a browser nothing more of what it watched once its person signs out", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");
      const maya = await givenMaya(running, noah);
      const hers = await watchCatalog(running, maya);
      const his = await watchCatalog(running, noah);
      await givenTold(running, noah, hers);
      await givenTold(running, noah, his);
      expect(await registerResource(running, noah, "payroll")).toBe("ok");
      expect(await hers.hears("payroll")).toBe(true);

      expect((await signOut(running, maya.token)).status).toBe(200);
      expect(await registerResource(running, noah, "ledger")).toBe("ok");

      // Whoever is still signed in is told, so the news did go out.
      expect(await his.hears("ledger")).toBe(true);
      expect(hers.told).not.toContain("ledger");
      expect(await hers.stops()).toBe(true);
    });

    it("stop what a person watched in an organization once they enter it anew", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");
      const earlier = await watchCatalog(running, noah);
      await givenTold(running, noah, earlier);

      // Entering exchanges the session, and the earlier one ends.
      const entered = await enter(running, noah, "acme");

      const later = await watchCatalog(running, entered);
      await givenTold(running, entered, later);
      expect(await registerResource(running, entered, "payroll")).toBe("ok");
      expect(await later.hears("payroll")).toBe(true);
      expect(earlier.told).not.toContain("payroll");
    });

    it("refuse a command given in another person's name", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const outcome = await submitRequest(running, maya, "req-spoofed", {
        requester: noah.person,
      });

      expect(outcome).not.toBe("ok");
      // The session says who is acting, whatever the client claims.
      expect(
        await submitRequest(running, { token: maya.token, person: noah.person }, "req-spoofed"),
      ).not.toBe("ok");
      expect(await accessRequest(running, "acme", "req-spoofed")).toBeUndefined();
    });

    it("refuse a request aimed at an organization other than the one entered", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const outcome = await submitRequest(running, maya, "req-elsewhere", {
        organization: "globex",
      });

      expect(outcome).not.toBe("ok");
      expect(await readRequests(running, maya, "own", "globex")).toBe("refused");
    });

    it("refuse a command only the application itself gives", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const outcome = await inviteMember(
        running,
        { ...noah, organization: "acme" },
        "globex",
        "somebody@acme.example",
        OrganizationRole.ADMINISTRATOR,
      );

      expect(outcome).not.toBe("ok");
      expect(await invitation(running, "globex", "somebody@acme.example")).toBeUndefined();
    });

    it("refuse a member what only an administrator may do", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const invited = await inviteMember(running, maya, "acme", "olivia@acme.example");
      const listed = await readInvitations(running, maya, "acme");

      expect(invited).not.toBe("ok");
      expect(listed).toBe("refused");
      expect(await invitation(running, "acme", "olivia@acme.example")).toBeUndefined();
    });

    it("refuse an administrator the invitations of another organization", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const invited = await inviteMember(running, noah, "globex", "maya@acme.example");
      const listed = await readInvitations(running, noah, "globex");

      expect(invited).not.toBe("ok");
      expect(listed).toBe("refused");
      expect(await invitation(running, "globex", "maya@acme.example")).toBeUndefined();
    });

    it("let an administrator see the organization's invitations and take one back", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");
      await givenInvited(running, noah, "acme", "maya@acme.example");

      const revoked = await revokeInvitation(running, noah, "acme", "maya@acme.example");

      expect(revoked).toBe("ok");
      await eventually(
        () => invitation(running, "acme", "maya@acme.example"),
        (invited) => invited?.status === InvitationStatus.REVOKED,
      );
      const listed = await readInvitations(running, noah, "acme");
      expect(listed).not.toBe("refused");
      expect(
        (listed as InvitationView[])
          .map((view) => [view.invitee?.value, view.status, view.acceptedBy?.uuid])
          .sort(),
      ).toEqual([
        ["maya@acme.example", InvitationStatus.REVOKED, undefined],
        ["noah@acme.example", InvitationStatus.ACCEPTED, noah.person],
      ]);
    });

    it("refuse somebody who has not signed in, or has not entered an organization", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);
      const signedInOnly = await signIn(running, "maya");

      expect(await submitRequest(running, { person: maya.person }, "req-anonymous")).not.toBe("ok");
      expect(
        await submitRequest(running, signedInOnly, "req-not-entered", { requester: maya.person }),
      ).not.toBe("ok");
    });
  });
});
