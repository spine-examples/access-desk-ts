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
import { assembleAccessDesk } from "./access-desk.js";
import { refuseProduction, serverSettingsOf } from "../settings.js";

/**
 * The application server.
 *
 * It hosts the Identity and Resources contexts. It knows nothing of browsers,
 * sessions, or identity providers. Those are the gateway's, which is a program of its own and
 * reaches this server over the network.
 *
 * The connection to the server is not secured. Spine's server speaks plain
 * HTTP/2 and offers neither encryption nor a way to check who is calling, so
 * the server trusts whoever can reach it to say who is acting. What protects
 * it is where it listens: only where the gateway can reach it, and nobody
 * else. `README.md` tells the whole of it.
 */

refuseProduction(process.env);
const { host, port } = serverSettingsOf(process.env).listening;

// The contexts are assembled before the server listens, and reach it only
// once somebody accepts an invitation.
const listening: { address?: string } = {};
const contexts = await assembleAccessDesk({
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

let stopping = false;
async function stop(): Promise<void> {
  if (!stopping) {
    stopping = true;
    await server.close();
    await contexts.close();
  }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
