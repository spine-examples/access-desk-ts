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

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { SignedSessionSigningKey } from "@spine-event-engine/auth";

/**
 * The private key the gateway signs sessions with.
 *
 * It is a P-256 key. It never shows its bytes, so it cannot reach a log by
 * accident.
 */
export class SessionKey {
  /** The private key, as Node keeps it. */
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
  }

  /**
   * Reads a key written in base64 as PKCS #8.
   *
   * @param text The key, in base64.
   * @returns The key, or `undefined` when it is not a P-256 private key.
   */
  static fromBase64(text: string): SessionKey | undefined {
    try {
      const key = createPrivateKey({
        key: Buffer.from(text, "base64"),
        format: "der",
        type: "pkcs8",
      });
      return key.asymmetricKeyDetails?.namedCurve === "prime256v1"
        ? new SessionKey(key)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Builds the key as the framework's signed sessions take it.
   *
   * Its identifier, written in every token it signs, comes from the public
   * half of the key, so the same key always has the same identifier, and the
   * identifier tells nothing secret.
   *
   * @returns The key with its identifier.
   */
  signing(): SignedSessionSigningKey {
    const publicKey = createPublicKey(this.#key).export({ type: "spki", format: "der" });
    const kid = createHash("sha256").update(publicKey).digest("base64url").slice(0, 16);
    return { kid, privateKey: this.#key };
  }
}
