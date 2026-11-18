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

import {
  Application,
  Environment,
  InMemorySubscriptionRegistry,
  PersistentTenantIndex,
  ServerEnvironment,
  type ServerEnvironmentDelivery,
  type TenantIndex,
} from "@spine-event-engine/server";
import { StorageGroup, type StorageFactory } from "@spine-event-engine/storage";
import { IdentityContext } from "@access-desk/identity-server";
import { ResourcesContext } from "@access-desk/resources-server";
import { typeRegistry } from "../../generated/model-registry.js";
import { Closing } from "../closing.js";
import { ReachedOrganizationMembers } from "./organization-members.js";
import { AccessDeskDeliveryStrategy } from "./delivery-strategy.js";

/** How the application is assembled. */
export interface AccessDeskOptions {
  /**
   * Returns the address of the application server, once it listens.
   *
   * Identity uses it to add a person to an organization's members when an
   * administrator adds them.
   */
  readonly server: () => string;
  /**
   * Where the application keeps its data: each organization apart, and
   * everything that belongs to no organization together.
   */
  readonly storage: StorageFactory;
  /**
   * The delivery server the contexts take their messages from, shared with the
   * other workers of the application server.
   *
   * When left out, the messages wait in the shared database, and only this
   * process delivers them.
   */
  readonly delivery?: ServerEnvironmentDelivery;
}

/** The assembled application. */
export interface AccessDesk {
  /** The application, with both contexts, for a server to serve. */
  readonly application: Application;
  /**
   * The service through which Identity adds people to organizations' members.
   *
   * It holds a connection to the application server, which the server closes
   * when it stops.
   */
  readonly members: ReachedOrganizationMembers;
  /** The register of the organizations the application keeps. */
  readonly organizations: TenantIndex;
}

/** The storage group the register of organizations is kept in. */
const ORGANIZATIONS = new StorageGroup("organizations");

/** Assembles the application. */
export const AccessDesk = {
  /**
   * Assembles Access Desk from its contexts.
   *
   * 1. Opens the register of the organizations the application keeps. The
   *    register is kept in the shared database, which is the one list of the
   *    organizations, so Resources takes only what is given in a registered
   *    organization.
   * 2. Sets up the server environment over the storage. The messages go in
   *    the shards of `AccessDeskDeliveryStrategy`.
   * 3. Builds the application with both contexts.
   *
   * @param options How to assemble the application.
   * @returns The application, ready to be served.
   */
  async assemble(options: AccessDeskOptions): Promise<AccessDesk> {
    const organizations = await PersistentTenantIndex.create({
      storageFactory: options.storage,
      group: ORGANIZATIONS,
    });
    const environment = ServerEnvironment.newBuilder()
      .under(Environment.instance().type, (settings) => {
        settings.use({
          storageFactory: options.storage,
          typeRegistry,
          deliveryStrategy: AccessDeskDeliveryStrategy,
          ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
        });
      })
      .build();
    const members = ReachedOrganizationMembers.through(options.server);
    const builder = Application.newBuilder()
      .setServerEnvironment(environment)
      .setTenantIndex(organizations)
      .add(IdentityContext.create({ members, subscriptions: new InMemorySubscriptionRegistry() }))
      .add(ResourcesContext.create({ subscriptions: new InMemorySubscriptionRegistry() }));
    let application: Application;
    try {
      application = await builder.build();
    } catch (error) {
      try {
        await Closing.inOrder(builder, organizations, environment, members);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "The application was not built, and not everything opened for it closed.",
        );
      }
      throw error;
    }
    return {
      application,
      members,
      organizations: application.tenantIndex(),
    };
  },
};
