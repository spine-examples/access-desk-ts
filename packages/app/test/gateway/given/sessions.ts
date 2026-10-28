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
import { create } from "@bufbuild/protobuf";
import type { SignedTokenRevocation } from "@spine-event-engine/auth";
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { Sessions, type SessionSubscriptions } from "../../../src/gateway/sessions.js";

/** The key the gateway of the tests signs sessions with. */
const KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

/** The order of the P-256 curve, the number every signature's `s` is taken modulo. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** How long a session lasts, in milliseconds. */
export const SESSION_MS = 8 * 60 * 60 * 1_000;

/** The person who signs in across the tests. */
export const person = {
  id: create(PersonIdSchema, { uuid: "person-1" }),
  email: create(EmailAddressSchema, { value: "maya@example.com" }),
  name: "Maya Chen",
};

/**
 * Creates the sessions of a gateway that signs with the tests' key.
 *
 * Two of them over the same revoked tokens stand for one gateway before and
 * after a restart.
 *
 * @param revoked Where the gateway keeps the tokens of ended sessions.
 * @param subscriptions The subscriptions held under the sessions. None when left out.
 */
export function sessionsOfGateway(
  revoked: SignedTokenRevocation,
  subscriptions?: SessionSubscriptions,
): Sessions {
  return new Sessions({
    key: KEY,
    revoked,
    ...(subscriptions === undefined ? {} : { subscriptions }),
  });
}

/**
 * Creates subscriptions that cancel nothing, and note each session they stop.
 *
 * @param stopped Where to note the identifier of each session stopped.
 */
export function notingStops(stopped: string[]): SessionSubscriptions {
  return {
    closeFor: () => Promise.resolve(),
    stop: (session) => {
      stopped.push(session);
      return Promise.resolve();
    },
  };
}

/** Builds a request that carries a token, as a browser sends it. */
export function request(token: string): Request {
  return new Request("https://gateway.test/auth/session", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Rewrites the token's signature the other way ECDSA allows: `s`
 * replaced by the curve's order less `s`.
 */
export function withOtherSignature(token: string): string {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const bytes = Buffer.from(signature, "base64url");
  const s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
  const otherS = Buffer.from((P256_ORDER - s).toString(16).padStart(64, "0"), "hex");
  return `${header}.${payload}.${Buffer.concat([bytes.subarray(0, 32), otherS]).toString("base64url")}`;
}

/**
 * Creates a store of revoked tokens that keeps them in another store while
 * it can be read and written, and fails while it cannot.
 *
 * @param revoked The store that keeps the tokens.
 */
export function failingWhenTold(
  revoked: SignedTokenRevocation,
): SignedTokenRevocation & { reading: boolean; writing: boolean } {
  const store = {
    kind: "supported" as const,
    reading: true,
    writing: true,
    isRevoked: (id: string) =>
      store.reading ? revoked.isRevoked(id) : Promise.reject(new Error("The store is down.")),
    revoke: (id: string, expiresAt: Parameters<SignedTokenRevocation["revoke"]>[1]) =>
      store.writing
        ? revoked.revoke(id, expiresAt)
        : Promise.reject(new Error("The store is down.")),
  };
  return store;
}
