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

import { Config } from "../config.js";

/** A signed-in person. */
export interface Person {
  /** The person's identifier. */
  readonly id: string;
  /** The email address the person is registered under. */
  readonly email: string;
  /** The person's display name. */
  readonly name: string;
}

/** The organization a session works in. */
export interface Membership {
  /** The organization's identifier. */
  readonly id: string;
  /** The organization's display name. */
  readonly name: string;
  /** The role the person holds there: `member` or `administrator`. */
  readonly role: string | null;
}

/** Who is signed in, and the organization they work in. */
export interface SessionInfo {
  /** The signed-in person. */
  readonly person: Person;
  /** The organization the session works in, or `null` when they belong to none. */
  readonly organization: Membership | null;
}

/** An identity provider people sign in through. */
export interface Provider {
  /** What the Access Desk API calls the provider. */
  readonly key: string;
  /** What to call the provider on the page. */
  readonly label: string;
}

/** Where the secret of a sign-in waits for the identity provider's answer. */
const VERIFIER = "access-desk.verifier";

/** Which identity provider the sign-in went to. */
const PROVIDER = "access-desk.provider";

/**
 * Sends a JSON POST request to the Access Desk API.
 */
async function ask<Answer>(
  path: string,
  body: object,
  token?: string,
): Promise<Answer | undefined> {
  try {
    const response = await fetch(new URL(path, Config.apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
    return response.ok ? ((await response.json()) as Answer) : undefined;
  } catch {
    return undefined;
  }
}

/** Authenticates people and manages their sessions through the Access Desk API. */
export const Authentication = {
  /**
   * Lists the identity providers people may sign in through,
   * or `undefined` when the Access Desk API does not answer.
   */
  async providers(): Promise<readonly Provider[] | undefined> {
    return (await ask<{ external: Provider[] }>("/auth/options", {}))?.external;
  },

  /**
   * Starts signing in through an identity provider, and sends the browser
   * there.
   *
   * The browser keeps a secret the provider's answer is finished with, so
   * only this browser can finish the sign-in.
   *
   * @returns `false` when the Access Desk API refused to start.
   */
  async signIn(provider: string): Promise<boolean> {
    const base64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const started = await ask<{ authorizationUrl: string }>("/auth/external/start", {
      provider,
      codeChallenge: base64url(new Uint8Array(digest)),
    });
    if (started === undefined) {
      return false;
    }
    sessionStorage.setItem(VERIFIER, verifier);
    sessionStorage.setItem(PROVIDER, provider);
    window.location.assign(started.authorizationUrl);
    return true;
  },

  /**
   * Finishes a sign-in the identity provider sent the browser back from.
   *
   * @returns The new session's token, `undefined` when the Access Desk API refused
   *   it, or `null` when the browser comes back from no sign-in.
   */
  async finishSignIn(): Promise<string | undefined | null> {
    const answer = new URLSearchParams(window.location.search);
    const code = answer.get("code");
    const state = answer.get("state");
    const codeVerifier = sessionStorage.getItem(VERIFIER);
    const provider = sessionStorage.getItem(PROVIDER);
    if (code === null || state === null || codeVerifier === null || provider === null) {
      return null;
    }
    sessionStorage.removeItem(VERIFIER);
    sessionStorage.removeItem(PROVIDER);
    window.history.replaceState(null, "", window.location.pathname);
    const issued = await ask<{ token: string }>("/auth/external/complete", {
      provider,
      state,
      code,
      codeVerifier,
    });
    return issued?.token;
  },

  /** Reads who a session's token stands for, or `undefined` when it stands for nobody. */
  session(token: string): Promise<SessionInfo | undefined> {
    return ask<SessionInfo>("/auth/session", {}, token);
  },

  /** Ends a session. */
  async signOut(token: string): Promise<void> {
    await ask("/auth/sign-out", {}, token);
  },
};
