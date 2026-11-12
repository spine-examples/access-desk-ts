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

import { create } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import { TenantIdSchema, type TenantId } from "@spine-event-engine/proto";
import {
  Environment,
  ServerEnvironment,
  ShardIndex,
  type BoundedContext,
  type DeliveryStrategy,
} from "@spine-event-engine/server";
import type { StorageFactory } from "@spine-event-engine/storage";
import { IdentityContext } from "@access-desk/identity-server";
import { ResourcesContext } from "@access-desk/resources-server";
import { typeRegistry } from "../../generated/model-registry.js";
import { ReachedOrganizationMembers } from "./organization-members.js";

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
   * The organizations the application keeps, by their identifiers.
   */
  readonly organizations: readonly string[];
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
}

/**
 * Delivers the messages of each context in a separate shard.
 */
const SHARD_PER_CONTEXT: DeliveryStrategy = {
  shardCount: 2,
  shardFor(_targetId: Any, targetType: string): ShardIndex {
    return new ShardIndex(targetType.includes("/accessdesk.identity.") ? 0 : 1, 2);
  },
};

/** Assembles the application. */
export const AccessDesk = {
  /**
   * Assembles Access Desk from its contexts.
   *
   * 1. Sets up the server environment of this process over the storage.
   * 2. Adds the organizations to the environment's tenant index, so Resources
   *    takes what is given in them.
   * 3. Builds the contexts.
   *
   * @param options How to assemble the application.
   * @returns The contexts, ready to be hosted by a server.
   */
  async assemble(options: AccessDeskOptions): Promise<AccessDesk> {
    ServerEnvironment.when(Environment.instance().type).use({
      storageFactory: options.storage,
      typeRegistry,
      deliveryStrategy: SHARD_PER_CONTEXT,
    });
    const environment = ServerEnvironment.instance();
    await environment.completeSetup();
    for (const organization of options.organizations) {
      await environment.tenantIndex.keep(AccessDesk.tenantOf(organization));
    }
    const members = ReachedOrganizationMembers.through(options.server);
    const identity = await IdentityContext.create({ members });
    const resources = await ResourcesContext.create();
    return { identity, resources, members };
  },

  /** Returns the tenant of an organization. */
  tenantOf(organization: string): TenantId {
    return create(TenantIdSchema, { kind: { case: "value", value: organization } });
  },
};
