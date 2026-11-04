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

import { describe, expect, it } from "vitest";

import { Storage } from "../src/storage.js";

/** The PostgreSQL server, as the settings give it. */
const server = { host: "127.0.0.1", port: 5432, user: "desk", password: "secret" };

describe("The storage should", () => {
  it("keep the application server's data in the shared database and a database for each organization", () => {
    const databases = Storage.serverDatabases(server);

    expect(databases.url).toBe("postgresql://desk:secret@127.0.0.1:5432/accessdesk_server");
    expect(Storage.organizationDatabase(databases, "teamdev")).toBe(
      "postgresql://desk:secret@127.0.0.1:5432/accessdesk_resources_teamdev",
    );
  });

  it("keep the gateway's data in a separate database", () => {
    expect(Storage.gatewayDatabase(server)).toBe(
      "postgresql://desk:secret@127.0.0.1:5432/accessdesk_gateway",
    );
  });

  it("reach the database server where the settings say, with the password written as it is", () => {
    const databases = Storage.serverDatabases({
      host: "::1",
      port: 6543,
      user: "desk",
      password: " p@ss:w/rd% ",
    });

    expect(databases.url).toBe(
      "postgresql://desk:%20p%40ss%3Aw%2Frd%25%20@[::1]:6543/accessdesk_server",
    );
  });

  it("refuse an organization whose identifier cannot name its database", () => {
    const databases = Storage.serverDatabases(server);

    expect(() => Storage.organizationDatabase(databases, "team dev")).toThrow(
      /An organization's identifier must be of letters, digits/,
    );
    expect(() => Storage.organizationDatabase(databases, "o".repeat(43))).toThrow(
      /is longer than 63 characters/,
    );
    expect(Storage.organizationDatabase(databases, "o".repeat(42))).toMatch(/o{42}$/);
  });
});
