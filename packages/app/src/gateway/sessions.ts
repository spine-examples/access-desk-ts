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

import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import {
  SignedSessions,
  type AuthenticatedPrincipal,
  type ResolvedSession,
} from "@spine-event-engine/auth";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import { Time } from "@spine-event-engine/core/time";
import { EmailAddressSchema } from "@spine-event-engine/proto";
import {
  OrganizationIdSchema,
  PersonIdSchema,
  type OrganizationId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { SignedIn } from "./access-desk.js";
import type { EndedSessions } from "./ended-sessions.js";

/** The principal attribute that holds a session's identifier. */
export const SESSION = "session";

/** How long a session lasts. */
const SESSION_SECONDS = 8 * 60 * 60; // 8 hours.

/**
 * How long after it expires a token is still taken, as clocks may differ a
 * little.
 */
const CLOCK_SKEW_SECONDS = 60;

/** Who signs the sessions, as written in every token. */
const ISSUER = "access-desk-gateway";

/** Who the sessions are for, as written in every token. */
const AUDIENCE = "access-desk";

/** A session a request carries. */
export interface Session {
  /**
   * The session's identifier: the one its token carries (`jti`), which stays
   * the same however the token's signature is written.
   */
  readonly id: string;
  /** The token the browser sends. */
  readonly credential: { readonly kind: "bearer"; readonly value: string };
  /** The signed-in person. */
  readonly person: SignedIn;
  /** The organization the person belongs to, when they belong to one. */
  readonly organization: OrganizationId | undefined;
}

/** What is opened under a session and must end with it, such as subscriptions. */
export interface OpenedUnderSessions {
  /**
   * Closes what a session opened, while the session's token still works.
   *
   * @param session The session that is about to end.
   */
  closeFor(session: Session): Promise<void>;
  /**
   * Stops what is still open after a session has ended.
   *
   * @param session The identifier of the session.
   */
  stop(session: string): Promise<void>;
}

/** The signed-in person as the gateway sends them over HTTP. */
export interface BrowserPerson {
  /** The person's identifier. */
  readonly id: string;
  /** The person's email address. */
  readonly email: string;
  /** The person's display name. */
  readonly name: string;
}

/** A session as the gateway hands it to the browser. */
export interface Issued {
  /** The bearer token the browser sends with every request. */
  readonly token: string;
  /** The signed-in person the session stands for. */
  readonly person: BrowserPerson;
  /** The identifier of the organization the session works in, or `null`. */
  readonly organization: string | null;
}

/** How the sessions are kept. */
export interface SessionsOptions {
  /** The P-256 private key the gateway signs sessions with. */
  readonly key: KeyObject;
  /** The sessions people ended before they expired. */
  readonly ended: EndedSessions;
  /** What is opened under the sessions and must end with them. Nothing when left out. */
  readonly opened?: OpenedUnderSessions;
}

/**
 * The sessions of the people who have signed in.
 *
 * A session says who a person is and which organization they work in.
 * The browser holds it as a bearer token. Ending a session also stops
 * everything opened under it.
 *
 * A session ends after eight hours, or when it is ended. Its token carries
 * the gateway's signature, so the session stays good when the gateway
 * restarts. The gateway remembers the sessions that were ended for as long as
 * their tokens would be taken, so those tokens stay refused.
 */
export class Sessions {
  /** The sessions that are still good, each known by its signed token. */
  readonly #sessions: SignedSessions;
  /** What is opened under the sessions, when anything is. */
  readonly #opened: OpenedUnderSessions | undefined;

  /** @param options How the sessions are kept. */
  constructor(options: SessionsOptions) {
    const { ended } = options;
    this.#sessions = new SignedSessions({
      issuer: ISSUER,
      audience: AUDIENCE,
      activeKey: { kid: Sessions.#keyIdOf(options.key), privateKey: options.key },
      revocation: {
        kind: "supported",
        isRevoked: (id) => ended.isRevoked(id),
        // A token is taken until a little after it expires, so an ended
        // session is remembered until then.
        // TODO: Pass `revoke` through once Spine fixes it. Spine's logout
        //  gives the token's expiry without the clock skew, so a store that
        //  forgets the session then lets its token work again for a minute.
        revoke: (id, expiresAt) =>
          ended.revoke(id, timestampFromMs(timestampMs(expiresAt) + CLOCK_SKEW_SECONDS * 1_000)),
      },
      clock: { now: () => Time.currentTimeMillis() },
      ttlSeconds: SESSION_SECONDS,
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
    });
    this.#opened = options.opened;
  }

  /**
   * Gives a signed-in person a session.
   *
   * @param person The signed-in person.
   * @param organization The organization they belong to, when they belong to one.
   * @returns The session, or `undefined` when it could not be issued.
   */
  async issue(person: SignedIn, organization?: OrganizationId): Promise<Issued | undefined> {
    const created = await this.create({
      id: person.id.uuid,
      attributes: {
        email: person.email.value,
        name: person.name,
        ...(organization === undefined ? {} : { organization: organization.uuid }),
      },
    });
    return created.kind === "issued"
      ? {
          token: created.credential.value,
          person: { id: person.id.uuid, email: person.email.value, name: person.name },
          organization: organization?.uuid ?? null,
        }
      : undefined;
  }

  /** Starts a session for a person an identity provider confirmed. */
  create(principal: AuthenticatedPrincipal): ReturnType<SignedSessions["issue"]> {
    return this.#sessions.issue(principal);
  }

  /**
   * The person a token stands for, while its session is valid.
   *
   * The person's attributes include the session's identifier, which the
   * token carries.
   */
  async resolve(token: string): Promise<ResolvedSession | undefined> {
    const resolved = await this.#sessions.resolve({ kind: "bearer", value: token });
    const id = resolved === undefined ? undefined : Sessions.#idOf(token);
    return resolved === undefined || id === undefined
      ? undefined
      : {
          ...resolved,
          principal: {
            ...resolved.principal,
            attributes: { ...resolved.principal.attributes, [SESSION]: id },
          },
        };
  }

  /** The session a request carries, when it is still valid. */
  async of(request: Request): Promise<Session | undefined> {
    const token = Sessions.#tokenOf(request);
    if (token === undefined) {
      return undefined;
    }
    const principal = (await this.resolve(token))?.principal;
    const { email, name, organization, [SESSION]: id } = principal?.attributes ?? {};
    return principal === undefined || email === undefined || id === undefined
      ? undefined
      : {
          id,
          credential: { kind: "bearer", value: token },
          person: {
            id: create(PersonIdSchema, { uuid: principal.id }),
            email: create(EmailAddressSchema, { value: email }),
            name: name ?? email,
          },
          organization:
            organization === undefined
              ? undefined
              : create(OrganizationIdSchema, { uuid: organization }),
        };
  }

  /**
   * Ends a session and stops everything opened under it.
   *
   * 1. What the session opened is closed, while its token still works.
   * 2. The token stops working.
   * 3. Anything still open, or opened in the meantime, is stopped.
   *
   * @throws Error when the gateway could not remember that the session
   *   ended. Its token then keeps working until it expires.
   */
  async end(session: Session): Promise<void> {
    await this.#opened?.closeFor(session);
    const ended = await this.#sessions.logout(session.credential);
    await this.#opened?.stop(session.id);
    if (ended.kind === "unavailable") {
      throw new Error("The session could not be ended. Its token works until it expires.");
    }
  }

  /**
   * Ends the session of a token a request carries but that did not resolve.
   *
   * Such a token may still be good, as when the gateway could not tell
   * whether its session had ended. It is ended all the same, and anything
   * still open under it is stopped. A token the gateway did not sign, or one
   * that has expired, ends nothing.
   *
   * @param request The request that carries the token.
   * @throws Error when the gateway could not remember that the session
   *   ended. Its token then keeps working until it expires.
   */
  async endUnresolved(request: Request): Promise<void> {
    const token = Sessions.#tokenOf(request);
    if (token === undefined) {
      return;
    }
    const ended = await this.#sessions.logout({ kind: "bearer", value: token });
    if (ended.kind === "unavailable") {
      throw new Error("The session could not be ended. Its token works until it expires.");
    }
    // Only a token the gateway verified is revoked, so only then does it name a session.
    const id = ended.kind === "revoked" ? Sessions.#idOf(token) : undefined;
    if (id !== undefined) {
      await this.#opened?.stop(id);
    }
  }

  /** Stops honoring every session in this gateway. The tokens stay good for the next one. */
  async close(): Promise<void> {
    await this.#sessions.close();
  }

  /** The bearer token a request carries, when it carries one. */
  static #tokenOf(request: Request): string | undefined {
    return /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  }

  /**
   * The identifier of a session: the one its token carries (`jti`).
   *
   * The gateway takes the same token with its signature written in more than
   * one way, so the token's text does not tell one session from another. Its
   * identifier stays the same however the signature is written, and it is
   * the one the gateway remembers an ended session by.
   *
   * @param token A token the gateway verified.
   * @returns The identifier, or `undefined` when the token carries none.
   */
  static #idOf(token: string): string | undefined {
    const payload = token.split(".")[1];
    if (payload === undefined) {
      return undefined;
    }
    try {
      const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const id = (claims as { readonly jti?: unknown } | null)?.jti;
      return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The identifier of a signing key, written in every token it signs.
   *
   * It is derived from the public half of the key, so the same key always
   * has the same identifier, and the identifier tells nothing secret.
   */
  static #keyIdOf(key: KeyObject): string {
    const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
    return createHash("sha256").update(publicKey).digest("base64url").slice(0, 16);
  }
}
