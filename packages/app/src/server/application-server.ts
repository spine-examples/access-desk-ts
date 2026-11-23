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

import { RemoteDelivery } from "@spine-event-engine/delivery-client";
import {
  ManagedServerApplication,
  Server,
  type ManagedServerApplicationHandle,
  type ManagedServerApplicationOptions,
} from "@spine-event-engine/server";
import { Settings, type Listening } from "../settings.js";
import { Storage, type ServerDatabases } from "../storage.js";
import { AccessDesk } from "./access-desk.js";

/** The setup of the application server. */
export interface ApplicationServerSetup {
  /** The address the application server listens on. */
  readonly listening: Listening;
  /** The number of workers that handle the messages of the contexts. */
  readonly workers: number;
  /** The address of the delivery server. */
  readonly deliveryUrl: string;
  /** The databases the application server keeps its data in. */
  readonly databases: ServerDatabases;
}

/**
 * The application server: a coordinator and its workers.
 *
 * 1. The coordinator listens where the gateway reaches the application
 *    server. It passes each command and query to one worker, and each
 *    subscription to every worker, since any worker may handle what a
 *    subscription watches.
 * 2. Each worker is a separate process with both bounded contexts. It takes
 *    their messages from the delivery server, one shard at a time. The
 *    coordinator starts the workers, and starts a worker again if it stops.
 *
 * The same module runs as the coordinator and as every worker.
 */
export const ApplicationServer = {
  /**
   * Starts the application server, and stops it when the process is asked to stop.
   *
   * @param setup The setup of the application server.
   * @param moduleUrl The module each worker runs, which starts the application
   *   server the same way.
   * @returns In the coordinator, the application server once every worker is
   *   ready; in a worker, the worker once it is ready.
   */
  run(setup: ApplicationServerSetup, moduleUrl: string): Promise<ManagedServerApplicationHandle> {
    return ManagedServerApplication.run(options(setup, moduleUrl));
  },

  /**
   * Starts the application server, and leaves stopping it to the caller.
   *
   * @param setup The setup of the application server.
   * @param moduleUrl The module each worker runs, which starts the application
   *   server the same way.
   * @returns In the coordinator, the application server once every worker is
   *   ready; in a worker, the worker once it is ready.
   */
  start(setup: ApplicationServerSetup, moduleUrl: string): Promise<ManagedServerApplicationHandle> {
    return ManagedServerApplication.start(options(setup, moduleUrl));
  },
};

/** Describes the coordinator and its workers to the framework. */
function options(
  setup: ApplicationServerSetup,
  moduleUrl: string,
): ManagedServerApplicationOptions {
  const { host, port } = setup.listening;
  const coordinator = Settings.urlOf(setup.listening);
  let delivery: RemoteDelivery | undefined;
  return {
    processCount: setup.workers,
    host,
    port,
    moduleUrl,
    readerAdmission: "trusted-network",
    forwarding: "trusted-network",
    createServer: async (worker) => {
      const storage = await Storage.openServer(setup.databases);
      delivery = RemoteDelivery.connectTo({ endpoint: setup.deliveryUrl });
      const assembled = await AccessDesk.assemble({
        server: () => coordinator,
        storage,
        delivery,
      });
      return Server.atPort(worker.port, {
        host: worker.host,
        services: { readerAdmission: "trusted-network" },
        resources: [assembled.members],
      })
        .setApplication(assembled.application)
        .start();
    },
    synchronize: async () => {
      await delivery?.open();
    },
  };
}
