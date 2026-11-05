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
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type UserConfig } from "vite";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const key = new URL(".certs/localhost-key.pem", import.meta.url);
const cert = new URL(".certs/localhost.pem", import.meta.url);

/**
 * Configures the web client.
 *
 * The page reads where it calls the Access Desk API from `import.meta.env.VITE_API_URL`,
 * as a Vite application reads its settings.
 */
export default defineConfig(({ command, mode }): UserConfig => {
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
  /** Sets the address the page calls the Access Desk API at. */
  const callingAt = (host: string, port: string) => ({
    "import.meta.env.VITE_API_URL": JSON.stringify(new URL(`https://${host}:${port}`).origin),
  });
  const application = {
    plugins: [react()],
    build: { outDir: "dist", target: "es2022" },
  };
  if (command !== "serve") {
    /** Reads a build setting, logging an error when its default is used. */
    const readOrDefault = (name: string, fallback: string): string => {
      const value = settings[name]?.trim();
      if (value) {
        return value;
      }
      console.error(`${name} is missing or blank. Continuing the build with ${fallback}.`);
      return fallback;
    };
    const apiHost = readOrDefault("ACCESS_DESK_API_HOST", "127.0.0.1");
    const apiPort = readOrDefault("ACCESS_DESK_API_PORT", "8443");
    return { ...application, define: callingAt(apiHost, apiPort) };
  }
  const [host = "", port = "", apiHost = "", apiPort = ""] = read([
    "ACCESS_DESK_WEB_HOST",
    "ACCESS_DESK_WEB_PORT",
    "ACCESS_DESK_GATEWAY_HOST",
    "ACCESS_DESK_GATEWAY_PORT",
  ]);
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error("The page is served over HTTPS. Make its certificate with `pnpm run cert`.");
  }
  const api = `http://${apiHost}:${apiPort}`;
  const listening = {
    host,
    port: Number(port),
    strictPort: true,
    https: { key: readFileSync(key), cert: readFileSync(cert) },
    proxy: { "/auth/": { target: api }, "/spine.client.": { target: api } },
  };
  return {
    ...application,
    server: listening,
    preview: listening,
    define: callingAt(host, port),
  };
});
