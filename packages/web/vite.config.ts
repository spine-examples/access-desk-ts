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

import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const key = new URL(".certs/localhost-key.pem", import.meta.url);
const cert = new URL(".certs/localhost.pem", import.meta.url);

/**
 * Configures the web client.
 *
 * The page reads where it calls the application from `/config.json`, which
 * its server gives it: nginx in the containers, and the development server
 * here.
 */
export default defineConfig(({ command, mode }): UserConfig => {
  const application = {
    plugins: [react()],
    build: { outDir: "dist", target: "es2022" },
  };
  if (command !== "serve") {
    return application;
  }
  const settings = { ...loadEnv(mode, repository, "ACCESS_DESK_"), ...process.env };
  /** Reads required settings, in the order named. */
  const read = (names: readonly string[]): string[] => {
    const missing = names.filter((name) => (settings[name]?.trim() ?? "") === "");
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(", ")} must be set. Copy \`.env.example\` to \`.env\` in the repository and fill it in.`,
      );
    }
    return names.map((name) => settings[name]?.trim() ?? "");
  };
  const [host = "", port = "", gatewayHost = "", gatewayPort = ""] = read([
    "ACCESS_DESK_WEB_HOST",
    "ACCESS_DESK_WEB_PORT",
    "ACCESS_DESK_GATEWAY_HOST",
    "ACCESS_DESK_GATEWAY_PORT",
  ]);
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error(
      "The page is served over HTTPS. Make its certificate with `pnpm --dir packages/web run cert`.",
    );
  }
  const gateway = `http://${gatewayHost}:${gatewayPort}`;
  const listening = {
    host,
    port: Number(port),
    strictPort: true,
    https: { key: readFileSync(key), cert: readFileSync(cert) },
    proxy: { "/auth/": { target: gateway }, "/spine.client.": { target: gateway } },
  };
  return {
    ...application,
    plugins: [...application.plugins, settingsOf(new URL(`https://${host}:${port}`).origin)],
    server: listening,
    preview: listening,
  };
});

/**
 * Answers `/config.json` with the page's settings.
 *
 * @param apiUrl The address the page calls the application at.
 */
function settingsOf(apiUrl: string): Plugin {
  const answer = (_request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-cache");
    response.end(JSON.stringify({ apiUrl }));
  };
  return {
    name: "access-desk-settings",
    configureServer: (server) => {
      server.middlewares.use("/config.json", answer);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use("/config.json", answer);
    },
  };
}
