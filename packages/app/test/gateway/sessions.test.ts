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

import { create } from "@bufbuild/protobuf";
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { Sessions } from "../../src/gateway/sessions.js";

let sessions = new Sessions();
afterEach(async () => {
  await sessions.close();
  sessions = new Sessions();
});

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

  it("refuse a principal without email and use email when no name was supplied", async () => {
    const missingEmail = await sessions.create({ id: "missing", attributes: {} });
    expect(missingEmail.kind).toBe("created");
    if (missingEmail.kind === "created") {
      expect(await sessions.of(request(missingEmail.credential.value))).toBeUndefined();
    }

    const unnamed = await sessions.create({
      id: "unnamed",
      attributes: { email: "unnamed@example.com" },
    });
    expect(unnamed.kind).toBe("created");
    if (unnamed.kind === "created") {
      expect((await sessions.of(request(unnamed.credential.value)))?.person.name).toBe(
        "unnamed@example.com",
      );
    }
  });

  it("invalidate issued credentials when closed", async () => {
    const issued = await sessions.issue(person);
    expect(await sessions.of(request(issued?.token ?? ""))).toBeDefined();

    await sessions.close();

    expect(await sessions.of(request(issued?.token ?? ""))).toBeUndefined();
  });
});
