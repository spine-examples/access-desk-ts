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
import type { StorageFactory } from "@spine-event-engine/storage";
import { PostgresStorageFactory } from "@spine-event-engine/storage-postgres";
import { typeRegistry } from "../generated/model-registry.js";
import { Settings, type ServerStorageSettings, type StorageSettings } from "./settings.js";

/** Opens the storage a program keeps its data in. */
export const Storage = {
  /**
   * Opens the storage in the PostgreSQL database the settings name.
   *
   * The database must exist already. Spine creates its tables in it the first
   * time they are needed.
   *
   * @param settings The database the program keeps its data in.
   * @returns The opened storage.
   */
  open(settings: StorageSettings): Promise<StorageFactory> {
    return PostgresStorageFactory.newBuilder()
      .setOptions({ url: settings.url })
      .setStringifierRegistry(Storage.stringifiers())
      .build();
  },

  /**
   * Opens the storage of the application server in the PostgreSQL databases
   * the settings name.
   *
   * Each organization has a separate database; other data shares one database.
   * All databases must exist already.
   *
   * @param settings The databases the application server keeps its data in.
   * @param organizations The organizations the server keeps.
   * @returns The opened storage.
   */
  openServer(
    settings: ServerStorageSettings,
    organizations: readonly string[],
  ): Promise<StorageFactory> {
    return PostgresStorageFactory.newBuilder()
      .setOptions({ url: settings.url })
      .setTenantOptions(
        organizations.map((organization) => ({
          tenantId: create(TenantIdSchema, { kind: { case: "value", value: organization } }),
          options: { url: Settings.organizationDatabase(settings, organization) },
        })),
      )
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
