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

import type { ReaderProofIssuer } from "@spine-event-engine/core/spi/reader-forwarding";
import type { SpineServicesOptions } from "@spine-event-engine/server";

/** The application server's rules for admitting a call and the person it is made for. */
export type ReaderAdmission = NonNullable<SpineServicesOptions["readerAdmission"]>;

/** The fixed proof the gateway sends with each call, as nothing is signed. */
const PROOF = "trusted-network";

// TODO:12-11-2026:mykyta.pimonov: Delete this object once Spine lets
//  a gateway pass the signed-in person on to an application server it trusts
//  without a proof. Spine asks for a proof on every such call, so the gateway
//  sends a fixed proof and the server accepts it.
/**
 * The way the gateway passes the signed-in person on to the application
 * server.
 *
 * Only the gateway can reach the server, so the server trusts the person each
 * call names. The framework passes a person on only with a proof, so the
 * gateway sends a fixed one, and the server accepts it.
 */
export const TrustedNetwork: {
  /** The gateway's side, which adds the proof to each call. */
  readonly issuer: ReaderProofIssuer;
  /** The server's side, which accepts every call and the person it names. */
  readonly admission: ReaderAdmission;
} = {
  issuer: { issue: () => PROOF },
  admission: {
    forwarded: { verify: () => true },
    direct: { authenticate: () => ({ reader: {} }) },
  },
};
