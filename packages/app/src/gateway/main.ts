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
import { Settings } from "../settings.js";
import { Storage } from "../storage.js";
import { RevokedTokens } from "./revoked-tokens.js";
import { Gateway } from "./gateway.js";
import { SignInProvider } from "./providers.js";
import type { ExternalSignIn } from "./routes/sign-in-routes.js";

/**
 * The gateway, the only program a browser talks to.
 *
 * It signs people in, keeps their sessions, and decides which of their
 * requests reach the application server.
 */

const settings = Settings.ofGateway(process.env);

const google = await SignInProvider.google(settings.google);
if (google === undefined) {
  throw new Error("Google could not be reached, so nobody could sign in.");
}
const external: Record<string, ExternalSignIn> = {
  google: { provider: google, callbackUri: settings.webUrl },
};

const subscriptions = await Storage.open(settings.storage);
const revokedTokens = await RevokedTokens.open(settings.storage);

const gateway = await Gateway.start({
  backend: settings.serverUrl,
  registry: typeRegistry,
  // Only the page people open the application at may call the gateway.
  origins: [new URL(settings.webUrl).origin],
  host: settings.listening.host,
  port: settings.listening.port,
  external,
  sessionKey: settings.sessionKey,
  keeping: { subscriptions, revokedTokens },
});

console.log(`Access Desk gateway: ${gateway.url}`);
console.log(`Application server it reaches: ${settings.serverUrl}`);
console.log(`People open the application at: ${settings.webUrl}`);
console.log(
  settings.storage.kind === "postgresql"
    ? "Subscriptions and ended sessions are kept in PostgreSQL."
    : "Subscriptions and ended sessions are kept in memory, and are forgotten when the gateway stops.",
);
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
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (!stopping) {
      stopping = true;
      // Each is closed even when closing another fails.
      void (async () => {
        try {
          await gateway.close();
        } finally {
          try {
            await revokedTokens.close();
          } finally {
            subscriptions.close();
          }
        }
      })().catch((error: unknown) => {
        console.error("The gateway did not stop cleanly.", error);
        process.exitCode = 1;
      });
    }
  });
}
