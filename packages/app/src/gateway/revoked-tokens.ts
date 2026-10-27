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

import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { SignedTokenRevocation } from "@spine-event-engine/auth";
import { Time } from "@spine-event-engine/core/time";
import { Pool } from "pg";
import type { StorageSettings } from "../settings.js";

// TODO:27-10-2026:mykyta.pimonov: Delete this store once Spine keeps revoked
//  tokens itself. Spine leaves revocation to the application, so the gateway
//  keeps its own table and connection pool next to Spine's storage.
/** The tokens of the sessions people ended before they expired, by signing out. */
export const RevokedTokens = {
  /**
   * Opens the store of revoked tokens where the settings name.
   *
   * In PostgreSQL, the store keeps its table in the gateway's database, and
   * creates the table when it is not there.
   *
   * @param settings Where the gateway keeps its data.
   * @returns The opened store. Whoever opens it closes it.
   */
  async open(
    settings: StorageSettings,
  ): Promise<SignedTokenRevocation & { close(): Promise<void> }> {
    return settings.kind === "memory"
      ? new RevokedInMemory()
      : await RevokedInPostgres.open(settings.url);
  },
};

/** The revoked tokens, kept in the gateway's memory. A restart forgets them. */
class RevokedInMemory implements SignedTokenRevocation {
  readonly kind = "supported";
  /** The identifiers of the revoked tokens, each with when it can be forgotten, in milliseconds. */
  readonly #expiring = new Map<string, number>();

  isRevoked(token: string): Promise<boolean> {
    return Promise.resolve(this.#expiring.has(token));
  }

  revoke(token: string, expiresAt: Timestamp): Promise<void> {
    const now = Time.currentTimeMillis();
    for (const [revoked, expiring] of this.#expiring) {
      if (expiring <= now) {
        this.#expiring.delete(revoked);
      }
    }
    this.#expiring.set(token, timestampMs(expiresAt));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#expiring.clear();
    return Promise.resolve();
  }
}

/** The revoked tokens, kept in the gateway's PostgreSQL database. */
class RevokedInPostgres implements SignedTokenRevocation {
  readonly kind = "supported";
  /** The connections to the gateway's database. */
  readonly #pool: Pool;

  private constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Connects to the gateway's database, and makes the table of revoked tokens
   * when it is not there.
   *
   * @param url The address of the gateway's database.
   */
  static async open(url: string): Promise<RevokedInPostgres> {
    const pool = new Pool({ connectionString: url, max: 10 });
    // The server may drop a connection while it waits in the pool, as when it
    // restarts. The pool opens another when one is needed, so the failure is
    // only logged; unheard, it would stop the gateway.
    pool.on("error", (error) => {
      console.warn("A waiting connection to the gateway's database failed.", error);
    });
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS revoked_token (
           token_id   TEXT        PRIMARY KEY,
           expires_at TIMESTAMPTZ NOT NULL
         )`,
      );
    } catch (error) {
      await pool.end();
      throw error;
    }
    return new RevokedInPostgres(pool);
  }

  async isRevoked(token: string): Promise<boolean> {
    const found = await this.#pool.query("SELECT 1 FROM revoked_token WHERE token_id = $1", [
      token,
    ]);
    return (found.rowCount ?? 0) > 0;
  }

  async revoke(token: string, expiresAt: Timestamp): Promise<void> {
    await this.#pool.query("DELETE FROM revoked_token WHERE expires_at <= $1", [
      new Date(Time.currentTimeMillis()),
    ]);
    await this.#pool.query(
      "INSERT INTO revoked_token (token_id, expires_at) VALUES ($1, $2) ON CONFLICT (token_id) DO NOTHING",
      [token, new Date(timestampMs(expiresAt))],
    );
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}
