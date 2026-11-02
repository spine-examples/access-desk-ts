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

import { StringifierRegistry } from "@spine-event-engine/core";
import { InMemoryStorageFactory, type StorageFactory } from "@spine-event-engine/storage";
import { PostgresStorageFactory } from "@spine-event-engine/storage-postgres";
import { typeRegistry } from "../generated/model-registry.js";
import { Organizations } from "./server/organizations.js";
import { Settings, type ServerStorageSettings, type StorageSettings } from "./settings.js";

/** Opens the storage a program keeps its data in. */
export const Storage = {
  /**
   * Opens the storage the settings name.
   *
   * A PostgreSQL database must exist already. Spine creates its tables in it
   * the first time they are needed.
   *
   * @param settings Where the program keeps its data.
   * @returns The opened storage.
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
   * Opens the storage of the application server the settings name.
   *
   * In PostgreSQL, each organization has a separate database; other data shares
   * one database. Spine finds each organization's database when needed. All
   * databases must exist already.
   *
   * @param settings Where the application server keeps its data.
   * @returns The opened storage.
   */
  openServer(settings: ServerStorageSettings): Promise<StorageFactory> {
    if (settings.kind === "memory") {
      return Promise.resolve(new InMemoryStorageFactory());
    }
    return PostgresStorageFactory.newBuilder()
      .setOptions({ url: settings.url })
      .setTenantResolver((tenant) => {
        const organization = Organizations.organizationOf(tenant);
        if (organization === undefined) {
          throw new Error("Only an organization's tenant has a database.");
        }
        return { url: Settings.organizationDatabase(settings, organization) };
      })
      .setStringifierRegistry(Storage.stringifiers())
      .build();
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
