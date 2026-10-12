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

import { OpaqueSessions, type AuthenticatedPrincipal } from "@spine-event-engine/auth";
import { create } from "@bufbuild/protobuf";
import { EmailAddressSchema } from "@spine-event-engine/proto";
import {
  OrganizationIdSchema,
  PersonIdSchema,
  type OrganizationId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { SignedIn } from "./access-desk.js";

/**
 * The name under which a session's principal carries what the gateway knows
 * the session by, apart from its token.
 */
export const SESSION = "session";

/** How long a session lasts. */
const SESSION_MILLISECONDS = 8 * 60 * 60 * 1_000; // 8 hours.

/** A session a request carries. */
export interface Session {
  /**
   * What the gateway knows the session by, apart from its token. It never
   * leaves the gateway.
   */
  readonly id: string;
  /** The token the browser presents the session with. */
  readonly credential: { readonly kind: "cookie"; readonly value: string };
  /** The signed-in person. */
  readonly person: SignedIn;
  /** The organization the person has entered, when they have. */
  readonly organization: OrganizationId | undefined;
}

/** Whatever is opened under sessions and must not outlast them. */
export interface OpenedUnderSessions {
  /**
   * Closes what is opened under a session that is about to end, in the
   * session's own name.
   *
   * @param session The session, while its token still works.
   */
  closeFor(session: Session): Promise<void>;
  /**
   * Stops what is still open under a session that has ended.
   *
   * @param session What the gateway knows the session by.
   */
  stop(session: string): Promise<void>;
}

/** The signed-in person as the gateway sends them over HTTP. */
export interface BrowserPerson {
  /** The PersonId UUID serialized as a scalar HTTP JSON field. */
  readonly id: string;
  /** The EmailAddress value serialized as a scalar HTTP JSON field. */
  readonly email: string;
  /** The display name serialized as a scalar HTTP JSON field. */
  readonly name: string;
}

/** A session as the gateway hands it to the browser. */
export interface Issued {
  /** The bearer token the browser sends with every request. */
  readonly token: string;
  /** The signed-in person the session stands for. */
  readonly person: BrowserPerson;
  /** The OrganizationId UUID serialized as scalar HTTP JSON, or null. */
  readonly organization: string | null;
}

/**
 * The sessions of the people who have signed in.
 *
 * A session says who a person is and, once they have entered one, which
 * organization they work in. The browser holds it as a bearer token. Sessions
 * are kept in memory, so everybody is signed out when the gateway stops.
 *
 * When a session is ended, whatever was opened under it is stopped too.
 */
export class Sessions {
  /**
   * The sessions that are still good, each known by an opaque token. A session
   * ends after eight hours, or when it is ended.
   */
  readonly #sessions = new OpaqueSessions({ ttlMilliseconds: SESSION_MILLISECONDS });
  /** Whatever is opened under the sessions, when anything is. */
  readonly #opened: OpenedUnderSessions | undefined;

  /**
   * @param opened Whatever is opened under the sessions and must not outlast
   *   them. Nothing when left out.
   */
  constructor(opened?: OpenedUnderSessions) {
    this.#opened = opened;
  }

  /**
   * Gives a signed-in person a session.
   *
   * @param person The signed-in person.
   * @param organization The organization they have entered, when they have.
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
    return created.kind === "created"
      ? {
          token: created.credential.value,
          person: { id: person.id.uuid, email: person.email.value, name: person.name },
          organization: organization?.uuid ?? null,
        }
      : undefined;
  }

  /** Starts a session for whoever a sign-in through an outside provider confirmed. */
  create(principal: AuthenticatedPrincipal): ReturnType<OpaqueSessions["create"]> {
    return this.#sessions.create({
      ...principal,
      attributes: { ...principal.attributes, [SESSION]: crypto.randomUUID() },
    });
  }

  /** Whoever a bearer token stands for, when its session is still good. */
  resolve(token: string): ReturnType<OpaqueSessions["resolve"]> {
    return this.#sessions.resolve({ kind: "cookie", value: token });
  }

  /** The session a request carries, when it is still good. */
  async of(request: Request): Promise<Session | undefined> {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (token === undefined) {
      return undefined;
    }
    const principal = (await this.resolve(token))?.principal;
    const { email, name, organization, [SESSION]: id } = principal?.attributes ?? {};
    return principal === undefined || email === undefined || id === undefined
      ? undefined
      : {
          id,
          credential: { kind: "cookie", value: token },
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
   * Ends a session, so its token stops working and whatever was opened under
   * it stops.
   *
   * 1. What is opened under the session is closed in the session's own name,
   *    while its token still works.
   * 2. The token stops working.
   * 3. What is still open under the session, or was opened meanwhile, is
   *    stopped.
   */
  async end(session: Session): Promise<void> {
    await this.#opened?.closeFor(session);
    await this.#sessions.logout(session.credential);
    await this.#opened?.stop(session.id);
  }

  /** Ends every session. */
  async close(): Promise<void> {
    await this.#sessions.close();
  }
}
