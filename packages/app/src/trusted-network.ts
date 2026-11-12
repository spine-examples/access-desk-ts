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

/** The mark the gateway puts on each call it passes on, in place of a signature. */
const TRUSTED = "trusted-network";

/**
 * The trust between the gateway and the application server, which rests on
 * the network alone.
 *
 * Only the gateway and the application server itself reach the application
 * server, as no other program shares its network. So the server takes every
 * call that reaches it, and the person a call of the gateway names.
 *
 * The framework still passes a signed-in person on only with a proof, and
 * takes the person from a call only through a check of that proof. Here the
 * proof is a fixed mark, and the check accepts it.
 */
export const TrustedNetwork: {
  /** The gateway's side, which marks each call it passes on. */
  readonly issuer: ReaderProofIssuer;
  /**
   * The application server's side, which takes every call, and the person a
   * call of the gateway names.
   */
  readonly admission: ReaderAdmission;
} = {
  issuer: { issue: () => TRUSTED },
  admission: {
    forwarded: { verify: () => true },
    direct: { authenticate: () => ({}) },
  },
};
