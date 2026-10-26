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
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { typeRegistry } from "../../generated/model-registry.js";
import { EndedSessions } from "../../src/gateway/ended-sessions.js";
import { Sessions, type OpenedUnderSessions } from "../../src/gateway/sessions.js";
import { TestStorages, type TestStorage } from "../given/storage.js";

/** The key the gateway signs sessions with. */
const KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

let storage: TestStorage;
let ended: EndedSessions;
let sessions: Sessions;

beforeEach(async () => {
  storage = await TestStorages.singleTenant(typeRegistry);
  ended = await EndedSessions.open(
    storage.url === undefined ? { kind: "memory" } : { kind: "postgresql", url: storage.url },
  );
  sessions = sessionsOfGateway();
});

afterEach(async () => {
  await sessions.close();
  await ended.close();
  await storage.drop();
});

/**
 * The sessions of a gateway that signs with the test's key and remembers
 * ended sessions in the test's store. Two of them stand for one gateway
 * before and after a restart.
 */
function sessionsOfGateway(opened?: OpenedUnderSessions): Sessions {
  return new Sessions({ key: KEY, ended, ...(opened === undefined ? {} : { opened }) });
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
      ended,
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
