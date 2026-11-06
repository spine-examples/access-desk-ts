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

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GrpcTransportOptions } from "@connectrpc/connect-node";
import type { ReaderProofIssuer } from "@spine-event-engine/core/spi/reader-forwarding";
import type { SpineServicesOptions } from "@spine-event-engine/server";

/** The application server's rules for admitting a call and the person it is made for. */
export type ReaderAdmission = NonNullable<SpineServicesOptions["readerAdmission"]>;

/** A step each call to the application server passes through before it is sent. */
export type CallStep = NonNullable<GrpcTransportOptions["interceptors"]>[number];

/** The header that carries the token of a program's own call. */
const OWN_CALL_TOKEN_HEADER = "access-desk-own-call-token";

/**
 * The label the token of own calls is derived from. The key signs it, so the
 * token never repeats a signature of a request the gateway passes on.
 */
const OWN_CALL_TOKEN_LABEL = "access-desk own call";

/**
 * The proof the application server takes of who makes a call to it.
 *
 * Only the gateway and the application server itself call the application
 * server. Each proves its calls with the key they share:
 *
 * 1. The gateway signs each request it passes on, with the signed-in person
 *    who makes it. The application server takes the person from the request
 *    only when it checks the signature.
 * 2. The gateway and the application server send a token with each call they
 *    make themselves, as the gateway's reads and the calls between the
 *    contexts. The token is derived from the key, so the key itself never
 *    travels. Such a call names nobody.
 * 3. The application server refuses a call with neither, or with one that does
 *    not hold, before it reads the call.
 */
export const ForwardingProof = {
  /**
   * Builds the gateway's side: signs each request it passes on.
   *
   * @param key The key the gateway and the application server share.
   */
  issuer(key: Buffer): ReaderProofIssuer {
    return { issue: (bytes) => sign(key, bytes) };
  },

  /**
   * Builds the side of a program that calls the application server itself:
   * sends the token of own calls with each of its calls.
   *
   * @param key The key the gateway and the application server share.
   * @returns The step that adds the token to each call of a connection to the
   *   application server.
   */
  ownCalls(key: Buffer): CallStep {
    const token = ownCallToken(key);
    return (next) => (request) => {
      request.header.set(OWN_CALL_TOKEN_HEADER, token);
      return next(request);
    };
  },

  /**
   * Builds the application server's side: checks the signature of each
   * request the gateway passes on and the token of each own call, and refuses
   * a call with neither.
   *
   * @param key The key the gateway and the application server share.
   */
  admission(key: Buffer): ReaderAdmission {
    const token = ownCallToken(key);
    return {
      forwarded: { verify: (bytes, proof) => matches(proof, sign(key, bytes)) },
      direct: {
        authenticate: ({ peer }) =>
          matches(peer.requestHeader.get(OWN_CALL_TOKEN_HEADER), token) ? {} : undefined,
      },
    };
  },
};

/** Signs one request the gateway passes on, in base64url. */
function sign(key: Buffer, bytes: Uint8Array): string {
  return createHmac("sha256", key).update(bytes).digest("base64url");
}

/** Derives the token of own calls from the key. */
function ownCallToken(key: Buffer): string {
  return sign(key, Buffer.from(OWN_CALL_TOKEN_LABEL));
}

/** Whether the signature or token a call carries is the expected one. */
function matches(given: string | null, expected: string): boolean {
  if (given === null) {
    return false;
  }
  const actual = Buffer.from(given);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
