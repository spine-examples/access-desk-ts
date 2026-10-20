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
import type { MembershipView } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import { call, eventually, givenGateway, request, stopGateways } from "./given/gateway.js";
import {
  addMember,
  addOrganizationMember,
  givenAdded,
  givenMaya,
  givenMember,
  member,
  membership,
  readMemberships,
} from "./given/membership.js";
import {
  accessRequest,
  catalogItem,
  givenOpenResource,
  givenTold,
  AuditTrail,
  readAuditTrail,
  readAuditTrailOfActor,
  readRequests,
  registerResource,
  submitRequest,
  watchCatalog,
} from "./given/resources.js";
import {
  challenge,
  complete,
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
    it("tell them who they are and the organization they belong to", async () => {
      const running = await givenGateway();

      const noah = await signIn(running, "noah");

      expect((await session(running, noah.token)).body).toEqual({
        person: { id: noah.person, email: "noah@acme.example", name: "Noah Reyes" },
        accounts: [{ provider: "google", subject: "noah" }],
        organization: { id: "acme", name: "acme", role: "administrator" },
      });
    });

    it("tell a person nobody added anywhere that they belong to no organization", async () => {
      const running = await givenGateway();

      const maya = await signIn(running, "maya");

      expect((await session(running, maya.token)).body.organization).toBeNull();
    });

    it("know the same person again at their next sign-in", async () => {
      const running = await givenGateway();

      const first = await signIn(running, "noah");
      const again = await signIn(running, "noah");

      expect(again.person).toBe(first.person);
      expect(again.token).not.toBe(first.token);
    });

    it("know them as the same person through another account, by their email address", async () => {
      const running = await givenGateway();

      const first = await signIn(running, "noah");
      const second = await signInWith(running, "fake", "noah-2:noah@acme.example:Noah Reyes");

      expect(second.person).toBe(first.person);
      expect(first.person).toMatch(/^[0-9a-f-]{36}$/);
      expect((await session(running, second.token)).body.accounts).toEqual([
        { provider: "google", subject: "noah" },
        { provider: "google", subject: "noah-2" },
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

    it("refuse a call from a page it does not know", async () => {
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

    it("list the identity providers a sign-in page may offer", async () => {
      const running = await givenGateway();

      const { status, body } = await call(running, "/auth/options");

      expect(status).toBe(200);
      expect(body).toEqual({
        external: [{ key: "fake", label: "Fake" }],
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
        organization: { id: "acme" },
      });
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

  describe("put a signed-in person in their organization, and", () => {
    it("put them in the organization they were added to, as they sign in", async () => {
      const running = await givenGateway();

      const noah = await signIn(running, "noah");

      expect((await session(running, noah.token)).body.organization).toEqual({
        id: "acme",
        name: "acme",
        role: "administrator",
      });
      expect(await member(running, "acme", noah.person)).toMatchObject({
        emailAddress: { value: "noah@acme.example" },
        role: OrganizationRole.ADMINISTRATOR,
      });
    });

    it("put a person added after their first sign-in in the organization at their next one", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");
      const first = await signIn(running, "maya");
      expect((await session(running, first.token)).body.organization).toBeNull();

      await givenAdded(running, noah, "acme", "maya@acme.example");
      await eventually(
        () => member(running, "acme", first.person),
        (joined) => joined !== undefined,
      );
      const next = await signIn(running, "maya");

      expect((await session(running, next.token)).body.organization).toMatchObject({
        id: "acme",
        role: "member",
      });
    });

    it("keep a person in the one organization they belong to", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");
      const olivia = await signIn(running, "olivia");

      expect(await addMember(running, olivia, "globex", "noah@acme.example")).toBe("ok");

      expect((await membership(running, "noah@acme.example"))?.organization?.uuid).toBe("acme");
      expect(await member(running, "globex", noah.person)).toBeUndefined();
      expect(
        (await session(running, (await signIn(running, "noah")).token)).body.organization,
      ).toMatchObject({ id: "acme" });
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

    it("show an administrator the audit trail of the whole organization", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const trail = await eventually(
        () => readAuditTrail(running, noah),
        (entries) => entries !== "refused" && entries.length >= 4,
      );

      expect(trail).not.toBe("refused");
      const seen = (trail === "refused" ? [] : trail).map((entry) => ({
        event: AuditTrail.eventOf(entry),
        actor: entry.actor?.uuid,
        person: AuditTrail.memberIn(entry),
        resource: entry.resource?.uuid,
      }));
      const empty = undefined;
      expect(seen).toHaveLength(4);
      expect(seen).toEqual(
        expect.arrayContaining([
          // Nobody added Noah, the first administrator, so he added himself. Noah added Maya.
          {
            event: "OrganizationMemberAdded",
            actor: noah.person,
            person: noah.person,
            resource: empty,
          },
          {
            event: "OrganizationMemberAdded",
            actor: noah.person,
            person: maya.person,
            resource: empty,
          },
          // The session says who registered and opened the resource.
          {
            event: "ResourceRegistered",
            actor: noah.person,
            person: empty,
            resource: "payroll",
          },
          {
            event: "ResourceOpenedForRequests",
            actor: noah.person,
            person: empty,
            resource: "payroll",
          },
        ]),
      );
    });

    it("show an administrator what one person did, the latest first", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);
      // Maya manages the ledger.
      expect(await registerResource(running, noah, "ledger", "acme", maya.person)).toBe("ok");

      const byNoah = await eventually(
        () => readAuditTrailOfActor(running, noah, noah.person),
        (entries) => entries !== "refused" && entries.length >= 5,
      );

      expect(byNoah).not.toBe("refused");
      const entries = byNoah === "refused" ? [] : byNoah;
      expect(entries.every((entry) => entry.actor?.uuid === noah.person)).toBe(true);
      // He added himself, as the first administrator, and then Maya.
      expect(entries.map((entry) => AuditTrail.eventOf(entry)).sort()).toEqual([
        "OrganizationMemberAdded",
        "OrganizationMemberAdded",
        "ResourceOpenedForRequests",
        "ResourceRegistered",
        "ResourceRegistered",
      ]);
      const moments = entries.map((entry) => entry.when?.seconds ?? 0n);
      expect(moments).toEqual(moments.toSorted((left, right) => Number(right - left)));
      // Not even of herself, as she administers nothing.
      expect(await readAuditTrailOfActor(running, maya, maya.person)).toBe("refused");
    });

    it("show a manager the audit trail of a resource they manage, and no other member any audit trail", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);
      // Maya manages nothing yet, and administers nothing.
      expect(await readAuditTrail(running, maya)).toBe("refused");
      expect(await readAuditTrail(running, maya, "payroll")).toBe("refused");
      expect(await registerResource(running, noah, "ledger", "acme", maya.person)).toBe("ok");

      const managed = await eventually(
        () => readAuditTrail(running, maya, "ledger"),
        (entries) => entries !== "refused" && entries.length === 1,
      );

      expect(
        managed === "refused" ? [] : managed.map((entry) => AuditTrail.eventOf(entry)),
      ).toEqual(["ResourceRegistered"]);
      expect(managed).toMatchObject([
        { resource: { uuid: "ledger" }, actor: { uuid: noah.person } },
      ]);
      // What she does not manage, and the whole organization, stay closed to her.
      expect(await readAuditTrail(running, maya, "payroll")).toBe("refused");
      expect(await readAuditTrail(running, maya)).toBe("refused");
    });

    it("keep an organization's audit trail from the administrators of another", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      await eventually(
        () => readAuditTrail(running, noah),
        (entries) => entries !== "refused" && entries.length >= 3,
      );
      const olivia = await givenMember(running, "olivia", "globex");

      // Globex's administrator sees only that she joined Globex.
      const globex = await eventually(
        () => readAuditTrail(running, olivia, undefined, "globex"),
        (entries) => entries !== "refused" && entries.length >= 1,
      );
      expect(globex === "refused" ? [] : globex.map((entry) => AuditTrail.memberIn(entry))).toEqual(
        [olivia.person],
      );
      // Acme's resource is not in Globex's audit trail, and Acme's audit trail is closed to her.
      expect(await readAuditTrail(running, olivia, "payroll", "globex")).toEqual([]);
      expect(await readAuditTrail(running, olivia)).toBe("refused");
    });

    it("refuse an administrator a resource registered for another organization", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const outcome = await registerResource(running, noah, "ledger", "globex");

      expect(outcome).not.toBe("ok");
      expect(await catalogItem(running, "acme", "ledger")).toBeUndefined();
    });

    it("send a browser nothing more of what it watched once its person signs out", async () => {
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

      // Whoever is still signed in hears of it, so the news did go out.
      expect(await his.hears("ledger")).toBe(true);
      expect(hers.received).not.toContain("ledger");
      expect(await hers.stops()).toBe(true);
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

    it("refuse a request aimed at an organization other than their own", async () => {
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

      const outcome = await addOrganizationMember(
        running,
        { ...noah, organization: "acme" },
        "acme",
        "somebody",
      );

      expect(outcome).not.toBe("ok");
      expect(await member(running, "acme", "somebody")).toBeUndefined();
    });

    it("refuse adding a person to another organization than their own", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const outcome = await addMember(
        running,
        noah,
        "globex",
        "somebody@acme.example",
        OrganizationRole.ADMINISTRATOR,
      );

      expect(outcome).not.toBe("ok");
      expect(await membership(running, "somebody@acme.example")).toBeUndefined();
    });

    it("refuse adding a person in the name of another administrator", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const outcome = await addMember(
        running,
        noah,
        "acme",
        "somebody@acme.example",
        OrganizationRole.MEMBER,
        "somebody-else",
      );

      expect(outcome).not.toBe("ok");
      expect(await membership(running, "somebody@acme.example")).toBeUndefined();
    });

    it("refuse a member what only an administrator may do", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const added = await addMember(running, maya, "acme", "somebody@acme.example");
      const listed = await readMemberships(running, maya, "acme");

      expect(added).not.toBe("ok");
      expect(listed).toBe("refused");
      expect(await membership(running, "somebody@acme.example")).toBeUndefined();
    });

    it("refuse an administrator the memberships of another organization", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const added = await addMember(running, noah, "globex", "maya@acme.example");
      const listed = await readMemberships(running, noah, "globex");

      expect(added).not.toBe("ok");
      expect(listed).toBe("refused");
      expect(await membership(running, "maya@acme.example")).toBeUndefined();
    });

    it("let an administrator add a person and see who was added", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      await givenAdded(running, noah, "acme", "maya@acme.example");

      const listed = await readMemberships(running, noah, "acme");
      expect(listed).not.toBe("refused");
      const byAddress = new Map(
        (listed as MembershipView[]).map((view) => [view.id?.emailAddress?.value, view] as const),
      );
      expect([...byAddress.keys()].sort()).toEqual(["maya@acme.example", "noah@acme.example"]);
      expect(byAddress.get("noah@acme.example")).toMatchObject({
        role: OrganizationRole.ADMINISTRATOR,
        person: { uuid: noah.person },
      });
      // Maya has not signed in yet, but she already is a person.
      expect(byAddress.get("maya@acme.example")?.role).toBe(OrganizationRole.MEMBER);
      expect(byAddress.get("maya@acme.example")?.person?.uuid).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("refuse somebody who has not signed in, or belongs to no organization", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await signIn(running, "maya");

      expect(await submitRequest(running, { person: noah.person }, "req-anonymous")).not.toBe("ok");
      expect(await submitRequest(running, maya, "req-nowhere")).not.toBe("ok");
    });
  });
});
