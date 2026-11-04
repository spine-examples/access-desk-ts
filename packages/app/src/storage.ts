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
import { create } from "@bufbuild/protobuf";
import { StringifierRegistry } from "@spine-event-engine/core";
import { TenantIdSchema } from "@spine-event-engine/proto";
import type { StorageFactory } from "@spine-event-engine/storage";
import { PostgresStorageFactory } from "@spine-event-engine/storage-postgres";
import { typeRegistry } from "../generated/model-registry.js";
import type { DatabaseServer } from "./settings.js";

/** Where an organization's identifier goes in the name of its database. */
const ORGANIZATION = "{organization}";

/**
 * The database of the application server that keeps what belongs to no
 * organization: people, their accounts and memberships, subscriptions, and the
 * messages waiting for delivery.
 */
const SERVER_DATABASE = "accessdesk_server";

/**
 * The name of each organization's database, with `{organization}` where the
 * organization's identifier goes.
 */
const ORGANIZATION_DATABASE = `accessdesk_resources_${ORGANIZATION}`;

/**
 * The database where the gateway keeps the subscriptions people hold and the
 * sessions they ended.
 */
const GATEWAY_DATABASE = "accessdesk_gateway";

/** What an organization's identifier may be made of, to go into a database name. */
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/**
 * The longest name of a database, in characters. PostgreSQL cuts a longer
 * name short, so two databases could end up with one name.
 */
const DATABASE_NAME_LENGTH = 63;

/** The PostgreSQL databases the application server keeps its data in. */
export interface ServerDatabases {
  /**
   * The address of the shared database.
   *
   * It keeps what belongs to no organization: people, their accounts and memberships,
   * subscriptions, and the messages waiting for delivery.
   */
  readonly url: string;
  /**
   * The name of each organization's database, with `{organization}` where the
   * organization's identifier goes.
   */
  readonly organizationDatabase: string;
}

/** Opens the storage a program keeps its data in, and knows the names of its databases. */
export const Storage = {
  /**
   * Builds the addresses of the application server's databases on the
   * PostgreSQL server.
   *
   * @param server The PostgreSQL server.
   */
  serverDatabases(server: DatabaseServer): ServerDatabases {
    return {
      url: Storage.databaseUrl(server, SERVER_DATABASE),
      organizationDatabase: ORGANIZATION_DATABASE,
    };
  },

  /**
   * Builds the address of the gateway's database on the PostgreSQL server.
   *
   * @param server The PostgreSQL server.
   */
  gatewayDatabase(server: DatabaseServer): string {
    return Storage.databaseUrl(server, GATEWAY_DATABASE);
  },

  /**
   * Builds the address of an organization's database.
   *
   * The organization's identifier goes where the name of the organization's
   * database has `{organization}`.
   *
   * @param databases The databases of the application server.
   * @param organization The organization's identifier.
   * @returns The address of the database, with the account to sign in to it.
   * @throws Error when the identifier is not of letters, digits, "-", and "_",
   *   or when the name it makes is too long for PostgreSQL.
   */
  organizationDatabase(databases: ServerDatabases, organization: string): string {
    if (!IDENTIFIER.test(organization)) {
      throw new Error(
        `An organization's identifier must be of letters, digits, "-", and "_", ` +
          `and is "${organization}".`,
      );
    }
    const database = databases.organizationDatabase.replaceAll(ORGANIZATION, organization);
    if (Buffer.byteLength(database, "utf8") > DATABASE_NAME_LENGTH) {
      throw new Error(
        `The database of organization ${organization}, "${database}", is longer than ` +
          `${DATABASE_NAME_LENGTH.toString()} characters.`,
      );
    }
    const url = new URL(databases.url);
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  },

  /**
   * Builds the address of a database on the PostgreSQL server.
   *
   * @param server The PostgreSQL server.
   * @param database The name of the database.
   */
  databaseUrl(server: DatabaseServer, database: string): string {
    const { host, port, user, password } = server;
    const address = isIP(host) === 6 ? `[${host}]` : host;
    return (
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${address}:${port.toString()}/${encodeURIComponent(database)}`
    );
  },

  /**
   * Opens the storage in a PostgreSQL database.
   *
   * The database must exist already. Spine creates its tables in it the first
   * time they are needed.
   *
   * @param url The address of the database.
   * @returns The opened storage.
   */
  open(url: string): Promise<StorageFactory> {
    return PostgresStorageFactory.newBuilder()
      .setOptions({ url })
      .setStringifierRegistry(Storage.stringifiers())
      .build();
  },

  /**
   * Opens the storage of the application server in its PostgreSQL databases.
   *
   * Each organization has a separate database; other data shares one database.
   * All databases must exist already.
   *
   * @param databases The databases the application server keeps its data in.
   * @param organizations The organizations the server keeps.
   * @returns The opened storage.
   * @throws Error when an organization's identifier cannot name its database.
   */
  openServer(
    databases: ServerDatabases,
    organizations: readonly string[],
  ): Promise<StorageFactory> {
    const tenants = organizations.map((organization) => ({
      tenantId: create(TenantIdSchema, { kind: { case: "value", value: organization } }),
      options: { url: Storage.organizationDatabase(databases, organization) },
    }));
    return PostgresStorageFactory.newBuilder()
      .setOptions({ url: databases.url })
      .setTenantOptions(tenants)
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
