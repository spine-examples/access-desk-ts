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
import {
  PersistentTokenRevocations,
  SignedSessions,
  type AuthenticatedPrincipal,
  type AuthorizedRequestContext,
} from "@spine-event-engine/auth";
import type { TypeRegistryLookup } from "@spine-event-engine/core";
import { Time } from "@spine-event-engine/core/time";
import { TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import { BrowserServer, DurableSubscriptionBindings } from "@spine-event-engine/server/browser";
import { StorageGroup, type StorageFactory } from "@spine-event-engine/storage";
import { Closing } from "../closing.js";
import { ServerConnection } from "../server/client.js";
import { AccessDesk } from "./access-desk.js";
import { Policy } from "./policy.js";
import { routing } from "./routes/route.js";
import { sessionRoutes } from "./routes/session-routes.js";
import { signInRoutes, type ExternalSignIn } from "./routes/sign-in-routes.js";
import type { SessionKey } from "./session-key.js";

/** How long a session lasts. */
const SESSION_SECONDS = 8 * 60 * 60; // 8 hours.

/**
 * How long after it expires a token is still taken,
 * as clocks may differ a little.
 */
const CLOCK_SKEW_SECONDS = 60;

/** Who signs the sessions, as written in every token. */
const ISSUER = "access-desk-gateway";

/** Who the sessions are for, as written in every token. */
const AUDIENCE = "access-desk";

/** The storage group the sessions people ended are kept in. */
const ENDED = new StorageGroup("ended-sessions");

/** How the gateway is set up. */
export interface GatewayOptions {
  /** The address of the application server. */
  readonly backend: string;
  /** Every type the application's messages use, so commands can be read and judged. */
  readonly registry: TypeRegistryLookup;
  /** The addresses of the pages that may call the gateway. */
  readonly origins: readonly string[];
  /** The address to listen on. The loopback address when left out. */
  readonly host?: string;
  /** The port to listen on. Zero picks a free one. */
  readonly port: number;
  /** The identity providers people sign in through, such as Google, by key. */
  readonly external: Readonly<Record<string, ExternalSignIn>>;
  /** The P-256 private key the gateway signs sessions with. */
  readonly sessionKey: SessionKey;
  /** Where the gateway keeps its data, so it outlasts a restart. */
  readonly storage: StorageFactory;
}

/** A running gateway. */
export interface Gateway {
  /** The address the gateway listens at. */
  readonly url: string;
  /** Stops the gateway. The application server keeps running. */
  close(): Promise<void>;
}

/** Starts the gateway. */
export const Gateway = {
  /**
   * Starts the gateway, the only way from a browser to the application.
   *
   * A person signs in, and works in the organization they belong to. Only a
   * person who belongs to one may give commands and read, and only within it.
   *
   * The gateway decides who is acting and where, from the session it issued. It
   * refuses a request that names another person or another organization, and
   * every command only the application itself may give.
   *
   * @param options How to set the gateway up.
   * @returns The running gateway.
   */
  async start(options: GatewayOptions): Promise<Gateway> {
    const server = new ServerConnection(() => options.backend);
    const desk = new AccessDesk(server);
    const origins = [...options.origins];
    const subscriptions = new DurableSubscriptionBindings({
      storageFactory: options.storage,
      namespace: "access-desk-gateway",
      nextId: () => crypto.randomUUID(),
      cleanup: () => Promise.resolve(),
    });
    const ended = await PersistentTokenRevocations.create({
      storageFactory: options.storage,
      group: ENDED,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const sessions = new SignedSessions({
      issuer: ISSUER,
      audience: AUDIENCE,
      activeKey: options.sessionKey.signing(),
      revocation: ended,
      clock: { now: () => Time.currentTimeMillis() },
      ttlSeconds: SESSION_SECONDS,
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
    });
    const route = routing(origins, sessions);
    const signIn = await signInRoutes(route, desk, sessions, options.external, options.storage);
    const allows = Policy.authorization(desk);

    const running = await BrowserServer.open(undefined, {
      backend: { baseUrl: options.backend },
      forwarding: "trusted-network",
      bindings: subscriptions,
      host: options.host ?? "127.0.0.1",
      port: options.port,
      origins,
      registry: options.registry,
      authRoutes: [...signIn.routes, ...sessionRoutes(route, desk, sessions, ended)],
      clock: { now: () => Time.currentTime() },
      sessions,
      authorize: allows,
      contexts: {
        resolve: (principal, request, clock) =>
          Promise.resolve(trusted(principal, clock.now(), !Policy.concernsNoOrganization(request))),
        resolveContext: (principal, clock) =>
          Promise.resolve(trusted(principal, clock.now(), true)),
      },
    });
    let closing: Promise<void> | undefined;
    return {
      url: running.baseUrl,
      close: () => (closing ??= Closing.inOrder(signIn, running, server, sessions, ended)),
    };
  },
};

/**
 * Builds the context of a request from its session.
 *
 * The context names the signed-in person as the actor, and the organization
 * they belong to as the tenant.
 *
 * @param principal The person the session belongs to.
 * @param timestamp When the request was received.
 * @param inOrganization Whether to include the organization. A request for
 *   Identity is sent without one.
 * @returns The actor, the tenant when there is one, and the timestamp.
 */
function trusted(
  principal: AuthenticatedPrincipal,
  timestamp: ReturnType<typeof Time.currentTime>,
  inOrganization: boolean,
): AuthorizedRequestContext {
  const organization = inOrganization ? principal.attributes?.organization : undefined;
  return {
    actor: create(UserIdSchema, { value: principal.id }),
    ...(organization === undefined
      ? {}
      : { tenant: create(TenantIdSchema, { kind: { case: "value", value: organization } }) }),
    timestamp,
  };
}
