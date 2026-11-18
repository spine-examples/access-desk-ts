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

import { createServer } from "node:net";
import { create } from "@bufbuild/protobuf";
import { DeliveryServer } from "@spine-event-engine/delivery-server";
import {
  OrganizationIdSchema,
  type OrganizationId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

import { eventually, givenRegisteredStorage } from "./hosted.js";

type AppModule = typeof import("../../../dist/src/index.js");
type ClientModule = typeof import("../../../dist/src/server/client.js");
type Setup = import("../../../dist/src/index.js").ApplicationServerSetup;

/** A connection to the application server, as a client of it. */
export type Connection = InstanceType<ClientModule["ServerConnection"]>;

/** The module each worker of the tests' application server runs. */
const WORKER = new URL("./worker.ts", import.meta.url).href;

/** What a test started, to stop once it ends, the last started first. */
const started: (() => Promise<void>)[] = [];

/** Stops everything a test started, the last started first. For a suite's `afterEach`. */
export async function stopApplicationServer(): Promise<void> {
  for (const stop of started.splice(0).reverse()) {
    await stop();
  }
  delete process.env.ACCESS_DESK_TEST_SERVER_SETUP;
}

/** Finds a port nothing listens on, for the coordinator, which its workers must know in advance. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

/**
 * Starts a delivery server and an application server with two workers over new
 * storage, with the test organizations registered, and connects to it.
 *
 * @returns The connection to the application server.
 */
export async function givenApplicationServer(): Promise<Connection> {
  const app: AppModule = await import("../../../dist/src/index.js");
  const { ServerConnection }: ClientModule = await import("../../../dist/src/server/client.js");
  const storage = await givenRegisteredStorage();
  started.push(() => storage.drop());
  const delivery = await new DeliveryServer({ host: "127.0.0.1", port: 0 }).start();
  started.push(() => delivery.close());
  const port = await freePort();
  const setup: Setup = {
    listening: { host: "127.0.0.1", port },
    workers: 2,
    deliveryUrl: delivery.baseUrl,
    databases: storage.settings,
  };
  // The workers take the setup of the application server from here.
  process.env.ACCESS_DESK_TEST_SERVER_SETUP = JSON.stringify(setup);
  const server = await app.ApplicationServer.start(setup, WORKER);
  started.push(() => server.close());
  const connection = new ServerConnection(() => `http://127.0.0.1:${port.toString()}`);
  started.push(() => connection.close());
  return connection;
}

/**
 * Creates an organization, and waits until its view shows it.
 *
 * @param connection The connection to the application server.
 * @param organization The organization's identifier, which is also its name.
 */
export async function givenOrganization(
  connection: Connection,
  organization: OrganizationId,
): Promise<void> {
  const { ServerRequests }: ClientModule = await import("../../../dist/src/server/client.js");
  const inOrganization = connection.in(organization).onBehalfOf("access-desk");
  await inOrganization.post(
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: organization, name: organization.uuid }),
  );
  await eventually(
    () =>
      ServerRequests.readById(
        inOrganization,
        OrganizationViewSchema,
        OrganizationIdSchema,
        organization,
      ),
    (view) => view !== undefined,
  );
}
