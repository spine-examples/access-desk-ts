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

import { typeRegistry } from "../../generated/model-registry.js";
import { gatewaySettingsOf } from "../settings.js";
import { startGateway } from "./gateway.js";
import { gitHubSignIn, googleSignIn } from "./providers.js";
import type { ExternalSignIn } from "./routes/sign-in-routes.js";

/**
 * The gateway, the only program a browser talks to.
 *
 * It signs people in, keeps their sessions, and decides which of their
 * requests reach the application server.
 */

const settings = gatewaySettingsOf(process.env);

const external: Record<string, ExternalSignIn> = {};
if (settings.github !== undefined) {
  external.github = { provider: gitHubSignIn(settings.github), callbackUri: settings.webUrl };
}
const google = settings.google === undefined ? undefined : await googleSignIn(settings.google);
if (settings.google !== undefined && google !== undefined) {
  external.google = { provider: google, callbackUri: settings.webUrl };
} else if (settings.google !== undefined) {
  console.warn("Google could not be reached, so sign-in through Google is off.");
}

const gateway = await startGateway({
  backend: settings.serverUrl,
  registry: typeRegistry,
  // Only the page people open the application at may call the gateway.
  origins: [new URL(settings.webUrl).origin],
  host: settings.listening.host,
  port: settings.listening.port,
  external,
});

console.log(`Access Desk gateway: ${gateway.url}`);
console.log(`Application server it reaches: ${settings.serverUrl}`);
console.log(`People open the application at: ${settings.webUrl}`);
for (const [key, label] of [
  ["github", "GitHub"],
  ["google", "Google"],
] as const) {
  console.log(`Sign-in through ${label} is ${Object.hasOwn(external, key) ? "on" : "off"}.`);
}
if (Object.keys(external).length === 0) {
  console.warn("No identity provider is set up, so nobody can sign in.");
}
// A browser that leaves or reloads a page cancels its pending requests.
// That must not stop the gateway. Any other unhandled failure still does.
const CANCELLED = 1;
process.on("unhandledRejection", (reason) => {
  if ((reason as { code?: unknown } | null)?.code === CANCELLED) {
    console.warn(
      "A browser abandoned a request before it was answered:",
      reason instanceof Error ? reason.message : reason,
    );
    return;
  }
  console.error(reason);
  process.exit(1);
});

let stopping = false;
async function stop(): Promise<void> {
  if (!stopping) {
    stopping = true;
    await gateway.close();
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
