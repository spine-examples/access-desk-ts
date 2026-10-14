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
import { expect } from "vitest";

import { call, CALLBACK, type Answered, type Running } from "./gateway.js";

/** The people of the tests, by the key each is chosen with. */
export const PEOPLE = {
  maya: { email: "maya@acme.example", name: "Maya Chen" },
  noah: { email: "noah@acme.example", name: "Noah Reyes" },
  olivia: { email: "olivia@acme.example", name: "Olivia Park" },
};

/** The secret a browser keeps while it signs in. */
export const verifier = "v".repeat(43);
/** The fingerprint of that secret, which the browser starts a sign-in with. */
export const challenge = createHash("sha256").update(verifier).digest("base64url");

/** A person signed in through the gateway. */
export interface Signed {
  /** The token of the session the gateway gave them. */
  readonly token: string;
  /** The person's identifier. */
  readonly person: string;
  /** The email address the person is registered under. */
  readonly email: string;
  /** The person's display name. */
  readonly name: string;
}

/**
 * Starts a sign-in through an identity provider.
 *
 * @param running The running application.
 * @param provider The key of the provider. The fake one when left out.
 * @returns The state the provider sends back with its answer.
 */
export async function start(running: Running, provider = "fake"): Promise<string> {
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
 * Finishes a sign-in with the provider's answer, as the page the provider
 * sent the person back to does.
 *
 * @param running The running application.
 * @param answer The state the sign-in was started with and the code the
 *   provider answered with. The fake provider and the secret
 *   the sign-in was started with, when those are left out.
 * @returns The gateway's answer, which carries the session when it accepted the sign-in.
 */
export function complete(
  running: Running,
  answer: {
    readonly state: string;
    readonly code: string;
    readonly provider?: string;
    readonly codeVerifier?: string;
  },
): Promise<Answered> {
  return call(running, "/auth/external/complete", {
    provider: "fake",
    codeVerifier: verifier,
    ...answer,
  });
}

/**
 * Signs in whoever an identity provider confirms under a code, as a browser does.
 *
 * @param running The running application.
 * @param provider The key of the provider.
 * @param code What the provider confirms: `<subject>:<email>:<name>`, where the
 *   name may be left out.
 * @returns The signed-in person, with their session.
 */
export async function signInWith(
  running: Running,
  provider: string,
  code: string,
): Promise<Signed> {
  const { status, body } = await complete(running, {
    provider,
    state: await start(running, provider),
    code,
  });
  expect(status).toBe(200);
  const signed = body.person as { id: string; email: string; name: string };
  return { token: body.token as string, person: signed.id, email: signed.email, name: signed.name };
}

/**
 * Signs one of the people of the tests in. Their account is named by their key.
 *
 * @param running The running application.
 * @param person The person's key.
 * @returns The signed-in person, with their session.
 */
export function signIn(running: Running, person: keyof typeof PEOPLE): Promise<Signed> {
  const { email, name } = PEOPLE[person];
  return signInWith(running, "fake", `${person}:${email}:${name}`);
}

/**
 * Asks the gateway who is signed in and which organizations are theirs.
 *
 * @param running The running application.
 * @param token The session's token, when the call carries one.
 * @returns The gateway's answer.
 */
export function session(running: Running, token?: string): Promise<Answered> {
  return call(running, "/auth/session", {}, token);
}

/**
 * Signs out.
 *
 * @param running The running application.
 * @param token The token of the session to end, when the call carries one.
 * @returns The gateway's answer.
 */
export function signOut(running: Running, token?: string): Promise<Answered> {
  return call(running, "/auth/sign-out", {}, token);
}

/**
 * Asks the gateway to let a session into an organization, whatever comes of it.
 *
 * @param running The running application.
 * @param token The session's token, when the call carries one.
 * @param organization What the call names as the organization, which need not be an identifier.
 * @returns The gateway's answer.
 */
export function entering(
  running: Running,
  token: string | undefined,
  organization: unknown,
): Promise<Answered> {
  return call(running, "/auth/organization", { organization }, token);
}

/**
 * Enters an organization, exchanging the session for one bound to it.
 *
 * @param running The running application.
 * @param signed A signed-in person who is a member of the organization.
 * @param organization The organization's name.
 * @returns The person, with the new session.
 */
export async function enter(
  running: Running,
  signed: Signed,
  organization: string,
): Promise<Signed> {
  const { status, body } = await entering(running, signed.token, organization);
  expect(status).toBe(200);
  return { ...signed, token: body.token as string };
}
