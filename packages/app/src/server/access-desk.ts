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
  Environment,
  InMemorySubscriptionRegistry,
  PersistentTenantIndex,
  ServerEnvironment,
  type BoundedContext,
  type ServerEnvironmentDelivery,
} from "@spine-event-engine/server";
import { StorageGroup, type StorageFactory } from "@spine-event-engine/storage";
import { IdentityContext } from "@access-desk/identity-server";
import { ResourcesContext } from "@access-desk/resources-server";
import { typeRegistry } from "../../generated/model-registry.js";
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
  /** The Identity context, which holds people, their accounts, and memberships. */
  readonly identity: BoundedContext;
  /** The Resources context, which holds each organization, its members, and what it owns. */
  readonly resources: BoundedContext;
  /**
   * The service through which Identity adds people to organizations' members.
   *
   * It holds a connection to the application server, which the server closes
   * after the contexts.
   */
  readonly members: ReachedOrganizationMembers;
  /** The register of the organizations the application keeps. */
  readonly organizations: PersistentTenantIndex;
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
   *    organizations.
   * 2. Sets up the server environment of this process over the storage and
   *    the register, so Resources takes only what is given in a registered
   *    organization. The messages go in the shards of `AccessDeskDeliveryStrategy`.
   * 3. Builds the contexts.
   *
   * @param options How to assemble the application.
   * @returns The contexts, ready to be hosted by a server.
   */
  async assemble(options: AccessDeskOptions): Promise<AccessDesk> {
    const organizations = await PersistentTenantIndex.create({
      storageFactory: options.storage,
      group: ORGANIZATIONS,
    });
    ServerEnvironment.when(Environment.instance().type).use({
      storageFactory: options.storage,
      typeRegistry,
      deliveryStrategy: AccessDeskDeliveryStrategy,
      tenantIndex: organizations,
      ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    });
    await ServerEnvironment.instance().completeSetup();
    const members = ReachedOrganizationMembers.through(options.server);
    const identity = await IdentityContext.create({
      members,
      subscriptions: new InMemorySubscriptionRegistry(),
    });
    const resources = await ResourcesContext.create({
      subscriptions: new InMemorySubscriptionRegistry(),
    });
    return { identity, resources, members, organizations };
  },
};
