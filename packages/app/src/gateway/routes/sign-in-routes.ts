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

import { OidcFlow } from "@spine-event-engine/auth";
import type { BrowserAuthRoute } from "@spine-event-engine/server/browser";
import type { AccessDesk } from "../access-desk.js";
import { personIn, type SignInProvider } from "../providers.js";
import type { Issued, Sessions } from "../sessions.js";
import { REFUSED, type Route } from "./route.js";

/** An outside identity provider the gateway signs people in through. */
export interface ExternalSignIn {
  /** The provider. */
  readonly provider: SignInProvider;
  /**
   * The HTTPS address of the page the provider sends the person back to. That
   * page passes the provider's answer on to the gateway.
   */
  readonly callbackUri: string;
}

/** The addresses through which people sign in, and how to stop what they hold open. */
export interface SignInRoutes {
  /** Browser auth routes registered with BrowserServer. */
  readonly routes: BrowserAuthRoute[];
  /** Ends every sign-in still under way. */
  close(): void;
}

/**
 * The addresses through which people sign in.
 *
 * A person signs in through an outside identity provider, such as GitHub or
 * Google.
 *
 * 1. A sign-in page asks which providers it may offer.
 * 2. The browser starts a sign-in with one of them.
 * 3. The provider confirms the person.
 * 4. The browser finishes the sign-in with the provider's answer.
 *
 * Whichever account a person signs in with, Identity says who they are.
 *
 * @param route How an address is made.
 * @param desk What the gateway asks of the application.
 * @param sessions The sessions of the people who have signed in.
 * @param external The identity providers to sign people in through, by the
 *   key each is chosen with.
 */
export function signInRoutes(
  route: Route,
  desk: AccessDesk,
  sessions: Sessions,
  external: Readonly<Record<string, ExternalSignIn>>,
): SignInRoutes {
  /** The sign-in flow of each outside identity provider. */
  const flows = new Map(
    Object.entries(external).map(([key, { provider, callbackUri }]) => [
      key,
      new OidcFlow({
        authorizationEndpoint: provider.authorizationEndpoint,
        callbackUri,
        clientId: provider.clientId,
        scopes: [...provider.scopes],
        allowedPostLoginRedirects: [callbackUri],
        provider: provider.provider,
        identityMapping: {
          // Identity tells whose account the provider confirmed, which is who
          // the person is in Access Desk.
          async resolve(identity) {
            const verified = personIn(provider.kind, identity);
            const person = verified === undefined ? undefined : await desk.signIn(verified);
            if (verified !== undefined && person === undefined) {
              console.warn(`Identity did not settle whose account ${provider.label} confirmed.`);
            }
            return person === undefined
              ? undefined
              : {
                  externalIdentity: identity,
                  principal: {
                    id: person.id.uuid,
                    attributes: { email: person.email.value, name: person.name },
                  },
                };
          },
        },
        sessionIssuer: {
          async issue(principal) {
            const created = await sessions.create(principal);
            return created.kind === "created"
              ? { credential: created.credential, session: created.session }
              : undefined;
          },
        },
      }),
    ]),
  );

  const routes = [
    /**
     * Tells a sign-in page which identity providers it may offer. The page
     * asks before anybody has signed in, to draw its sign-in buttons.
     *
     * Needs no session. Send `{}`.
     *
     * Answers `200` with `{ external: [{ key, label }] }`. `key` is what
     * `/auth/external/start` takes as `provider`, and `label` is the name to
     * show, such as "GitHub". An empty list means nobody can sign in.
     */
    route("/auth/options", () =>
      Promise.resolve([
        200,
        {
          external: Object.entries(external).map(([key, { provider }]) => ({
            key,
            label: provider.label,
          })),
        },
      ]),
    ),
  ];

  if (flows.size > 0) {
    routes.push(
      /**
       * Starts a sign-in through one identity provider. The page calls it
       * when the person presses a sign-in button, and then sends the browser
       * to the address it is given.
       *
       * Needs no session. Send `{ provider, codeChallenge }`.
       *
       * - `provider` is a `key` from `/auth/options`.
       * - `codeChallenge` is the SHA-256 of a secret the browser has just made
       *   up, in base64url without padding. The browser keeps the secret
       *   itself until the provider sends the person back. Only the browser
       *   that holds it can finish the sign-in it started.
       *
       * Answers `200` with `{ authorizationUrl }`, the provider's address to
       * send the person to. Answers `403` for a provider that is not set up
       * or a missing `codeChallenge`.
       */
      route("/auth/external/start", (body) => {
        const key = typeof body.provider === "string" ? body.provider : "";
        const redirect = Object.hasOwn(external, key) ? external[key]?.callbackUri : undefined;
        const started =
          typeof body.codeChallenge === "string" && redirect !== undefined
            ? flows
                .get(key)
                ?.start({ browserCodeChallenge: body.codeChallenge, postLoginRedirect: redirect })
            : undefined;
        return Promise.resolve(
          started?.kind === "started"
            ? [200, { authorizationUrl: started.authorizationUrl }]
            : REFUSED,
        );
      }),
      /**
       * Finishes a sign-in and gives the person a session. The page calls it
       * when the provider has sent the person back to it, with `code` and
       * `state` in the address.
       *
       * Needs no session. Send `{ provider, state, code, codeVerifier }`.
       *
       * - `provider` is the same `key` the sign-in was started with.
       * - `state` and `code` are what the provider put in the address.
       * - `codeVerifier` is the secret whose SHA-256 was sent at the start.
       *
       * Answers `200` with `{ token, person: { id, email, name },
       * organization: null }`. `token` is the session. Send it with every
       * later request as `Authorization: Bearer <token>`. The session belongs
       * to no organization yet.
       *
       * Answers `403` when the sign-in was never started or was already
       * finished, when the secret does not match, or when the provider
       * confirmed no account with a verified email address. The gateway's
       * console says which.
       */
      route("/auth/external/complete", async (body) => {
        const { provider, state, code, codeVerifier } = body;
        const flow = typeof provider === "string" ? flows.get(provider) : undefined;
        if (
          flow === undefined ||
          typeof state !== "string" ||
          typeof code !== "string" ||
          typeof codeVerifier !== "string"
        ) {
          return REFUSED;
        }
        const answered = await flow.callback({ state, code });
        const issued =
          answered.kind === "granted"
            ? await flow.exchange({ grant: answered.grant, browserCodeVerifier: codeVerifier })
            : undefined;
        if (issued?.kind !== "issued") {
          // The flow tells the browser nothing, so the console says which step refused.
          console.warn(
            `Sign-in through ${String(provider)} was refused: ` +
              (answered.kind === "granted"
                ? `the session was not issued (${issued?.kind ?? "no answer"}).`
                : `the provider's answer was not accepted (${answered.reason}).`),
          );
          return REFUSED;
        }
        const { id, attributes } = issued.session.principal;
        const session: Issued = {
          token: issued.credential.value,
          person: { id, email: attributes?.email ?? "", name: attributes?.name ?? "" },
          organization: null,
        };
        return [200, session];
      }),
    );
  }

  return {
    routes,
    close: () => {
      for (const flow of flows.values()) {
        flow.close();
      }
    },
  };
}
