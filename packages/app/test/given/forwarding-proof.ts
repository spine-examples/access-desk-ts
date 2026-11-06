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

import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Http2SessionManager, createGrpcTransport } from "@connectrpc/connect-node";
import { Client } from "@spine-event-engine/client-node";
import { OrganizationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

import type { CallStep } from "../../dist/src/forwarding-proof.js";
import { givenServer, type Hosted } from "../server/given/hosted.js";

/** A key the gateway and the application server do not share. */
export const OTHER_KEY = randomBytes(32);

/** The status of a call the application server refuses, as it cannot tell who makes it. */
export const UNAUTHENTICATED = 16;

/** The organization the calls of the tests concern. */
export const ACME = create(OrganizationIdSchema, { uuid: "acme" });

/** What closes once a test ends, in reverse order. */
let closing: (() => Promise<void>)[] = [];

/** A client of the application server in Acme, as any program that reaches the server. */
export type Caller = ReturnType<ReturnType<typeof Client.usingTransport>["onBehalfOf"]>;

/** The application server and the calls the tests make to it. */
export const Calls = {
  /** Starts an application server, stopped once the test ends. */
  async server(): Promise<Hosted> {
    const server = await givenServer();
    closing.push(() => server.stop());
    return server;
  },

  /**
   * Builds a client of the application server in Acme, closed once the test ends.
   *
   * @param server The application server.
   * @param steps What each call passes through before it is sent.
   */
  callerOf(server: Hosted, steps: CallStep[]): Caller {
    const sessions = new Http2SessionManager(server.url);
    const reaching = Client.usingTransport(
      createGrpcTransport({ baseUrl: server.url, sessionManager: sessions, interceptors: steps }),
      { tenant: ACME.uuid },
    );
    closing.push(async () => {
      await reaching.close();
      sessions.abort();
    });
    return reaching.onBehalfOf("someone");
  },

  /**
   * Builds the step that sends the token derived from the key with each call,
   * as the gateway and the server itself do.
   */
  async tokenOf(key: Buffer): Promise<CallStep> {
    const proof = await import("../../dist/src/forwarding-proof.js");
    return proof.ForwardingProof.ownCalls(key);
  },

  /** Reads Acme's view through a client. */
  async readAcme(caller: Caller): Promise<OrganizationView | undefined> {
    const client = await import("../../dist/src/server/client.js");
    return client.ServerRequests.readById(
      caller,
      OrganizationViewSchema,
      OrganizationIdSchema,
      ACME,
    );
  },

  /** Closes what the test opened. */
  async close(): Promise<void> {
    for (const close of closing.reverse()) {
      await close();
    }
    closing = [];
  },
};

/** Signing and checking a request the gateway passes on. */
export const Proofs = {
  /** Signs a request as the gateway does. */
  async signed(key: Buffer, bytes: Uint8Array): Promise<string> {
    const proof = await import("../../dist/src/forwarding-proof.js");
    return proof.ForwardingProof.issuer(key).issue(bytes);
  },

  /** Checks a signature as the application server does. */
  async checks(key: Buffer, bytes: Uint8Array, signature: string): Promise<boolean> {
    const proof = await import("../../dist/src/forwarding-proof.js");
    const verifier = proof.ForwardingProof.admission(key).forwarded;
    if (verifier === undefined) {
      throw new Error("The application server checks no request the gateway passes on.");
    }
    return verifier.verify(bytes, signature, undefined as never);
  },
};
