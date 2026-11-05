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
import type { ReaderProofIssuer } from "@spine-event-engine/core/spi/reader-forwarding";
import type { SpineServicesOptions } from "@spine-event-engine/server";

/** How the application server admits the people a request is made for. */
export type ReaderAdmission = NonNullable<SpineServicesOptions["readerAdmission"]>;

/** The length of a proof: an HMAC-SHA256, written in base64url. */
const PROOF = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The gateway's word to the application server on who makes a request it
 * passes on.
 *
 * 1. The gateway signs each request it passes on, with the signed-in person
 *    who makes it, by a key it shares with the application server.
 * 2. The application server takes a person from a request only when it checks
 *    the signature.
 * 3. A request without a signature, as the gateway's own reads and the calls
 *    between the contexts, names nobody. The application server takes it as
 *    before, as only the gateway and the server itself reach the server.
 */
export const ForwardingProof = {
  /**
   * Builds the gateway's side: signs each request it passes on.
   *
   * @param key The key the gateway and the application server share.
   */
  issuer(key: Buffer): ReaderProofIssuer {
    return { issue: (bytes) => sign(key, bytes).toString("base64url") };
  },

  /**
   * Builds the application server's side: checks the signature of each
   * request the gateway passes on, and admits a request without one as
   * naming nobody.
   *
   * @param key The key the gateway and the application server share.
   */
  admission(key: Buffer): ReaderAdmission {
    return {
      forwarded: {
        verify: (bytes, proof) => {
          if (!PROOF.test(proof)) {
            return false;
          }
          const given = Buffer.from(proof, "base64url");
          const expected = sign(key, bytes);
          return given.length === expected.length && timingSafeEqual(given, expected);
        },
      },
      direct: { authenticate: () => ({}) },
    };
  },
};

/** Signs one request the gateway passes on. */
function sign(key: Buffer, bytes: Uint8Array): Buffer {
  return createHmac("sha256", key).update(bytes).digest();
}
