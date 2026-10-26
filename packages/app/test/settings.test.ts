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
import { describe, expect, it } from "vitest";

import { Settings } from "../src/settings.js";

/** A key the gateway may sign sessions with, as `.env` holds it. */
const SESSION_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

const server = {
  ACCESS_DESK_SERVER_HOST: "127.0.0.1",
  ACCESS_DESK_SERVER_PORT: "8090",
  ACCESS_DESK_STORAGE: "memory",
};
const gateway = {
  ...server,
  ACCESS_DESK_GATEWAY_HOST: "127.0.0.1",
  ACCESS_DESK_GATEWAY_PORT: "8080",
  ACCESS_DESK_WEB_HOST: "localhost",
  ACCESS_DESK_WEB_PORT: "5173",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  ACCESS_DESK_SESSION_KEY: SESSION_KEY,
};
/** Both programs keep their data in PostgreSQL. */
const inPostgres = {
  ...gateway,
  ACCESS_DESK_STORAGE: "postgresql",
  ACCESS_DESK_DATABASE_HOST: "127.0.0.1",
  ACCESS_DESK_DATABASE_PORT: "5432",
  ACCESS_DESK_DATABASE_USER: "desk",
  ACCESS_DESK_DATABASE_PASSWORD: "secret",
  ACCESS_DESK_IDENTITY_DATABASE: "accessdesk_identity",
  ACCESS_DESK_GATEWAY_DATABASE: "accessdesk_gateway",
  ACCESS_DESK_ORGANIZATIONS: "teamdev, codematters",
  ACCESS_DESK_ORGANIZATION_DATABASE: "accessdesk_resources_{organization}",
  ACCESS_DESK_RESOURCES_DATABASE: "accessdesk_resources",
};

describe("The settings should", () => {
  it("give where the application server listens, and where it keeps people", () => {
    expect(Settings.ofServer(server)).toEqual({
      listening: { host: "127.0.0.1", port: 8090 },
      identityStorage: { kind: "memory" },
      resourcesStorage: { kind: "memory" },
    });
  });

  it("describe how the gateway is set up, reaching the server where the server listens", () => {
    const settings = Settings.ofGateway(gateway);

    expect(settings).toMatchObject({
      listening: { host: "127.0.0.1", port: 8080 },
      serverUrl: "http://127.0.0.1:8090",
      webUrl: "https://localhost:5173/",
      google: { clientId: "google-id", clientSecret: "google-secret" },
      storage: { kind: "memory" },
    });
    expect(settings.sessionKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("keep each program's data in its own PostgreSQL database, when asked to", () => {
    expect(Settings.ofServer(inPostgres).identityStorage).toEqual({
      kind: "postgresql",
      url: "postgresql://desk:secret@127.0.0.1:5432/accessdesk_identity",
    });
    expect(Settings.ofGateway(inPostgres).storage).toEqual({
      kind: "postgresql",
      url: "postgresql://desk:secret@127.0.0.1:5432/accessdesk_gateway",
    });
  });

  it("keep each organization listed in a database of its own, when asked to", () => {
    expect(Settings.ofServer(inPostgres).resourcesStorage).toEqual({
      kind: "postgresql",
      organizations: [
        {
          organization: "teamdev",
          url: "postgresql://desk:secret@127.0.0.1:5432/accessdesk_resources_teamdev",
        },
        {
          organization: "codematters",
          url: "postgresql://desk:secret@127.0.0.1:5432/accessdesk_resources_codematters",
        },
      ],
      subscriptionsUrl: "postgresql://desk:secret@127.0.0.1:5432/accessdesk_resources",
    });
  });

  it("refuse organizations that are not listed one by one, or a database without a place for them", () => {
    for (const organizations of ["teamdev,,codematters", "teamdev,teamdev", "team dev"]) {
      expect(() =>
        Settings.ofServer({ ...inPostgres, ACCESS_DESK_ORGANIZATIONS: organizations }),
      ).toThrow(/ACCESS_DESK_ORGANIZATIONS must list organizations/);
    }
    for (const database of ["accessdesk_resources", "accessdesk resources {organization}"]) {
      expect(() =>
        Settings.ofServer({ ...inPostgres, ACCESS_DESK_ORGANIZATION_DATABASE: database }),
      ).toThrow(/ACCESS_DESK_ORGANIZATION_DATABASE must name a database/);
    }
  });

  it("reach the database server where its settings say, with the password written as it is", () => {
    const settings = Settings.ofServer({
      ...inPostgres,
      ACCESS_DESK_DATABASE_HOST: "::1",
      ACCESS_DESK_DATABASE_PORT: "6543",
      ACCESS_DESK_DATABASE_PASSWORD: " p@ss:w/rd% ",
    });

    // The spaces around the password are part of it.
    expect(settings.identityStorage).toEqual({
      kind: "postgresql",
      url: "postgresql://desk:%20p%40ss%3Aw%2Frd%25%20@[::1]:6543/accessdesk_identity",
    });
  });

  it("refuse a database name PostgreSQL would cut short", () => {
    expect(() =>
      Settings.ofServer({ ...inPostgres, ACCESS_DESK_IDENTITY_DATABASE: "a".repeat(64) }),
    ).toThrow(/ACCESS_DESK_IDENTITY_DATABASE must name a database of at most 63 characters/);
    const long = "o".repeat(45);
    expect(() =>
      Settings.ofServer({ ...inPostgres, ACCESS_DESK_ORGANIZATIONS: `teamdev, ${long}` }),
    ).toThrow(
      new RegExp(
        `ACCESS_DESK_ORGANIZATION_DATABASE names databases longer than 63 characters for ${long}\\.`,
      ),
    );
    expect(() =>
      Settings.ofServer({ ...inPostgres, ACCESS_DESK_IDENTITY_DATABASE: "a".repeat(63) }),
    ).not.toThrow();
  });

  it("refuse to assume anything, and name every setting that is missing", () => {
    expect(() => Settings.ofServer({})).toThrow(
      /ACCESS_DESK_SERVER_HOST is not set[\s\S]*ACCESS_DESK_SERVER_PORT is not set[\s\S]*ACCESS_DESK_STORAGE is not set/,
    );
    expect(() => Settings.ofGateway({})).toThrow(
      /ACCESS_DESK_GATEWAY_HOST[\s\S]*ACCESS_DESK_GATEWAY_PORT[\s\S]*ACCESS_DESK_SERVER_HOST[\s\S]*ACCESS_DESK_SERVER_PORT[\s\S]*ACCESS_DESK_WEB_HOST[\s\S]*ACCESS_DESK_WEB_PORT[\s\S]*GOOGLE_CLIENT_ID is not set[\s\S]*GOOGLE_CLIENT_SECRET is not set[\s\S]*ACCESS_DESK_STORAGE is not set[\s\S]*ACCESS_DESK_SESSION_KEY is not set/,
    );
  });

  it("ask for a database only when the data is kept in PostgreSQL", () => {
    const withoutDatabases = {
      ...inPostgres,
      ACCESS_DESK_DATABASE_HOST: "",
      ACCESS_DESK_DATABASE_PORT: "",
      ACCESS_DESK_DATABASE_USER: "",
      ACCESS_DESK_DATABASE_PASSWORD: "",
      ACCESS_DESK_IDENTITY_DATABASE: "",
      ACCESS_DESK_GATEWAY_DATABASE: "",
      ACCESS_DESK_ORGANIZATIONS: "",
      ACCESS_DESK_ORGANIZATION_DATABASE: "",
      ACCESS_DESK_RESOURCES_DATABASE: "",
    };

    expect(() => Settings.ofServer(withoutDatabases)).toThrow(
      /ACCESS_DESK_IDENTITY_DATABASE is not set[\s\S]*ACCESS_DESK_DATABASE_HOST is not set[\s\S]*ACCESS_DESK_DATABASE_PORT is not set[\s\S]*ACCESS_DESK_DATABASE_USER is not set[\s\S]*ACCESS_DESK_DATABASE_PASSWORD is not set[\s\S]*ACCESS_DESK_ORGANIZATIONS is not set[\s\S]*ACCESS_DESK_ORGANIZATION_DATABASE is not set[\s\S]*ACCESS_DESK_RESOURCES_DATABASE is not set/,
    );
    expect(() => Settings.ofGateway(withoutDatabases)).toThrow(
      /ACCESS_DESK_GATEWAY_DATABASE is not set[\s\S]*ACCESS_DESK_DATABASE_HOST is not set/,
    );
    expect(() =>
      Settings.ofServer({ ...withoutDatabases, ACCESS_DESK_STORAGE: "memory" }),
    ).not.toThrow();
  });

  it("refuse a storage it does not know, a database name that is not one, and a port that is not one", () => {
    expect(() => Settings.ofServer({ ...server, ACCESS_DESK_STORAGE: "datastore" })).toThrow(
      'ACCESS_DESK_STORAGE must be "memory" or "postgresql", and is "datastore".',
    );
    for (const database of ["accessdesk identity", "postgresql://desk@127.0.0.1/accessdesk"]) {
      expect(() =>
        Settings.ofServer({ ...inPostgres, ACCESS_DESK_IDENTITY_DATABASE: database }),
      ).toThrow(/ACCESS_DESK_IDENTITY_DATABASE must name a database/);
    }
    expect(() => Settings.ofGateway({ ...inPostgres, ACCESS_DESK_DATABASE_PORT: "five" })).toThrow(
      /ACCESS_DESK_DATABASE_PORT must be a port/,
    );
  });

  it("refuse a session key that is not a P-256 private key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64");
    for (const key of ["not a key", rsa]) {
      expect(() => Settings.ofGateway({ ...gateway, ACCESS_DESK_SESSION_KEY: key })).toThrow(
        "ACCESS_DESK_SESSION_KEY must be a P-256 private key, written in base64 as PKCS #8.",
      );
    }
  });

  it("distinguish an address reached only from the same machine from any other", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "localhost",
      "LOCALHOST",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(Settings.onlyThisMachine(host)).toBe(true);
    }
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.5",
      "server",
      "127.example.com",
      "127.999.999.999",
      "[::1]",
      "::ffff:10.0.0.5",
    ]) {
      expect(Settings.onlyThisMachine(host)).toBe(false);
    }
  });

  it("refuse a port that is not one", () => {
    expect(() => Settings.ofServer({ ...server, ACCESS_DESK_SERVER_PORT: "eighty" })).toThrow(
      /ACCESS_DESK_SERVER_PORT must be a port/,
    );
    expect(() => Settings.ofGateway({ ...gateway, ACCESS_DESK_WEB_PORT: "0" })).toThrow(
      /ACCESS_DESK_WEB_PORT must be a port/,
    );
  });

  it("refuse a port written as anything but plain digits", () => {
    for (const written of ["0x1F90", "1e3", "8090.0", "+8090"]) {
      expect(() => Settings.ofServer({ ...server, ACCESS_DESK_SERVER_PORT: written })).toThrow(
        /ACCESS_DESK_SERVER_PORT must be a port/,
      );
    }
  });

  it("refuse a gateway without either setting of Google", () => {
    for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      expect(() => Settings.ofGateway({ ...gateway, [name]: "" })).toThrow(`${name} is not set.`);
    }
  });
});
