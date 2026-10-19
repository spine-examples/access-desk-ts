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

import { Settings } from "../src/settings.js";

const server = { ACCESS_DESK_SERVER_HOST: "127.0.0.1", ACCESS_DESK_SERVER_PORT: "8090" };
const gateway = {
  ...server,
  ACCESS_DESK_GATEWAY_HOST: "127.0.0.1",
  ACCESS_DESK_GATEWAY_PORT: "8080",
  ACCESS_DESK_WEB_HOST: "localhost",
  ACCESS_DESK_WEB_PORT: "5173",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

describe("The settings should", () => {
  it("give where the application server listens", () => {
    expect(Settings.ofServer(server)).toEqual({ listening: { host: "127.0.0.1", port: 8090 } });
  });

  it("describe how the gateway is set up, reaching the server where the server listens", () => {
    expect(Settings.ofGateway(gateway)).toEqual({
      listening: { host: "127.0.0.1", port: 8080 },
      serverUrl: "http://127.0.0.1:8090",
      webUrl: "https://localhost:5173/",
      google: { clientId: "google-id", clientSecret: "google-secret" },
    });
  });

  it("refuse to assume anything, and name every setting that is missing", () => {
    expect(() => Settings.ofServer({})).toThrow(
      /ACCESS_DESK_SERVER_HOST is not set[\s\S]*ACCESS_DESK_SERVER_PORT is not set/,
    );
    expect(() => Settings.ofGateway({})).toThrow(
      /ACCESS_DESK_GATEWAY_HOST[\s\S]*ACCESS_DESK_GATEWAY_PORT[\s\S]*ACCESS_DESK_SERVER_HOST[\s\S]*ACCESS_DESK_SERVER_PORT[\s\S]*ACCESS_DESK_WEB_HOST[\s\S]*ACCESS_DESK_WEB_PORT[\s\S]*GOOGLE_CLIENT_ID is not set[\s\S]*GOOGLE_CLIENT_SECRET is not set/,
    );
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
