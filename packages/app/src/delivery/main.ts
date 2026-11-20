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

import { DeliveryServer } from "@spine-event-engine/delivery-server";
import { Closing } from "../closing.js";
import { Settings } from "../settings.js";

/**
 * The delivery server.
 *
 * It keeps the messages for the contexts until a worker of the application
 * server handles them, and knows which worker handles each shard. It keeps
 * them in memory only: the messages that wait when it stops are lost.
 */

const settings = Settings.ofDelivery(process.env);
const { host, port } = settings.listening;

const server = await new DeliveryServer({ host, port }).start();

console.log(`Access Desk delivery server: ${server.baseUrl}`);
if (!Settings.onlyThisMachine(host)) {
  console.warn(
    `The delivery server listens on ${host}, so other machines can reach it. ` +
      "Make sure only the application server can reach it.",
  );
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (!stopping) {
      stopping = true;
      void Closing.inOrder(server).catch((error: unknown) => {
        console.error("The delivery server did not stop cleanly.", error);
        process.exitCode = 1;
      });
    }
  });
}
