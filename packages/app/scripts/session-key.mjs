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

/*
 * Prints a new key for the gateway to sign sessions with, ready for
 * `ACCESS_DESK_SESSION_KEY` in `.env`.
 *
 * It is a P-256 private key, written in base64 as PKCS #8. Keep it secret:
 * whoever has it can sign in as anybody. Replacing it signs everybody out.
 */

import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
console.log(privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
