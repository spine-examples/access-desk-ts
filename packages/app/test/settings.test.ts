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

import { gatewaySettingsOf, serverSettingsOf } from "../src/settings.js";

const server = { ACCESS_DESK_SERVER_HOST: "127.0.0.1", ACCESS_DESK_SERVER_PORT: "8090" };
const gateway = {
  ...server,
  ACCESS_DESK_GATEWAY_HOST: "127.0.0.1",
  ACCESS_DESK_GATEWAY_PORT: "8080",
  ACCESS_DESK_WEB_HOST: "localhost",
  ACCESS_DESK_WEB_PORT: "5173",
};

describe("The settings should", () => {
  it("tell where the application server listens", () => {
    expect(serverSettingsOf(server)).toEqual({ listening: { host: "127.0.0.1", port: 8090 } });
  });

  it("tell how the gateway is set up, reaching the server where the server listens", () => {
    expect(gatewaySettingsOf(gateway)).toEqual({
      listening: { host: "127.0.0.1", port: 8080 },
      serverUrl: "http://127.0.0.1:8090",
      webUrl: "https://localhost:5173/",
      github: undefined,
      google: undefined,
    });
  });

  it("take an identity provider that both of its settings are given for", () => {
    const settings = gatewaySettingsOf({
      ...gateway,
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    });

    expect(settings.github).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(settings.google).toBeUndefined();
  });

  it("refuse to assume anything, and name every setting that is missing", () => {
    expect(() => serverSettingsOf({})).toThrow(
      /ACCESS_DESK_SERVER_HOST is not set[\s\S]*ACCESS_DESK_SERVER_PORT is not set/,
    );
    expect(() => gatewaySettingsOf({})).toThrow(
      /ACCESS_DESK_GATEWAY_HOST[\s\S]*ACCESS_DESK_GATEWAY_PORT[\s\S]*ACCESS_DESK_SERVER_HOST[\s\S]*ACCESS_DESK_SERVER_PORT[\s\S]*ACCESS_DESK_WEB_HOST[\s\S]*ACCESS_DESK_WEB_PORT/,
    );
  });

  it("refuse a port that is not one", () => {
    expect(() => serverSettingsOf({ ...server, ACCESS_DESK_SERVER_PORT: "eighty" })).toThrow(
      /ACCESS_DESK_SERVER_PORT must be a port/,
    );
    expect(() => gatewaySettingsOf({ ...gateway, ACCESS_DESK_WEB_PORT: "0" })).toThrow(
      /ACCESS_DESK_WEB_PORT must be a port/,
    );
  });

  it("refuse an identity provider that is only partly set up", () => {
    expect(() => gatewaySettingsOf({ ...gateway, GOOGLE_CLIENT_ID: "id" })).toThrow(
      /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/,
    );
  });
});
