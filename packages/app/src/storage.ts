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
import { StringifierRegistry } from "@spine-event-engine/core";
import { TenantIdSchema } from "@spine-event-engine/proto";
import { InMemoryStorageFactory, type StorageFactory } from "@spine-event-engine/storage";
import { PostgresStorageFactory } from "@spine-event-engine/storage-postgres";
import { typeRegistry } from "../generated/model-registry.js";
import type { ResourcesStorageSettings, StorageSettings } from "./settings.js";

/** Where Resources keeps each organization, and what people subscribed to. */
export interface ResourcesStorage {
  /** Each organization and everything it owns. */
  readonly organizations: StorageFactory;
  /**
   * What people subscribed to, when it is not kept with the organizations.
   * A subscription belongs to no one organization.
   */
  readonly subscriptions?: StorageFactory;
}

/** Where a program keeps what it must remember. */
export const Storage = {
  /**
   * Opens the storage the settings name.
   *
   * A PostgreSQL database must exist already. Spine creates its tables in it
   * the first time they are needed.
   *
   * @param settings Where the program keeps its data.
   * @returns The opened storage. Whoever opened it closes it.
   */
  open(settings: StorageSettings): Promise<StorageFactory> {
    if (settings.kind === "memory") {
      return Promise.resolve(new InMemoryStorageFactory());
    }
    return PostgresStorageFactory.newBuilder()
      .setOptions({ url: settings.url })
      .setStringifierRegistry(Storage.stringifiers())
      .build();
  },

  /**
   * Opens the storage of Resources the settings name.
   *
   * In PostgreSQL, each organization is kept in a database of its own, and
   * what people subscribed to in one more. The databases must exist already.
   *
   * @param settings Where Resources keeps its data.
   * @returns The opened storage. Whoever opened it closes it.
   */
  async openResources(settings: ResourcesStorageSettings): Promise<ResourcesStorage> {
    if (settings.kind === "memory") {
      return { organizations: new InMemoryStorageFactory() };
    }
    const organizations = await PostgresStorageFactory.newBuilder()
      .setTenantOptions(
        settings.organizations.map(({ organization, url }) => ({
          tenantId: create(TenantIdSchema, { kind: { case: "value", value: organization } }),
          options: { url },
        })),
      )
      .setStringifierRegistry(Storage.stringifiers())
      .build();
    const subscriptions = await Storage.open({
      kind: "postgresql",
      url: settings.subscriptionsUrl,
    });
    return { organizations, subscriptions };
  },

  /**
   * Turns identifiers and columns into the text they are stored as, which
   * needs every type the application's messages use.
   */
  stringifiers(): StringifierRegistry {
    const stringifiers = new StringifierRegistry();
    stringifiers.setTypeRegistry(typeRegistry);
    return stringifiers;
  },
};
