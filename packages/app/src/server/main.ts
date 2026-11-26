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

import { ApplicationServer } from "./application-server.js";
import { WORKERS } from "./delivery-strategy.js";
import { Settings } from "../settings.js";
import { Storage } from "../storage.js";

/**
 * The application server.
 *
 * It hosts the Identity and Resources contexts, in a coordinator and its
 * workers, which take the messages for the contexts from the delivery server.
 */

const settings = Settings.ofServer(process.env);

await ApplicationServer.run(
  {
    listening: settings.listening,
    workers: WORKERS,
    deliveryUrl: settings.deliveryUrl,
    databases: Storage.serverDatabases(settings.database),
  },
  import.meta.url,
);

// The framework marks each worker it starts, and only the coordinator reports.
if (process.env.SPINE_MANAGED_SERVER_CHILD !== "true") {
  const { host } = settings.listening;
  console.log(`Access Desk application server: ${Settings.urlOf(settings.listening)}`);
  if (!Settings.onlyThisMachine(host)) {
    console.warn(
      `The application server listens on ${host}, so other machines can reach it. ` +
        "Make sure only the gateway can reach it.",
    );
  }
}
