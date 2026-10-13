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

/**
 * The application server.
 *
 * It hosts the Identity and Resources contexts. It knows nothing of browsers,
 * sessions, or identity providers.
 */

const { host, port } = Settings.ofServer(process.env).listening;

const listening: { address?: string } = {};
const contexts = await AccessDesk.assemble({
  server: () => {
    if (listening.address === undefined) {
      throw new Error("The application server does not listen yet.");
    }
    return listening.address;
  },
});
const server = await new Server({
  contexts: [contexts.identity, contexts.resources],
  host,
  port,
}).start();
listening.address = server.baseUrl;

console.log(`Access Desk application server: ${server.baseUrl}`);
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
      void server.close().then(() => contexts.close());
    }
  });
}
