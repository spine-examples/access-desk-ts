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
import { SignedSessions } from "@spine-event-engine/auth";
import { SessionKey } from "../../../src/gateway/session-key.js";

/**
 * Creates a new key a gateway may sign sessions with.
 *
 * @throws Error when the new key cannot be read back, which never happens.
 */
export function newSessionKey(): SessionKey {
  const text = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "der" })
    .toString("base64");
  const key = SessionKey.fromBase64(text);
  if (key === undefined) {
    throw new Error("A new P-256 key cannot be read back.");
  }
  return key;
}

/**
 * Creates the sessions of a gateway that signs with a new key.
 *
 * A session ends only when its token expires, as nothing keeps the sessions
 * people ended.
 */
export function givenSessions(): SignedSessions {
  return new SignedSessions({
    issuer: "access-desk-test",
    audience: "access-desk-test",
    activeKey: newSessionKey().signing(),
  });
}

/**
 * Starts a session for a person, as the gateway does once an identity
 * provider confirmed them.
 *
 * @param sessions The sessions of the gateway.
 * @param attributes What the session tells of the person: their `email`,
 *   `name`, and `organization`. Maya Chen of no organization when left out.
 * @returns The session's token.
 * @throws Error when the session was not started.
 */
export async function tokenOf(
  sessions: SignedSessions,
  attributes: Readonly<Record<string, string>> = { email: "maya@example.com", name: "Maya Chen" },
): Promise<string> {
  const issued = await sessions.issue({ id: "person-1", attributes });
  if (issued.kind !== "issued") {
    throw new Error(`The session was not started: ${issued.reason}.`);
  }
  return issued.credential.value;
}
