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

import { createHash } from "node:crypto";
import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { Client } from "@spine-event-engine/client-web";
import { AnyMessages, SignalEnvelopes, TypeUrls } from "@spine-event-engine/core";
import { TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import { QueryIdSchema, QuerySchema, TargetSchema } from "@spine-event-engine/proto/client";
import { type BoundedContext, Server, SignalMetadata } from "@spine-event-engine/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AccessRequestViewSchema,
  type AccessRequestView,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import { SubmitAccessRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  InvitationIdSchema,
  OrganizationIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AcceptInvitationSchema,
  DeclineInvitationSchema,
  InviteMemberSchema,
  RevokeInvitationSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/commands_pb.js";
import {
  InvitationViewSchema,
  type InvitationView,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import { InvitationViewQuery } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_query.js";
import {
  IdentityProvider,
  InvitationStatus,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import {
  AccessRequestIdSchema,
  ResourceIdSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { OpenResourceForRequestsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/commands_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import {
  Sensitivity,
  type OrganizationMember,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

// Imported from compiled output, like the contexts it assembles: vitest cannot
// execute the handler classes' standard decorators from raw TypeScript source.
type AppModule = typeof import("../../dist/src/index.js");
let app: AppModule;
beforeAll(async () => {
  app = await import("../../dist/src/index.js");
}, 30_000);

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** The address of the page that calls the gateway. */
const ORIGIN = "http://app.test";
/** The page an outside identity provider sends people back to. */
const CALLBACK = "https://app.test/signed-in";

/** The people of the tests, by the key each is chosen with. */
const PEOPLE = {
  maya: { email: "maya@acme.example", name: "Maya Chen" },
  noah: { email: "noah@acme.example", name: "Noah Reyes" },
  olivia: { email: "olivia@acme.example", name: "Olivia Park" },
};

/** The identity providers of the tests, by what each stands for. */
const PROVIDERS = { github: "fake", google: "other" } as const;

/** The secret a browser keeps while it signs in, and its fingerprint. */
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

type External = NonNullable<Parameters<AppModule["startGateway"]>[0]["external"]>;

/**
 * An identity provider that confirms `<subject>:<email>:<name>` codes, for the
 * tests. A code without an email address stands for an account the provider
 * has verified no address for. The name may be left out.
 */
function fakeProvider(kind: IdentityProvider, issuer: string): External[string] {
  return {
    callbackUri: CALLBACK,
    provider: {
      kind,
      label: "Fake",
      authorizationEndpoint: `${issuer}/authorize`,
      clientId: "access-desk-tests",
      scopes: ["openid"],
      provider: {
        issuer,
        exchangeAuthorizationCode({ code }) {
          const [subject = "", email = "", name = ""] = code.split(":");
          return Promise.resolve(
            subject === "" || email === ""
              ? undefined
              : app.describeIdentity(issuer, subject, email, name === "" ? undefined : name),
          );
        },
      },
    },
  };
}

/** The running application behind its gateway. */
interface Running {
  readonly url: string;
  readonly resources: BoundedContext;
  readonly identity: BoundedContext;
}

/**
 * Starts the application with Acme, administered by `noah`, and Globex,
 * administered by `olivia`, behind a gateway with
 * two fake identity providers.
 */
async function givenGateway(): Promise<Running> {
  let address = "";
  const contexts = await app.assembleAccessDesk({ server: () => address });
  const hosted = await new Server({
    contexts: [contexts.identity, contexts.resources],
    port: 0,
  }).start();
  address = hosted.baseUrl;
  await givenOrganization(contexts, "acme", "noah@acme.example");
  await givenOrganization(contexts, "globex", "olivia@acme.example");
  const gateway = await app.startGateway({
    backend: hosted.baseUrl,
    registry: app.typeRegistry,
    origins: [ORIGIN],
    port: 0,
    external: {
      fake: fakeProvider(IdentityProvider.GITHUB, "https://provider.test"),
      other: fakeProvider(IdentityProvider.GOOGLE, "https://other.test"),
    },
  });
  // The gateway and the application server are separate, so each is stopped.
  stop = async () => {
    await gateway.close();
    await hosted.close();
    await contexts.close();
  };
  return { url: gateway.url, resources: contexts.resources, identity: contexts.identity };
}

/** Gives a context a command in the application's own name, as nothing outside the tests does yet. */
async function give<Schema extends GenMessage<Message>>(
  context: BoundedContext,
  schema: Schema,
  command: MessageShape<Schema>,
  organization?: string,
): Promise<void> {
  await context.commandBus().post(
    SignalEnvelopes.command({
      context: new SignalMetadata().commandContext({
        actor: create(UserIdSchema, { value: "access-desk" }),
        ...(organization === undefined ? {} : { tenantId: tenant(organization) }),
      }),
      schema,
      message: command,
    }),
  );
}

/**
 * Creates an organization and invites its first administrator.
 *
 * The application has no way of creating an organization yet, so the tests
 * give the two commands themselves.
 */
async function givenOrganization(
  contexts: { readonly resources: BoundedContext; readonly identity: BoundedContext },
  name: string,
  administrator: string,
): Promise<void> {
  await give(
    contexts.resources,
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: organizationId(name), name }),
    name,
  );
  await give(
    contexts.identity,
    InviteMemberSchema,
    create(InviteMemberSchema, {
      id: invitationId(name, administrator),
      role: OrganizationRole.ADMINISTRATOR,
    }),
  );
}

function organizationId(organization: string) {
  return create(OrganizationIdSchema, { uuid: organization });
}

function tenant(organization: string) {
  return create(TenantIdSchema, { kind: { case: "value", value: organization } });
}

/** A JSON answer of the gateway. */
interface Answered {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Calls a sign-in or session address of the gateway from the application's page. */
async function call(
  running: Running,
  path: string,
  body: object = {},
  token?: string,
  origin: string = ORIGIN,
): Promise<Answered> {
  const response = await fetch(`${running.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** A person signed in through the gateway. */
interface Signed {
  readonly token: string;
  readonly person: string;
  /** The email address the person is registered under. */
  readonly email: string;
  /** The person's display name. */
  readonly name: string;
}

/** Starts a sign-in and returns the state the provider sends back with its answer. */
async function start(running: Running, provider = "fake"): Promise<string> {
  const started = await call(running, "/auth/external/start", {
    provider,
    codeChallenge: challenge,
  });
  expect(started.status).toBe(200);
  const url = new URL(started.body.authorizationUrl as string);
  expect(url.pathname).toBe("/authorize");
  expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
  return url.searchParams.get("state") ?? "";
}

/**
 * Signs one of the people of the tests in through an identity provider, as a
 * browser does. The account is named by the person's key.
 */
async function signIn(
  running: Running,
  person: keyof typeof PEOPLE,
  via: keyof typeof PROVIDERS = "github",
): Promise<Signed> {
  const provider = PROVIDERS[via];
  const { email, name } = PEOPLE[person];
  const { status, body } = await call(running, "/auth/external/complete", {
    provider,
    state: await start(running, provider),
    code: `${person}:${email}:${name}`,
    codeVerifier: verifier,
  });
  expect(status).toBe(200);
  const signed = body.person as { id: string; email: string; name: string };
  return { token: body.token as string, person: signed.id, email: signed.email, name: signed.name };
}

/** Enters an organization, exchanging the session for one bound to it. */
async function enter(running: Running, signed: Signed, organization: string): Promise<Signed> {
  const { status, body } = await call(
    running,
    "/auth/organization",
    { organization },
    signed.token,
  );
  expect(status).toBe(200);
  return { ...signed, token: body.token as string };
}

/** Signs a seeded person in, accepts their invitation to the organization, and enters it. */
async function givenMember(
  running: Running,
  person: keyof typeof PEOPLE,
  organization: string,
): Promise<Signed> {
  const signed = await signIn(running, person);
  expect(await acceptInvitation(running, signed, organization)).toBe("ok");
  await eventually(
    () => call(running, "/auth/session", {}, signed.token),
    ({ body }) =>
      (body.organizations as { id: string; standing: string }[]).some(
        (entry) => entry.id === organization && entry.standing === "member",
      ),
  );
  return enter(running, signed, organization);
}

/** The invitation an organization holds for an email address. */
function invitationId(organization: string, email: string) {
  return create(InvitationIdSchema, {
    organization: { uuid: organization },
    invitee: { value: email },
  });
}

/** Has a signed-in person accept the invitation an organization holds for them. */
function acceptInvitation(running: Running, signed: Signed, organization: string): Promise<string> {
  return post(
    running,
    signed,
    AcceptInvitationSchema,
    create(AcceptInvitationSchema, {
      id: invitationId(organization, signed.email),
      person: { uuid: signed.person },
      name: signed.name,
    }),
  );
}

/** Has a signed-in person decline the invitation an organization holds for them. */
function declineInvitation(
  running: Running,
  signed: Signed,
  organization: string,
): Promise<string> {
  return post(
    running,
    signed,
    DeclineInvitationSchema,
    create(DeclineInvitationSchema, {
      id: invitationId(organization, signed.email),
      person: { uuid: signed.person },
    }),
  );
}

/**
 * Has somebody who entered an organization invite an email address to it as a
 * member. An invitation belongs to no organization's tenant, so the command
 * names none.
 */
function inviteMember(
  running: Running,
  as: Signed,
  organization: string,
  email: string,
): Promise<string> {
  return post(
    running,
    as,
    InviteMemberSchema,
    create(InviteMemberSchema, {
      id: invitationId(organization, email),
      role: OrganizationRole.MEMBER,
    }),
  );
}

/** Reads the invitations of an organization through the gateway as the browser client does. */
async function readInvitations(
  running: Running,
  as: Signed,
  of: string,
): Promise<InvitationView[] | "refused"> {
  const client = Client.forGrpcWeb(running.url, {
    onRequestMetadata: () => ({ origin: ORIGIN, authorization: `Bearer ${as.token}` }),
  });
  try {
    const response = await client.onBehalfOf(as.person).send(
      InvitationViewQuery.create()
        .organization()
        .is(create(OrganizationIdSchema, { uuid: of }))
        .build(),
    );
    return response.message.flatMap(({ state }) => {
      const view =
        state === undefined ? undefined : AnyMessages.unpack(state, InvitationViewSchema);
      return view === undefined ? [] : [view];
    });
  } catch {
    return "refused";
  } finally {
    await client.close();
  }
}

/**
 * Gives a command through the gateway as the browser client does.
 *
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
async function post<Schema extends GenMessage<Message>>(
  running: Running,
  as: { readonly token?: string; readonly person: string; readonly organization?: string },
  schema: Schema,
  command: MessageShape<Schema>,
): Promise<string> {
  const client = Client.forGrpcWeb(running.url, {
    ...(as.organization === undefined ? {} : { tenant: as.organization }),
    onRequestMetadata: () => ({
      origin: ORIGIN,
      ...(as.token === undefined ? {} : { authorization: `Bearer ${as.token}` }),
    }),
  });
  try {
    return (await client.onBehalfOf(as.person).post(schema, command)).kind;
  } catch (error) {
    return error instanceof Error ? `refused: ${error.message}` : "refused";
  } finally {
    await client.close();
  }
}

/** Reads the requests of an organization through the gateway as the browser client does. */
async function readRequests(
  running: Running,
  as: { readonly token: string; readonly person: string; readonly organization: string },
): Promise<AccessRequestView[] | "refused"> {
  const client = Client.forGrpcWeb(running.url, {
    tenant: as.organization,
    onRequestMetadata: () => ({ origin: ORIGIN, authorization: `Bearer ${as.token}` }),
  });
  try {
    const response = await client.onBehalfOf(as.person).send(
      create(QuerySchema, {
        id: create(QueryIdSchema, { value: "requests" }),
        target: create(TargetSchema, {
          type: TypeUrls.derive(AccessRequestViewSchema),
          criterion: { case: "includeAll", value: true },
        }),
        context: new SignalMetadata().actorContext({
          actor: create(UserIdSchema, { value: as.person }),
          tenantId: tenant(as.organization),
        }),
      }),
    );
    return response.message.flatMap(({ state }) => {
      const view =
        state === undefined ? undefined : AnyMessages.unpack(state, AccessRequestViewSchema);
      return view === undefined ? [] : [view];
    });
  } catch {
    return "refused";
  } finally {
    await client.close();
  }
}

/** Reads until the value is accepted, for outcomes that become visible later. */
async function eventually<Value>(
  read: () => Promise<Value>,
  accept: (value: Value) => boolean,
): Promise<Value> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() >= deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Reads what an organization records about one of its members. */
async function member(
  running: Running,
  organization: string,
  person: string,
): Promise<OrganizationMember | undefined> {
  const view = await running.resources
    .stand()
    .read(OrganizationViewSchema, organizationId(organization), { tenantId: tenant(organization) });
  return view?.member.find((candidate) => candidate.person?.uuid === person);
}

/** Reads an organization's invitation of an email address. */
function invitation(running: Running, organization: string, email: string) {
  return running.identity.stand().read(
    InvitationViewSchema,
    create(InvitationIdSchema, {
      organization: { uuid: organization },
      invitee: { value: email },
    }),
  );
}

/** Has `noah` administer Acme, register the payroll resource he manages, and open it. */
async function givenOpenResource(running: Running): Promise<Signed> {
  const noah = await givenMember(running, "noah", "acme");
  const as = { ...noah, organization: "acme" };
  expect(
    await post(
      running,
      as,
      RegisterResourceSchema,
      create(RegisterResourceSchema, {
        id: { uuid: "payroll" },
        organizationId: organizationId("acme"),
        name: "Payroll",
        description: "Payroll production",
        category: "application",
        sensitivity: Sensitivity.RESTRICTED,
        manager: [{ uuid: noah.person }],
        accessLevel: [{ name: "Read", rank: 1 }],
        maximumDuration: { seconds: 3600n },
      }),
    ),
  ).toBe("ok");
  const catalogued = () =>
    running.resources
      .stand()
      .read(ResourceCatalogItemSchema, create(ResourceIdSchema, { uuid: "payroll" }), {
        tenantId: tenant("acme"),
      });
  await eventually(catalogued, (item) => item !== undefined);
  expect(
    await post(
      running,
      as,
      OpenResourceForRequestsSchema,
      create(OpenResourceForRequestsSchema, { id: { uuid: "payroll" } }),
    ),
  ).toBe("ok");
  await eventually(catalogued, (item) => item?.policy?.openForRequests === true);
  return noah;
}

/** Has the administrator invite `maya` to Acme, and `maya` accept and enter. */
async function givenMaya(running: Running, administrator: Signed): Promise<Signed> {
  expect(await inviteMember(running, administrator, "acme", "maya@acme.example")).toBe("ok");
  await eventually(
    () => invitation(running, "acme", "maya@acme.example"),
    (invited) => invited?.status === InvitationStatus.PENDING,
  );
  return givenMember(running, "maya", "acme");
}

/** A request by the person for an hour of read access to payroll. */
function submission(id: string, requester: string) {
  return create(SubmitAccessRequestSchema, {
    id: { uuid: id },
    requester: { uuid: requester },
    resource: { uuid: "payroll" },
    accessLevel: { name: "Read", rank: 1 },
    justification: "Need payroll review",
    period: { kind: { case: "immediateDuration", value: { seconds: 60n } } },
  });
}

describe("The gateway should", () => {
  describe("sign a person in, and", () => {
    it("tell them who they are and which invitations wait for them, in no organization", async () => {
      const running = await givenGateway();

      const noah = await signIn(running, "noah");

      const session = await call(running, "/auth/session", {}, noah.token);
      expect(session.body).toEqual({
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
      const session = await call(running, "/auth/session", {}, throughGoogle.token);
      expect(session.body.accounts).toEqual([
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

      expect((await call(running, "/auth/session")).status).toBe(401);
      expect((await call(running, "/auth/session", {}, "no-such-token")).status).toBe(401);
    });

    it("refuse a call from a page it was not told about", async () => {
      const running = await givenGateway();

      const answered = await fetch(`${running.url}/auth/options`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
        body: "{}",
      });

      expect(answered.status).toBe(403);
    });

    it("refuse malformed, scalar, and array JSON at a browser auth address", async () => {
      const running = await givenGateway();

      for (const body of ["not-json", "null", "7", '"word"', "[]"]) {
        const response = await fetch(`${running.url}/auth/options`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body,
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "refused" });
      }
    });

    it("answer auth routes as noncacheable JSON", async () => {
      const running = await givenGateway();

      const response = await fetch(`${running.url}/auth/options`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      });

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

      expect((await call(running, "/auth/sign-out", {}, noah.token)).status).toBe(200);

      expect((await call(running, "/auth/session", {}, noah.token)).status).toBe(401);
    });

    it("allow sign-out without a session and refuse malformed session credentials", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect(await call(running, "/auth/sign-out")).toEqual({ status: 200, body: {} });
      expect((await call(running, "/auth/session", {}, `not-${noah.token}`)).status).toBe(401);
      expect((await call(running, "/auth/session", {}, noah.token)).status).toBe(200);
    });
  });

  describe("sign a person in through an outside identity provider, and", () => {
    it("give them a session once the provider has confirmed them", async () => {
      const running = await givenGateway();
      const state = await start(running);

      const completed = await call(running, "/auth/external/complete", {
        provider: "fake",
        state,
        code: "1001:Noah@Acme.example",
        codeVerifier: verifier,
      });

      expect(completed.status).toBe(200);
      const session = await call(running, "/auth/session", {}, completed.body.token as string);
      expect(session.body).toMatchObject({
        person: { email: "noah@acme.example", name: "Noah@Acme.example" },
        organizations: [{ id: "acme", standing: "invited" }],
      });
    });

    it("sign in the same person through a second provider under the same email address", async () => {
      const running = await givenGateway();
      const signedIn = async (provider: string, code: string) => {
        const state = await start(running, provider);
        const completed = await call(running, "/auth/external/complete", {
          provider,
          state,
          code,
          codeVerifier: verifier,
        });
        expect(completed.status).toBe(200);
        return (completed.body.person as { id: string }).id;
      };

      const first = await signedIn("fake", "1001:noah@acme.example");
      const second = await signedIn("other", "g-7:noah@acme.example");
      const somebodyElse = await signedIn("other", "g-8:maya@acme.example");

      expect(second).toBe(first);
      expect(somebodyElse).not.toBe(first);
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
      const state = await start(running);
      const answer = {
        provider: "fake",
        state,
        code: "1001:noah@acme.example",
        codeVerifier: verifier,
      };

      expect(
        (await call(running, "/auth/external/complete", { ...answer, state: "not-issued" })).status,
      ).toBe(403);
      expect((await call(running, "/auth/external/complete", answer)).status).toBe(200);
      expect((await call(running, "/auth/external/complete", answer)).status).toBe(403);
    });

    it("refuse an answer from a browser that does not hold the secret the sign-in started with", async () => {
      const running = await givenGateway();
      const state = await start(running);

      const completed = await call(running, "/auth/external/complete", {
        provider: "fake",
        state,
        code: "1001:noah@acme.example",
        codeVerifier: "w".repeat(43),
      });

      expect(completed.status).toBe(403);
    });

    it("refuse an account the provider has verified no email address for", async () => {
      const running = await givenGateway();
      const state = await start(running);

      const completed = await call(running, "/auth/external/complete", {
        provider: "fake",
        state,
        code: "1001:",
        codeVerifier: verifier,
      });

      expect(completed.status).toBe(403);
    });
  });

  describe("let a signed-in person into an organization, and", () => {
    it("make them a member when they accept the invitation waiting for them", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect(await acceptInvitation(running, noah, "acme")).toBe("ok");

      const session = await eventually(
        () => call(running, "/auth/session", {}, noah.token),
        ({ body }) => (body.organizations as { standing: string }[])[0]?.standing === "member",
      );
      expect(session.body.organizations).toEqual([
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
        () => call(running, "/auth/session", {}, noah.token),
        ({ body }) => (body.organizations as unknown[]).length === 0,
      );
      await acceptInvitation(running, noah, "acme");
      expect(
        (await call(running, "/auth/organization", { organization: "acme" }, noah.token)).status,
      ).toBe(403);
      expect(await member(running, "acme", noah.person)).toBeUndefined();
    });

    it("refuse an answer to an invitation sent to somebody else", async () => {
      const running = await givenGateway();
      const maya = await signIn(running, "maya");

      const accepted = await post(
        running,
        maya,
        AcceptInvitationSchema,
        create(AcceptInvitationSchema, {
          id: invitationId("acme", "noah@acme.example"),
          person: { uuid: maya.person },
          name: maya.name,
        }),
      );
      const declined = await post(
        running,
        maya,
        DeclineInvitationSchema,
        create(DeclineInvitationSchema, {
          id: invitationId("acme", "noah@acme.example"),
          person: { uuid: maya.person },
        }),
      );

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

      const accepted = await post(
        running,
        noah,
        AcceptInvitationSchema,
        create(AcceptInvitationSchema, {
          id: invitationId("acme", noah.email),
          person: { uuid: "somebody-else" },
          name: noah.name,
        }),
      );

      expect(accepted).not.toBe("ok");
      expect(await member(running, "acme", "somebody-else")).toBeUndefined();
    });

    it("keep out of an organization that did not invite them", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      await acceptInvitation(running, noah, "globex");

      expect(
        (await call(running, "/auth/organization", { organization: "globex" }, noah.token)).status,
      ).toBe(403);
      expect(await member(running, "globex", noah.person)).toBeUndefined();
    });

    it("refuse entering an organization without a session or scalar organization id", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      expect((await call(running, "/auth/organization", { organization: "acme" })).status).toBe(
        401,
      );
      for (const organization of [undefined, null, 7, { uuid: "acme" }]) {
        expect(
          (await call(running, "/auth/organization", { organization }, noah.token)).status,
        ).toBe(403);
      }
    });

    it("refuse an empty organization id without rotating the session", async () => {
      const running = await givenGateway();
      const noah = await signIn(running, "noah");

      const entered = await call(running, "/auth/organization", { organization: "" }, noah.token);

      expect(entered).toEqual({ status: 403, body: { error: "refused" } });
      const current = await call(running, "/auth/session", {}, noah.token);
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
      expect((await call(running, "/auth/session", {}, noah.token)).status).toBe(401);
      expect((await call(running, "/auth/session", {}, entered.token)).body.organization).toBe(
        "acme",
      );
    });
  });

  describe("carry a member's commands and queries, and", () => {
    it("let a member submit a request in their own name and read it back", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);
      const as = { ...maya, organization: "acme" };

      expect(
        await post(running, as, SubmitAccessRequestSchema, submission("req-1", maya.person)),
      ).toBe("ok");

      const requests = await eventually(
        () => readRequests(running, as),
        (views) => views !== "refused" && views.length === 1,
      );
      expect(requests).toMatchObject([
        { id: { uuid: "req-1" }, snapshot: { requester: { uuid: maya.person } } },
      ]);
    });

    it("refuse a command given in another person's name", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const outcome = await post(
        running,
        { ...maya, organization: "acme" },
        SubmitAccessRequestSchema,
        submission("req-spoofed", noah.person),
      );

      expect(outcome).not.toBe("ok");
      // The session says who is acting, whatever the client claims.
      expect(
        await post(
          running,
          { token: maya.token, person: noah.person, organization: "acme" },
          SubmitAccessRequestSchema,
          submission("req-spoofed", noah.person),
        ),
      ).not.toBe("ok");
      expect(
        await running.resources
          .stand()
          .read(AccessRequestViewSchema, create(AccessRequestIdSchema, { uuid: "req-spoofed" }), {
            tenantId: tenant("acme"),
          }),
      ).toBeUndefined();
    });

    it("refuse a request aimed at an organization other than the one entered", async () => {
      const running = await givenGateway();
      const noah = await givenOpenResource(running);
      const maya = await givenMaya(running, noah);

      const outcome = await post(
        running,
        { ...maya, organization: "globex" },
        SubmitAccessRequestSchema,
        submission("req-elsewhere", maya.person),
      );

      expect(outcome).not.toBe("ok");
      expect(await readRequests(running, { ...maya, organization: "globex" })).toBe("refused");
    });

    it("refuse a command only the application itself gives", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");

      const outcome = await post(
        running,
        { ...noah, organization: "acme" },
        InviteMemberSchema,
        create(InviteMemberSchema, {
          id: { organization: { uuid: "globex" }, invitee: { value: "somebody@acme.example" } },
          role: OrganizationRole.ADMINISTRATOR,
        }),
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

      const invited = await post(
        running,
        noah,
        InviteMemberSchema,
        create(InviteMemberSchema, {
          id: invitationId("globex", "maya@acme.example"),
          role: OrganizationRole.MEMBER,
        }),
      );
      const listed = await readInvitations(running, noah, "globex");

      expect(invited).not.toBe("ok");
      expect(listed).toBe("refused");
      expect(await invitation(running, "globex", "maya@acme.example")).toBeUndefined();
    });

    it("let an administrator see the organization's invitations and take one back", async () => {
      const running = await givenGateway();
      const noah = await givenMember(running, "noah", "acme");
      expect(await inviteMember(running, noah, "acme", "maya@acme.example")).toBe("ok");
      await eventually(
        () => invitation(running, "acme", "maya@acme.example"),
        (invited) => invited?.status === InvitationStatus.PENDING,
      );

      const revoked = await post(
        running,
        noah,
        RevokeInvitationSchema,
        create(RevokeInvitationSchema, { id: invitationId("acme", "maya@acme.example") }),
      );

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

      expect(
        await post(
          running,
          { person: maya.person, organization: "acme" },
          SubmitAccessRequestSchema,
          submission("req-anonymous", maya.person),
        ),
      ).not.toBe("ok");
      expect(
        await post(
          running,
          { ...signedInOnly, organization: "acme" },
          SubmitAccessRequestSchema,
          submission("req-not-entered", maya.person),
        ),
      ).not.toBe("ok");
    });
  });
});
