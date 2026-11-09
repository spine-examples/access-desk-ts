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

import { createHmac, createSecretKey, timingSafeEqual, type KeyObject } from "node:crypto";
import type { GrpcTransportOptions } from "@connectrpc/connect-node";
import type { ReaderProofIssuer } from "@spine-event-engine/core/spi/reader-forwarding";
import type { SpineServicesOptions } from "@spine-event-engine/server";

/** The application server's rules for admitting a call and the person it is made for. */
export type ReaderAdmission = NonNullable<SpineServicesOptions["readerAdmission"]>;

/** A step each call to the application server passes through before it is sent. */
export type CallStep = NonNullable<GrpcTransportOptions["interceptors"]>[number];

/** The shortest key the gateway and the application server may share: 32 bytes. */
const SHORTEST_KEY_BYTES = 32;

/** The header that carries the token of a program's own call. */
const OWN_CALL_TOKEN_HEADER = "access-desk-own-call-token";

/**
 * The label the token of own calls is derived from.
 *
 * The key signs it, so the token never repeats a signature
 * of a request the gateway passes on.
 */
const OWN_CALL_TOKEN_LABEL = "access-desk own call";

/**
 * The key the gateway and the application server share, which proves who makes
 * a call to the application server.
 *
 * It is at least 32 bytes long, and never shows its bytes, so it cannot reach
 * a log by accident.
 */
export class ForwardingProofKey {
  /** The bytes of the key, as Node keeps a secret key. */
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
  }

  /**
   * Reads a key written in base64.
   *
   * @param text The key, in base64.
   * @returns The key, or `undefined` when it is shorter than 32 bytes.
   */
  static fromBase64(text: string): ForwardingProofKey | undefined {
    const bytes = Buffer.from(text, "base64");
    return bytes.length < SHORTEST_KEY_BYTES
      ? undefined
      : new ForwardingProofKey(createSecretKey(bytes));
  }

  /**
   * Signs bytes with the key.
   *
   * @param bytes What is signed.
   * @returns The HMAC-SHA256 signature, in base64url.
   */
  sign(bytes: Uint8Array): string {
    return createHmac("sha256", this.#key).update(bytes).digest("base64url");
  }
}

/**
 * The proof the application server takes of who makes a call to it.
 *
 * Only the gateway and the application server itself call the application
 * server. Each proves its calls with the key they share:
 *
 * 1. The gateway signs each request it passes on, with the signed-in person
 *    who makes it. The application server takes the person from the request
 *    only when the signature checks out.
 * 2. The gateway and the application server send a token with each call they
 *    make themselves, such as the gateway's reads and the calls between the
 *    bounded contexts. The token is derived from the key, so the key itself
 *    never travels. Such a call names nobody.
 * 3. The application server refuses a call with neither, or with one that does
 *    not hold, before it reads the call.
 */
export const ForwardingProof = {
  /**
   * Builds the gateway's side: signs each request it passes on.
   *
   * @param key The key the gateway and the application server share.
   * @returns The signer the framework's browser server passes requests on with.
   */
  issuer(key: ForwardingProofKey): ReaderProofIssuer {
    return { issue: (bytes) => key.sign(bytes) };
  },

  /**
   * Builds the side of a program that calls the application server itself:
   * sends the token of own calls with each of its calls.
   *
   * @param key The key the gateway and the application server share.
   * @returns The step that adds the token to each call of a connection to the
   *   application server.
   */
  ownCalls(key: ForwardingProofKey): CallStep {
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
   * @returns The rules the framework's services admit calls to the
   *   application server by.
   */
  admission(key: ForwardingProofKey): ReaderAdmission {
    const token = ownCallToken(key);
    return {
      forwarded: { verify: (bytes, proof) => matches(proof, key.sign(bytes)) },
      direct: {
        authenticate: ({ peer }) =>
          matches(peer.requestHeader.get(OWN_CALL_TOKEN_HEADER), token) ? {} : undefined,
      },
    };
  },
};

/** Derives the token of own calls from the key. */
function ownCallToken(key: ForwardingProofKey): string {
  return key.sign(Buffer.from(OWN_CALL_TOKEN_LABEL));
}

/**
 * Whether the signature or token a call carries is the expected one.
 *
 * The comparison takes the same time however much of the two agrees, so its
 * timing tells nothing of the expected value.
 */
function matches(given: string | null, expected: string): boolean {
  if (given === null) {
    return false;
  }
  const actual = Buffer.from(given);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
