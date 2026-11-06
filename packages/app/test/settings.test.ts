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

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { Settings } from "../src/settings.js";

/** A key the gateway may sign sessions with, as `.env` holds it. */
const SESSION_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

/**
 * A key the gateway signs who makes each request it passes on, and the
 * application server checks it with, as `.env` holds it.
 */
const FORWARDING_PROOF_KEY = randomBytes(32);

const server = {
  ACCESS_DESK_SERVER_HOST: "127.0.0.1",
  ACCESS_DESK_SERVER_PORT: "8090",
  ACCESS_DESK_ORGANIZATIONS: "teamdev, codematters",
  ACCESS_DESK_DATABASE_HOST: "127.0.0.1",
  ACCESS_DESK_DATABASE_PORT: "5432",
  ACCESS_DESK_DATABASE_USER: "desk",
  ACCESS_DESK_DATABASE_PASSWORD: "secret",
  ACCESS_DESK_FORWARDING_PROOF_KEY: FORWARDING_PROOF_KEY.toString("base64"),
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

describe("The settings should", () => {
  it("give where the application server listens, which organizations it keeps, and where it keeps its data", () => {
    expect(Settings.ofServer(server)).toEqual({
      listening: { host: "127.0.0.1", port: 8090 },
      organizations: ["teamdev", "codematters"],
      database: { host: "127.0.0.1", port: 5432, user: "desk", password: "secret" },
      forwardingProofKey: FORWARDING_PROOF_KEY,
    });
  });

  it("describe how the gateway is set up, reaching the server where the server listens", () => {
    const settings = Settings.ofGateway(gateway);

    expect(settings).toMatchObject({
      listening: { host: "127.0.0.1", port: 8080 },
      serverUrl: "http://127.0.0.1:8090",
      webUrl: "https://localhost:5173/",
      google: { clientId: "google-id", clientSecret: "google-secret" },
      database: { host: "127.0.0.1", port: 5432, user: "desk", password: "secret" },
    });
    expect(settings.sessionKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(settings.forwardingProofKey).toEqual(FORWARDING_PROOF_KEY);
  });

  it("refuse organizations that are not listed one by one", () => {
    for (const organizations of ["teamdev,,codematters", "teamdev,teamdev"]) {
      expect(() =>
        Settings.ofServer({ ...server, ACCESS_DESK_ORGANIZATIONS: organizations }),
      ).toThrow(/ACCESS_DESK_ORGANIZATIONS must list organizations/);
    }
  });

  it("take the database password as it is written", () => {
    const settings = Settings.ofServer({ ...server, ACCESS_DESK_DATABASE_PASSWORD: " p@ss " });

    // The spaces around the password are part of it.
    expect(settings.database.password).toBe(" p@ss ");
  });

  it("refuse to assume anything, and name every setting that is missing", () => {
    expect(() => Settings.ofServer({})).toThrow(
      /ACCESS_DESK_SERVER_HOST is not set[\s\S]*ACCESS_DESK_SERVER_PORT is not set[\s\S]*ACCESS_DESK_ORGANIZATIONS is not set[\s\S]*ACCESS_DESK_DATABASE_HOST is not set[\s\S]*ACCESS_DESK_DATABASE_PORT is not set[\s\S]*ACCESS_DESK_DATABASE_USER is not set[\s\S]*ACCESS_DESK_DATABASE_PASSWORD is not set[\s\S]*ACCESS_DESK_FORWARDING_PROOF_KEY is not set/,
    );
    expect(() => Settings.ofGateway({})).toThrow(
      /ACCESS_DESK_GATEWAY_HOST[\s\S]*ACCESS_DESK_GATEWAY_PORT[\s\S]*ACCESS_DESK_SERVER_HOST[\s\S]*ACCESS_DESK_SERVER_PORT[\s\S]*ACCESS_DESK_WEB_HOST[\s\S]*ACCESS_DESK_WEB_PORT[\s\S]*GOOGLE_CLIENT_ID is not set[\s\S]*GOOGLE_CLIENT_SECRET is not set[\s\S]*ACCESS_DESK_DATABASE_HOST is not set[\s\S]*ACCESS_DESK_SESSION_KEY is not set[\s\S]*ACCESS_DESK_FORWARDING_PROOF_KEY is not set/,
    );
  });

  it("refuse a forwarding proof key shorter than 32 bytes", () => {
    expect(() =>
      Settings.ofServer({
        ...server,
        ACCESS_DESK_FORWARDING_PROOF_KEY: randomBytes(16).toString("base64"),
      }),
    ).toThrow(
      "ACCESS_DESK_FORWARDING_PROOF_KEY must be a key of at least 32 bytes, written in base64.",
    );
  });

  it("refuse a database port that is not one", () => {
    expect(() => Settings.ofGateway({ ...server, ACCESS_DESK_DATABASE_PORT: "five" })).toThrow(
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
