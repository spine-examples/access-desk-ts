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
import { createGrpcWebTransport } from "@connectrpc/connect-node";
import {
  NativeSubscriptionCreator,
  type AuthenticatedPrincipal,
  type AuthorizedRequestContext,
  type RequestCredential,
} from "@spine-event-engine/auth";
import type { TypeRegistryLookup } from "@spine-event-engine/core";
import { Time } from "@spine-event-engine/core/time";
import { TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import { BrowserServer } from "@spine-event-engine/server/browser";
import { ServerConnection } from "../server/client.js";
import { AccessDesk } from "./access-desk.js";
import { Policy } from "./policy.js";
import { routing } from "./routes/route.js";
import { sessionRoutes } from "./routes/session-routes.js";
import { signInRoutes, type ExternalSignIn } from "./routes/sign-in-routes.js";
import { Sessions } from "./sessions.js";
import { Watching, type CancelAsBrowser } from "./watching.js";

/** How long the gateway waits for a subscription of an ending session to be cancelled. */
const CANCEL_MS = 5_000; // 5 seconds.

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
   * A person signs in first, which concerns no organization. They then enter
   * one of their organizations. Only then may they give commands and read, and
   * only within that organization.
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
    const listening: { address?: string } = {};
    const watching = new Watching(cancellingThrough(() => listening.address, origins[0]));
    const sessions = new Sessions(watching);
    const route = routing(origins, sessions);
    const signIn = signInRoutes(route, desk, sessions, options.external);
    const allows = Policy.authorization(desk);

    const running = await BrowserServer.open(undefined, {
      backend: { baseUrl: options.backend },
      bindings: watching,
      host: options.host ?? "127.0.0.1",
      port: options.port,
      origins,
      registry: options.registry,
      authRoutes: [...signIn.routes, ...sessionRoutes(route, desk, sessions)],
      clock: { now: () => Time.currentTime() },
      sessions: {
        // The gateway hands its session out as a bearer token.
        resolve: (credential: RequestCredential) => sessions.resolve(credential.value),
      },
      authorize: async (principal, request) => {
        const allowed = await allows(principal, request);
        if (allowed) {
          watching.claim(principal, request);
        }
        return allowed;
      },
      contexts: {
        resolve: (principal, request, clock) =>
          Promise.resolve(trusted(principal, clock.now(), !Policy.concernsNoOrganization(request))),
        resolveContext: (principal, clock) =>
          Promise.resolve(trusted(principal, clock.now(), true)),
      },
    });
    listening.address = running.baseUrl;
    return {
      url: running.baseUrl,
      close: async () => {
        signIn.close();
        await running.close();
        await server.close();
        await sessions.close();
      },
    };
  },
};

/**
 * Cancels a subscription the way its browser would.
 *
 * Spine fully clears a subscription only when it is canceled through the
 * gateway's own address. So the gateway calls itself there, with the
 * session's token.
 *
 * @param address Returns the address the gateway listens at, once it listens.
 * @param origin The address of a page that may call the gateway.
 */
function cancellingThrough(
  address: () => string | undefined,
  origin: string | undefined,
): CancelAsBrowser {
  return async (subscription, token) => {
    const baseUrl = address();
    if (baseUrl === undefined || origin === undefined) {
      throw new Error("The gateway cannot be called at its own address.");
    }
    const transport = createGrpcWebTransport({
      baseUrl,
      httpVersion: "1.1",
      interceptors: [
        (next) => (request) => {
          request.header.set("origin", origin);
          request.header.set("authorization", `Bearer ${token}`);
          return next(request);
        },
      ],
    });
    await new NativeSubscriptionCreator(transport).cancel(
      { wire: subscription },
      AbortSignal.timeout(CANCEL_MS),
    );
  };
}

/**
 * Builds the context of a request from its session.
 *
 * The context names the signed-in person as the actor, and the organization
 * they have entered as the tenant.
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
