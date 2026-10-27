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
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { SignedTokenRevocation } from "@spine-event-engine/auth";
import { Time } from "@spine-event-engine/core/time";
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { TestStorages, type TestStorage } from "@access-desk/testing/storage";
import { typeRegistry } from "../../generated/model-registry.js";
import { RevokedTokens } from "../../src/gateway/revoked-tokens.js";
import { Sessions, type SessionSubscriptions } from "../../src/gateway/sessions.js";

/** The key the gateway signs sessions with. */
const KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

/** How long a session lasts, in milliseconds. */
const SESSION_MS = 8 * 60 * 60 * 1_000;

/** The order of the P-256 curve, the number every signature's `s` is taken modulo. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

let storage: TestStorage;
let revoked: Awaited<ReturnType<typeof RevokedTokens.open>>;
let sessions: Sessions;

beforeEach(async () => {
  storage = await TestStorages.singleTenant(typeRegistry);
  revoked = await RevokedTokens.open(TestStorages.settingsOf(storage));
  sessions = sessionsOfGateway();
});

afterEach(async () => {
  await sessions.close();
  await revoked.close();
  await storage.drop();
});

/**
 * Creates the sessions of a gateway that signs with the test's key and remembers
 * the revoked tokens in the test's store. Two of them stand for one gateway
 * before and after a restart.
 */
function sessionsOfGateway(subscriptions?: SessionSubscriptions): Sessions {
  return new Sessions({
    key: KEY,
    revoked,
    ...(subscriptions === undefined ? {} : { subscriptions }),
  });
}

const person = {
  id: create(PersonIdSchema, { uuid: "person-1" }),
  email: create(EmailAddressSchema, { value: "maya@example.com" }),
  name: "Maya Chen",
};

function request(token: string): Request {
  return new Request("https://gateway.test/auth/session", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Rewrites the token's signature the other way ECDSA allows: `s`
 * replaced by the curve's order less `s`. It signs the same claims.
 */
function withOtherSignature(token: string): string {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const bytes = Buffer.from(signature, "base64url");
  const s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
  const otherS = Buffer.from((P256_ORDER - s).toString(16).padStart(64, "0"), "hex");
  return `${header}.${payload}.${Buffer.concat([bytes.subarray(0, 32), otherS]).toString("base64url")}`;
}

/**
 * Keeps the revoked tokens in the test's store while it can be read and
 * written, and fails while it cannot.
 */
function failingWhenTold(): SignedTokenRevocation & { reading: boolean; writing: boolean } {
  const store = {
    kind: "supported" as const,
    reading: true,
    writing: true,
    isRevoked: (id: string) =>
      store.reading ? revoked.isRevoked(id) : Promise.reject(new Error("The store is down.")),
    revoke: (id: string, expiresAt: Parameters<SignedTokenRevocation["revoke"]>[1]) =>
      store.writing
        ? revoked.revoke(id, expiresAt)
        : Promise.reject(new Error("The store is down.")),
    close: () => Promise.resolve(),
  };
  return store;
}

describe("Gateway sessions should", () => {
  it("serialize typed person and organization values only in the issued HTTP shape", async () => {
    const organization = create(OrganizationIdSchema, { uuid: "acme" });

    const issued = await sessions.issue(person, organization);

    expect(issued).toMatchObject({
      person: { id: "person-1", email: "maya@example.com", name: "Maya Chen" },
      organization: "acme",
    });
    expect(typeof issued?.token).toBe("string");
    const carried = await sessions.of(request(issued?.token ?? ""));
    expect(carried?.person).toMatchObject({
      id: { uuid: "person-1" },
      email: { value: "maya@example.com" },
      name: "Maya Chen",
    });
    expect(carried?.organization?.uuid).toBe("acme");
  });

  it("issue a session without an organization and end it by its bearer credential", async () => {
    const issued = await sessions.issue(person);
    expect(issued?.organization).toBeNull();
    const carried = await sessions.of(request(issued?.token ?? ""));
    expect(carried?.organization).toBeUndefined();
    expect(carried).toBeDefined();

    if (carried === undefined) {
      return;
    }
    await sessions.end(carried);

    expect(await sessions.of(request(issued?.token ?? ""))).toBeUndefined();
  });

  it("stop what was opened under a session when it ends, and keep sessions apart", async () => {
    const closed: string[] = [];
    const issued = sessionsOfGateway({
      closeFor: async (session) => {
        // What is opened is closed in the session's name, so its token must still work.
        closed.push(`closing ${session.id}`);
        expect(await issued.of(request(session.credential.value))).toBeDefined();
      },
      stop: async (session) => {
        closed.push(`stopped ${session}`);
        expect(await issued.of(request(first?.credential.value ?? ""))).toBeUndefined();
      },
    });
    const first = await issued.of(request((await issued.issue(person))?.token ?? ""));
    const second = await issued.of(request((await issued.issue(person))?.token ?? ""));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      return;
    }
    // Two sessions of one person are two sessions.
    expect(first.id).not.toBe(second.id);

    await issued.end(first);

    expect(closed).toEqual([`closing ${first.id}`, `stopped ${first.id}`]);
    expect(await issued.of(request(first.credential.value))).toBeUndefined();
    expect(await issued.of(request(second.credential.value))).toBeDefined();
    await issued.close();
  });

  it("refuse absent, malformed, and unknown bearer credentials", async () => {
    const issued = await sessions.issue(person);
    expect(issued).toBeDefined();

    for (const authorization of [
      undefined,
      "Basic opaque",
      "bearer opaque",
      "Bearer ",
      "Bearer unknown",
    ]) {
      const incoming = new Request("https://gateway.test/auth/session", {
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(await sessions.of(incoming)).toBeUndefined();
    }
    expect(await sessions.of(request(issued?.token ?? ""))).toBeDefined();
  });

  it("refuse a token signed with another key", async () => {
    const other = new Sessions({
      key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      revoked,
    });
    const forged = await other.issue(person);
    expect(forged).toBeDefined();

    expect(await sessions.of(request(forged?.token ?? ""))).toBeUndefined();
    await other.close();
  });

  it("keep a session good when the gateway restarts, and an ended one refused", async () => {
    const kept = await sessions.issue(person);
    const ending = await sessions.of(request((await sessions.issue(person))?.token ?? ""));
    expect(ending).toBeDefined();
    if (ending === undefined) {
      return;
    }
    await sessions.end(ending);

    await sessions.close();
    sessions = sessionsOfGateway();

    expect((await sessions.of(request(kept?.token ?? "")))?.person.name).toBe("Maya Chen");
    expect(await sessions.of(request(ending.credential.value))).toBeUndefined();
  });

  it("know a session by its token's identifier, however the token's signature is written", async () => {
    const stopped: string[] = [];
    const issued = sessionsOfGateway({
      closeFor: () => Promise.resolve(),
      stop: (session) => {
        stopped.push(session);
        return Promise.resolve();
      },
    });
    const token = (await issued.issue(person))?.token ?? "";
    const rewritten = withOtherSignature(token);
    expect(rewritten).not.toBe(token);

    const original = await issued.of(request(token));
    const same = await issued.of(request(rewritten));

    expect(original).toBeDefined();
    expect(same?.id).toBe(original?.id);
    if (same === undefined) {
      return;
    }
    // Signing out with either form stops what the session opened in the other.
    await issued.end(same);
    expect(stopped).toEqual([original?.id]);
    expect(await issued.of(request(token))).toBeUndefined();
    await issued.close();
  });

  it("keep an ended session's token refused through the minute it is still taken after it expires", async () => {
    let nowMs = Date.now();
    Time.setProvider({ currentTime: () => timestampFromMs(nowMs) });
    try {
      const maya = (await sessions.issue(person))?.token ?? "";
      const ending = await sessions.of(request(maya));
      if (ending === undefined) {
        throw new Error("The session did not resolve.");
      }
      await sessions.end(ending);

      // Her token has expired, but is still taken for a while. Another person
      // signs out, and the gateway forgets the sessions no token can be used for.
      nowMs += SESSION_MS + 30_000;
      const other = await sessions.of(request((await sessions.issue(person))?.token ?? ""));
      if (other === undefined) {
        throw new Error("The other session did not resolve.");
      }
      await sessions.end(other);

      expect(await sessions.of(request(maya))).toBeUndefined();
    } finally {
      Time.resetProvider();
    }
  });

  it("end a session it cannot resolve, once it can remember the end, and stop what it opened", async () => {
    const store = failingWhenTold();
    const stopped: string[] = [];
    const issued = new Sessions({
      key: KEY,
      revoked: store,
      subscriptions: {
        closeFor: () => Promise.resolve(),
        stop: (session) => {
          stopped.push(session);
          return Promise.resolve();
        },
      },
    });
    const token = (await issued.issue(person))?.token ?? "";
    const session = await issued.of(request(token));
    expect(session).toBeDefined();

    // The store cannot be read or written, so no session resolves, and the
    // end cannot be remembered.
    store.reading = false;
    store.writing = false;
    expect(await issued.of(request(token))).toBeUndefined();
    await expect(issued.endUnresolved(request(token))).rejects.toThrow(/could not be ended/);
    expect(stopped).toEqual([]);

    // It can be written again, though not yet read.
    store.writing = true;
    await issued.endUnresolved(request(token));

    expect(stopped).toEqual([session?.id]);
    store.reading = true;
    expect(await issued.of(request(token))).toBeUndefined();
    await issued.close();
  });

  it("end nothing for a token it did not sign", async () => {
    const stopped: string[] = [];
    const issued = sessionsOfGateway({
      closeFor: () => Promise.resolve(),
      stop: (session) => {
        stopped.push(session);
        return Promise.resolve();
      },
    });

    await issued.endUnresolved(request("not-a-token"));

    expect(stopped).toEqual([]);
    await issued.close();
  });

  it("refuse a principal without email and use email when no name was supplied", async () => {
    const missingEmail = await sessions.create({ id: "missing", attributes: {} });
    expect(missingEmail.kind).toBe("issued");
    if (missingEmail.kind === "issued") {
      expect(await sessions.of(request(missingEmail.credential.value))).toBeUndefined();
    }

    const unnamed = await sessions.create({
      id: "unnamed",
      attributes: { email: "unnamed@example.com" },
    });
    expect(unnamed.kind).toBe("issued");
    if (unnamed.kind === "issued") {
      expect((await sessions.of(request(unnamed.credential.value)))?.person.name).toBe(
        "unnamed@example.com",
      );
    }
  });

  it("refuse every token once closed", async () => {
    const issued = await sessions.issue(person);
    expect(await sessions.of(request(issued?.token ?? ""))).toBeDefined();

    await sessions.close();

    expect(await sessions.of(request(issued?.token ?? ""))).toBeUndefined();
  });
});
