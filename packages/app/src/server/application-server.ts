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

import { isIP } from "node:net";
import { RemoteDelivery } from "@spine-event-engine/delivery-client";
import {
  Environment,
  ManagedServerApplication,
  Server,
  ServerEnvironment,
  type ManagedServerApplicationHandle,
  type ManagedServerApplicationOptions,
} from "@spine-event-engine/server";
import { typeRegistry } from "../../generated/model-registry.js";
import type { Listening } from "../settings.js";
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
 *    subscription to every worker.
 * 2. Each worker is a separate process with both contexts. The coordinator
 *    starts the workers, and starts a worker again if it stops.
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
    coordinatorEnvironment();
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
    coordinatorEnvironment();
    return ManagedServerApplication.start(options(setup, moduleUrl));
  },
};

/**
 * Sets up the server environment of the coordinator, which only needs to know
 * the types of the contexts' messages.
 *
 * In a worker, assembling the contexts sets the environment up in full instead.
 */
function coordinatorEnvironment(): void {
  ServerEnvironment.when(Environment.instance().type).use({ typeRegistry });
}

/** Describes the coordinator and its workers to the framework. */
function options(
  setup: ApplicationServerSetup,
  moduleUrl: string,
): ManagedServerApplicationOptions {
  const { host, port } = setup.listening;
  const coordinator = `http://${isIP(host) === 6 ? `[${host}]` : host}:${port.toString()}`;
  let delivery: RemoteDelivery | undefined;
  return {
    processCount: setup.workers,
    host,
    port,
    moduleUrl,
    readerAdmission: "trusted-network",
    forwarding: "trusted-network",
    createServer: async (worker) => {
      delivery = RemoteDelivery.connectTo({ endpoint: setup.deliveryUrl });
      const contexts = await AccessDesk.assemble({
        server: () => coordinator,
        storage: await Storage.openServer(setup.databases),
        delivery,
      });
      return new Server({
        contexts: [contexts.identity, contexts.resources],
        resources: [contexts.members, contexts.organizations],
        host: worker.host,
        port: worker.port,
        services: { readerAdmission: "trusted-network" },
      }).start();
    },
    synchronize: async () => {
      await delivery?.open();
    },
  };
}
