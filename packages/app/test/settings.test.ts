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

const database = {
  ACCESS_DESK_DATABASE_HOST: "127.0.0.1",
  ACCESS_DESK_DATABASE_PORT: "5432",
  ACCESS_DESK_DATABASE_USER: "desk",
  ACCESS_DESK_DATABASE_PASSWORD: "secret",
};
const server = {
  ACCESS_DESK_SERVER_HOST: "127.0.0.1",
  ACCESS_DESK_SERVER_PORT: "8090",
  ACCESS_DESK_DELIVERY_HOST: "127.0.0.1",
  ACCESS_DESK_DELIVERY_PORT: "8484",
  ...database,
};
const delivery = {
  ACCESS_DESK_DELIVERY_HOST: "127.0.0.1",
  ACCESS_DESK_DELIVERY_PORT: "8484",
};
const gateway = {
  ACCESS_DESK_SERVER_HOST: "127.0.0.1",
  ACCESS_DESK_SERVER_PORT: "8090",
  ...database,
  ACCESS_DESK_GATEWAY_HOST: "127.0.0.1",
  ACCESS_DESK_GATEWAY_PORT: "8080",
  ACCESS_DESK_WEB_HOST: "localhost",
  ACCESS_DESK_WEB_PORT: "5173",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  ACCESS_DESK_SESSION_KEY: SESSION_KEY,
};

describe("The settings should", () => {
  it("give where the application server listens, its delivery server, and where it keeps its data", () => {
    expect(Settings.ofServer(server)).toEqual({
      listening: { host: "127.0.0.1", port: 8090 },
      deliveryUrl: "http://127.0.0.1:8484",
      database: { host: "127.0.0.1", port: 5432, user: "desk", password: "secret" },
    });
  });

  it("give where the delivery server listens", () => {
    expect(Settings.ofDelivery(delivery)).toEqual({
      listening: { host: "127.0.0.1", port: 8484 },
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
    expect(settings.sessionKey.signing().privateKey.asymmetricKeyDetails?.namedCurve).toBe(
      "prime256v1",
    );
  });

  it("take the database password as it is written", () => {
    const settings = Settings.ofServer({ ...server, ACCESS_DESK_DATABASE_PASSWORD: " p@ss " });

    // The spaces around the password are part of it.
    expect(settings.database.password).toBe(" p@ss ");
  });

  it("refuse to assume anything, and name every setting that is missing", () => {
    expect(() => Settings.ofServer({})).toThrow(
      /ACCESS_DESK_SERVER_HOST is not set[\s\S]*ACCESS_DESK_SERVER_PORT is not set[\s\S]*ACCESS_DESK_DELIVERY_HOST is not set[\s\S]*ACCESS_DESK_DELIVERY_PORT is not set[\s\S]*ACCESS_DESK_DATABASE_HOST is not set[\s\S]*ACCESS_DESK_DATABASE_PORT is not set[\s\S]*ACCESS_DESK_DATABASE_USER is not set[\s\S]*ACCESS_DESK_DATABASE_PASSWORD is not set/,
    );
    expect(() => Settings.ofDelivery({})).toThrow(
      /ACCESS_DESK_DELIVERY_HOST is not set[\s\S]*ACCESS_DESK_DELIVERY_PORT is not set/,
    );
    expect(() => Settings.ofGateway({})).toThrow(
      /ACCESS_DESK_GATEWAY_HOST[\s\S]*ACCESS_DESK_GATEWAY_PORT[\s\S]*ACCESS_DESK_SERVER_HOST[\s\S]*ACCESS_DESK_SERVER_PORT[\s\S]*ACCESS_DESK_WEB_HOST[\s\S]*ACCESS_DESK_WEB_PORT[\s\S]*GOOGLE_CLIENT_ID is not set[\s\S]*GOOGLE_CLIENT_SECRET is not set[\s\S]*ACCESS_DESK_DATABASE_HOST is not set[\s\S]*ACCESS_DESK_SESSION_KEY is not set/,
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

  it("reach a server that listens on every address at the loopback address", () => {
    expect(Settings.urlOf({ host: "0.0.0.0", port: 8484 })).toBe("http://127.0.0.1:8484");
    expect(Settings.urlOf({ host: "::", port: 8484 })).toBe("http://[::1]:8484");
  });

  it("refuse to reach another server at an address that stands for every address", () => {
    for (const host of ["0.0.0.0", "::"]) {
      expect(() => Settings.ofServer({ ...server, ACCESS_DESK_DELIVERY_HOST: host })).toThrow(
        /ACCESS_DESK_DELIVERY_HOST must name the machine to connect to/,
      );
      expect(() => Settings.ofGateway({ ...gateway, ACCESS_DESK_SERVER_HOST: host })).toThrow(
        /ACCESS_DESK_SERVER_HOST must name the machine to connect to/,
      );
    }
    expect(
      Settings.ofServer({ ...server, ACCESS_DESK_SERVER_HOST: "0.0.0.0" }).listening.host,
    ).toBe("0.0.0.0");
    expect(
      Settings.ofDelivery({
        ACCESS_DESK_DELIVERY_HOST: "0.0.0.0",
        ACCESS_DESK_DELIVERY_PORT: "8484",
      }).listening.host,
    ).toBe("0.0.0.0");
  });

  it("reach a server at the address it listens on, with an IPv6 address in brackets", () => {
    expect(Settings.urlOf({ host: "delivery", port: 8484 })).toBe("http://delivery:8484");
    expect(Settings.urlOf({ host: "10.0.0.5", port: 8090 })).toBe("http://10.0.0.5:8090");
    expect(Settings.urlOf({ host: "fd00::5", port: 8090 })).toBe("http://[fd00::5]:8090");
    expect(Settings.ofServer({ ...server, ACCESS_DESK_DELIVERY_HOST: "::1" }).deliveryUrl).toBe(
      "http://[::1]:8484",
    );
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
