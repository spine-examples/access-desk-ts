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

import { generateKeyPairSync } from "node:crypto";
import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { Client } from "@spine-event-engine/client-web";
import { AnyPacker, TypeUrls } from "@spine-event-engine/core";
import { UserIdSchema } from "@spine-event-engine/proto";
import {
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  type Query,
} from "@spine-event-engine/proto/client";
import { type BoundedContext, SignalMetadata } from "@spine-event-engine/server";
import {
  MembershipIdSchema,
  OrganizationIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { PersonViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  IdentityProvider,
  OrganizationRole,
} from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { TestStorages, type TestStorage } from "@access-desk/testing/storage";

import { give, givenServer, tenant as tenantOf, type Hosted } from "../../server/given/hosted.js";
import { typeRegistry } from "../../../generated/model-registry.js";

// Imported from compiled output, like the contexts it assembles: vitest cannot
// execute the handler classes' standard decorators from raw TypeScript source.
type AppModule = typeof import("../../../dist/src/index.js");
type ProvidersModule = typeof import("../../../dist/src/gateway/providers.js");
type External = NonNullable<Parameters<AppModule["Gateway"]["start"]>[0]["external"]>;

/** The address of the page that calls the gateway. */
export const ORIGIN = "http://app.test";
/** The page an outside identity provider sends people back to. */
export const CALLBACK = "https://app.test/signed-in";

/** The key the gateways of the tests sign sessions with. */
export const SESSION_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

/** The running application behind its gateway. */
export interface Running {
  /** The address the gateway listens at. */
  readonly url: string;
  /** The Resources context of the application server, for seeding and for reading what came of a request. */
  readonly resources: BoundedContext;
  /** The Identity context of the application server, for seeding and for reading what came of a request. */
  readonly identity: BoundedContext;
}

/** Who a browser acts as when it sends a Spine request through the gateway. */
export interface Acting {
  /** The token of the session the browser holds, when it holds one. */
  readonly token?: string;
  /** The person the browser says it acts for. */
  readonly person: string;
  /** The organization the request names, when it names one. */
  readonly organization?: string;
}

/** What a test has started and must stop, in the order it was started. */
const started: (() => Promise<void>)[] = [];

/**
 * Has something stopped once the test is over.
 *
 * @param stop Stops what the test started.
 */
export function afterwards(stop: () => Promise<void>): void {
  started.push(stop);
}

/**
 * Stops every gateway a test started, with its application server and
 * whatever was opened against it. For a suite's `afterEach`.
 */
export async function stopGateways(): Promise<void> {
  // What was started last depends on what was started before it.
  for (const stop of started.splice(0).reverse()) {
    await stop();
  }
}

/**
 * Creates an identity provider that confirms `<subject>:<email>:<name>` codes,
 * for the tests. A code without an email address stands for an account the provider
 * has verified no address for. The name may be left out.
 *
 * @param kind Which provider it stands for.
 * @param issuer The address it vouches under.
 * @param identities Describes a confirmed account, as the gateway's own providers do.
 */
function fakeProvider(
  kind: IdentityProvider,
  issuer: string,
  identities: ProvidersModule["ConfirmedIdentity"],
): External[string] {
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
              : identities.of(issuer, subject, email, name === "" ? undefined : name),
          );
        },
      },
    },
  };
}

/**
 * Creates an organization and adds its first administrator, and waits until
 * Identity shows the administrator in the organization.
 *
 * The application has no way of creating an organization yet, so the tests
 * give the two commands themselves, in the application's own name.
 *
 * @param hosted The running application server.
 * @param name The organization's name, which is also its identifier.
 * @param administrator The email address of its first administrator.
 */
async function givenOrganization(
  hosted: Hosted,
  name: string,
  administrator: string,
): Promise<void> {
  await give(
    hosted.resources,
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: organizationId(name), name }),
    { organization: organizationId(name) },
  );
  await give(
    hosted.identity,
    AddMemberSchema,
    create(AddMemberSchema, {
      id: { emailAddress: { value: administrator } },
      organization: { uuid: name },
      role: OrganizationRole.ADMINISTRATOR,
    }),
  );
  const added = await eventually(
    () =>
      hosted.identity
        .stand()
        .read(
          MembershipViewSchema,
          create(MembershipIdSchema, { emailAddress: { value: administrator } }),
        ),
    (view) => view?.person !== undefined,
  );
  const person = added?.person;
  if (person === undefined) {
    throw new Error(`${administrator} was not added to ${name}.`);
  }
  const joined = await eventually(
    () => hosted.identity.stand().read(PersonViewSchema, person),
    (view) => view?.organization?.uuid === name,
  );
  if (joined?.organization?.uuid !== name) {
    throw new Error(`${administrator} did not join ${name}.`);
  }
}

/**
 * Starts the application behind a gateway.
 *
 * - The application server holds Acme, which added `noah@acme.example` as
 *   its administrator, and Globex, which added `olivia@acme.example`.
 * - The gateway signs people in through a fake identity provider, `fake`,
 *   standing for Google, and answers only {@link ORIGIN}.
 *
 * Both are stopped by {@link stopGateways}.
 *
 * @returns The running application.
 */
export async function givenGateway(): Promise<Running> {
  const app: AppModule = await import("../../../dist/src/index.js");
  const hosted = await givenServer();
  afterwards(() => hosted.stop());
  await givenOrganization(hosted, "acme", "noah@acme.example");
  await givenOrganization(hosted, "globex", "olivia@acme.example");
  const storage = await TestStorages.singleTenant(typeRegistry);
  afterwards(() => storage.drop());
  const revokedTokens = await app.RevokedTokens.open(TestStorages.settingsOf(storage));
  afterwards(() => revokedTokens.close());
  return startGateway({ hosted, storage, revokedTokens });
}

/**
 * Stops the gateway of a running application, and starts it again over what
 * it kept: the subscriptions people hold, and the sessions they ended. It
 * signs sessions with the same key. The application server keeps running.
 *
 * @param running The application whose gateway restarts.
 * @returns The application behind the restarted gateway.
 */
export async function restartGateway(running: Running): Promise<Running> {
  const gateway = gateways.get(running);
  if (gateway === undefined) {
    throw new Error("Start the gateway through givenGateway() to restart it.");
  }
  await gateway.close();
  return startGateway(gateway.kept);
}

/** What a gateway of the tests keeps across its restarts. */
interface Kept {
  /** The application server behind the gateway. */
  readonly hosted: Hosted;
  /** Where the gateway keeps the subscriptions people hold. */
  readonly storage: TestStorage;
  /** The tokens of the sessions people ended before they expired. */
  readonly revokedTokens: Parameters<AppModule["Gateway"]["start"]>[0]["storage"]["revokedTokens"];
}

/** The gateway in front of each running application, and what it keeps. */
const gateways = new WeakMap<Running, { readonly kept: Kept; close(): Promise<void> }>();

/** Starts a gateway in front of the application server, over what it keeps. */
async function startGateway(kept: Kept): Promise<Running> {
  const app: AppModule = await import("../../../dist/src/index.js");
  const providers: ProvidersModule = await import("../../../dist/src/gateway/providers.js");
  const gateway = await app.Gateway.start({
    backend: kept.hosted.url,
    registry: app.typeRegistry,
    origins: [ORIGIN],
    port: 0,
    external: {
      fake: fakeProvider(
        IdentityProvider.GOOGLE,
        "https://provider.test",
        providers.ConfirmedIdentity,
      ),
    },
    sessionKey: SESSION_KEY,
    storage: { subscriptions: await kept.storage.open(), revokedTokens: kept.revokedTokens },
  });
  // The gateway and the application server are separate, so each is stopped.
  // Closing a gateway twice does nothing more.
  afterwards(() => gateway.close());
  const running = {
    url: gateway.url,
    resources: kept.hosted.resources,
    identity: kept.hosted.identity,
  };
  gateways.set(running, { kept, close: () => gateway.close() });
  return running;
}

/**
 * Builds the identifier of an organization of the tests, which is its name.
 *
 * @param organization The organization's name.
 */
export function organizationId(organization: string) {
  return create(OrganizationIdSchema, { uuid: organization });
}

/**
 * Builds the tenant an organization of the tests keeps its state in.
 *
 * @param organization The organization's name.
 */
export function tenant(organization: string) {
  return tenantOf(organizationId(organization));
}

/** A JSON answer of the gateway. */
export interface Answered {
  /** The HTTP status. */
  readonly status: number;
  /** The JSON the answer carried, or nothing when it carried none. */
  readonly body: Record<string, unknown>;
}

/**
 * Sends a body, as it is written, to a sign-in or session endpoint of the gateway.
 *
 * @param running The running application.
 * @param path The endpoint's path.
 * @param body The body, which need not be JSON.
 * @param by The session's token, when the call carries one, and the page the
 *   call comes from. The application's own page when left out.
 * @returns The gateway's answer, as it came.
 */
export function request(
  running: Running,
  path: string,
  body: string,
  by: { readonly token?: string | undefined; readonly origin?: string } = {},
): Promise<Response> {
  return fetch(`${running.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: by.origin ?? ORIGIN,
      ...(by.token === undefined ? {} : { authorization: `Bearer ${by.token}` }),
    },
    body,
  });
}

/**
 * Calls a sign-in or session endpoint of the gateway from the application's page.
 *
 * @param running The running application.
 * @param path The endpoint's path.
 * @param body What to send. An empty object when left out.
 * @param token The session's token, when the call carries one.
 * @param origin The page the call comes from. The application's own when left out.
 * @returns The status and the JSON the gateway answered with.
 */
export async function call(
  running: Running,
  path: string,
  body: object = {},
  token?: string,
  origin: string = ORIGIN,
): Promise<Answered> {
  const response = await request(running, path, JSON.stringify(body), { token, origin });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/**
 * Creates the Spine client a browser sends commands, queries, and subscriptions with.
 *
 * @param running The running application.
 * @param as Who the browser acts as.
 * @returns The client, which the caller closes.
 */
export function browserClient(running: Running, as: Acting) {
  return Client.forGrpcWeb(running.url, {
    ...(as.organization === undefined ? {} : { tenant: as.organization }),
    onRequestMetadata: () => ({
      origin: ORIGIN,
      ...(as.token === undefined ? {} : { authorization: `Bearer ${as.token}` }),
    }),
  });
}

/**
 * Sends a command through the gateway.
 *
 * @param running The running application.
 * @param as Who the browser acts as.
 * @param schema The kind of command.
 * @param command The command.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export async function post<Schema extends GenMessage<Message>>(
  running: Running,
  as: Acting,
  schema: Schema,
  command: MessageShape<Schema>,
): Promise<string> {
  const client = browserClient(running, as);
  try {
    return (await client.onBehalfOf(as.person).post(schema, command)).kind;
  } catch (error) {
    return error instanceof Error ? `refused: ${error.message}` : "refused";
  } finally {
    await client.close();
  }
}

/** What the browser client takes as a request for read models. */
export type Asking = Parameters<
  ReturnType<ReturnType<typeof Client.forGrpcWeb>["onBehalfOf"]>["send"]
>[0];

/**
 * Asks for everything there is of one kind of read model, naming nobody.
 *
 * @param schema The kind of read model.
 * @param as Who asks, and in which organization.
 * @returns The request.
 */
export function everything(
  schema: GenMessage<Message>,
  as: { readonly person: string; readonly organization: string },
): Query {
  return create(QuerySchema, {
    id: create(QueryIdSchema, { value: `all-${crypto.randomUUID()}` }),
    target: create(TargetSchema, {
      type: TypeUrls.derive(schema),
      criterion: { case: "includeAll", value: true },
    }),
    context: new SignalMetadata().actorContext({
      actor: create(UserIdSchema, { value: as.person }),
      tenantId: tenant(as.organization),
    }),
  });
}

/**
 * Reads read models through the gateway as the browser client does.
 *
 * @param running The running application.
 * @param as Who the browser acts as.
 * @param schema The kind of read model.
 * @param asking What to ask for.
 * @returns The read models, or `"refused"` when the gateway or the application
 *   server did not answer the request.
 */
export async function read<Schema extends GenMessage<Message>>(
  running: Running,
  as: Acting,
  schema: Schema,
  asking: Asking,
): Promise<MessageShape<Schema>[] | "refused"> {
  const client = browserClient(running, as);
  try {
    const response = await client.onBehalfOf(as.person).send(asking);
    return response.message.flatMap(({ state }) => {
      const view = state === undefined ? undefined : AnyPacker.tryUnpack(state, schema);
      return view === undefined ? [] : [view];
    });
  } catch {
    return "refused";
  } finally {
    await client.close();
  }
}

/**
 * Reads until the value is accepted, for outcomes that become visible later.
 *
 * @param read The asynchronous read to repeat.
 * @param accept Whether the latest read is the awaited outcome.
 * @param patienceMs How long to keep reading. Fifteen seconds when left out.
 * @returns The accepted value, or the last one read when none was accepted in time.
 */
export async function eventually<Value>(
  read: () => Promise<Value>,
  accept: (value: Value) => boolean,
  patienceMs = 15_000,
): Promise<Value> {
  const deadline = Date.now() + patienceMs;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() >= deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
