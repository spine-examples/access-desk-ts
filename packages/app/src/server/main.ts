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

import { Server } from "@spine-event-engine/server";
import { AccessDesk } from "./access-desk.js";
import { Settings } from "../settings.js";
import { Storage } from "../storage.js";

/**
 * The application server.
 *
 * It hosts the Identity and Resources contexts. It knows nothing of browsers,
 * sessions, or identity providers.
 */

const settings = Settings.ofServer(process.env);
const { host, port } = settings.listening;

const identityStorage = await Storage.open(settings.identityStorage);
// In PostgreSQL, Resources keeps every organization in a database of its own.
// Spine's PostgreSQL storage must be told every one of them when it opens, so
// the server keeps only the organizations the settings list.
const resourcesStorage = await Storage.openResources(settings.resourcesStorage);

const listening: { address?: string } = {};
const contexts = await AccessDesk.assemble({
  server: () => {
    if (listening.address === undefined) {
      throw new Error("The application server does not listen yet.");
    }
    return listening.address;
  },
  storage: {
    identity: identityStorage,
    resources: resourcesStorage.organizations,
    resourceSubscriptions: resourcesStorage.subscriptions,
  },
});
const server = await new Server({
  contexts: [contexts.identity, contexts.resources],
  host,
  port,
}).start();
listening.address = server.baseUrl;

console.log(`Access Desk application server: ${server.baseUrl}`);
console.log(
  settings.identityStorage.kind === "postgresql"
    ? "People and their memberships are kept in PostgreSQL."
    : "People and their memberships are kept in memory, and are forgotten when the server stops.",
);
const { resourcesStorage: kept } = settings;
console.log(
  kept.kind === "postgresql"
    ? `Organizations ${kept.organizations.map(({ organization }) => organization).join(", ")} ` +
        "are kept in PostgreSQL, and no other organization is."
    : "Organizations are kept in memory, and are forgotten when the server stops.",
);
if (!Settings.onlyThisMachine(host)) {
  console.warn(
    `The application server listens on ${host}, so other machines can reach it. ` +
      "Make sure only the gateway can reach it.",
  );
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (!stopping) {
      stopping = true;
      // Each is closed even when closing another fails.
      void (async () => {
        try {
          await server.close();
        } finally {
          try {
            await contexts.close();
          } finally {
            identityStorage.close();
            resourcesStorage.organizations.close();
            resourcesStorage.subscriptions.close();
          }
        }
      })().catch((error: unknown) => {
        console.error("The application server did not stop cleanly.", error);
        process.exitCode = 1;
      });
    }
  });
}
