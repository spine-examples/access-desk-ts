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

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { StringifierRegistry, type TypeRegistryLookup } from "@spine-event-engine/core";
import type { TenantId } from "@spine-event-engine/proto";
import type { StorageFactory } from "@spine-event-engine/storage";
import {
  PostgresStorageFactory,
  type PostgresStorageFactoryBuilder,
} from "@spine-event-engine/storage-postgres";
import { Client } from "pg";

/**
 * The storage a test keeps its contexts' data in, and deletes when it ends.
 *
 * Each storage gets separate new PostgreSQL databases.
 */
export interface TestStorage {
  /**
   * The address of the storage's database. For a multitenant context, it is
   * the shared database.
   */
  readonly url: string;
  /**
   * Opens the storage, as a program does when it starts.
   *
   * The data is kept across restarts.
   */
  open(): Promise<StorageFactory>;
  /** Closes the storage and deletes its data. */
  drop(): Promise<void>;
}

/** Empty PostgreSQL databases, for a test that opens storage over them itself. */
export interface TestDatabases {
  /** The address of each database. */
  readonly urls: readonly string[];
  /** Deletes the databases. Close the storage over them first. */
  drop(): Promise<void>;
}

/** Creates storage for the tests, in new PostgreSQL databases. */
export const TestStorages = {
  /**
   * Creates empty PostgreSQL databases.
   *
   * @param count How many databases to create.
   */
  async databases(count: number): Promise<TestDatabases> {
    const urls = await Databases.create(count);
    return { urls, drop: () => Databases.drop(urls) };
  },

  /**
   * Creates PostgreSQL databases under the names given, unless they are there
   * already.
   *
   * @param names The names of the databases, of letters, digits, "-", and "_".
   */
  createDatabases(names: readonly string[]): Promise<void> {
    return Databases.createNamed(names);
  },

  /**
   * Deletes the PostgreSQL databases whose names start with the prefix, even
   * if something is still connected to them.
   *
   * @param prefix The start of the databases' names.
   */
  dropDatabasesStartingWith(prefix: string): Promise<void> {
    return Databases.dropStartingWith(prefix);
  },

  /**
   * Creates storage for a single-tenant context.
   *
   * @param registry The types of the context's messages.
   */
  async singleTenant(registry: TypeRegistryLookup): Promise<TestStorage> {
    const [url = ""] = await Databases.create(1);
    return new PostgresTestStorage(registry, [url], (builder) => builder.setOptions({ url }));
  },

  /**
   * Creates storage for a multitenant context.
   *
   * PostgreSQL keeps each tenant in a separate database, and what belongs to
   * no tenant, such as subscriptions, in one more shared database.
   *
   * @param registry The types of the context's messages.
   * @param tenants Every tenant of the context. PostgreSQL gives each a
   *   separate database, so it needs them all up front.
   */
  async multitenant(
    registry: TypeRegistryLookup,
    tenants: readonly TenantId[],
  ): Promise<TestStorage> {
    const urls = await Databases.create(tenants.length + 1);
    const [shared = "", ...tenantUrls] = urls;
    return new PostgresTestStorage(registry, urls, (builder) =>
      builder.setOptions({ url: shared }).setTenantOptions(
        tenants.map((tenantId, index) => ({
          tenantId,
          options: { url: tenantUrls[index] ?? "" },
        })),
      ),
    );
  },
};

/** Storage in PostgreSQL databases made for one test. */
class PostgresTestStorage implements TestStorage {
  readonly url: string;
  /** The types of the context's messages. */
  readonly #registry: TypeRegistryLookup;
  /** The addresses of the storage's databases. */
  readonly #databases: readonly string[];
  /** Points the storage at its databases. */
  readonly #configure: (builder: PostgresStorageFactoryBuilder) => PostgresStorageFactoryBuilder;
  /** The storage opened so far, closed on drop. */
  readonly #opened: StorageFactory[] = [];

  constructor(
    registry: TypeRegistryLookup,
    databases: readonly string[],
    configure: (builder: PostgresStorageFactoryBuilder) => PostgresStorageFactoryBuilder,
  ) {
    this.#registry = registry;
    this.#databases = databases;
    [this.url = ""] = databases;
    this.#configure = configure;
  }

  async open(): Promise<StorageFactory> {
    const stringifiers = new StringifierRegistry();
    stringifiers.setTypeRegistry(this.#registry);
    const factory = await this.#configure(
      PostgresStorageFactory.newBuilder().setStringifierRegistry(stringifiers),
    ).build();
    this.#opened.push(factory);
    return factory;
  }

  async drop(): Promise<void> {
    for (const factory of this.#opened.splice(0)) {
      await factory.close();
    }
    await Databases.drop(this.#databases);
  }
}

/** The tests' PostgreSQL databases. */
const Databases = {
  /**
   * Creates empty databases, and returns their addresses.
   *
   * @param count How many databases to create.
   */
  async create(count: number): Promise<string[]> {
    const urls: string[] = [];
    await Databases.administer(async (client) => {
      for (let made = 0; made < count; made++) {
        const name = `accessdesk_test_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
        await client.query(`CREATE DATABASE "${name}"`);
        urls.push(Databases.urlOf(name));
      }
    });
    return urls;
  },

  /**
   * Deletes databases, even if something is still connected to them.
   *
   * @param urls The addresses of the databases.
   */
  async drop(urls: readonly string[]): Promise<void> {
    await Databases.administer(async (client) => {
      for (const url of urls) {
        const name = new URL(url).pathname.slice(1);
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    });
  },

  /**
   * Creates databases under the names given, unless they are there already.
   *
   * @param names The names of the databases.
   */
  async createNamed(names: readonly string[]): Promise<void> {
    await Databases.administer(async (client) => {
      for (const name of names) {
        const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
        if ((found.rowCount ?? 0) === 0) {
          await client.query(`CREATE DATABASE "${name}"`);
        }
      }
    });
  },

  /**
   * Deletes the databases whose names start with the prefix, even if
   * something is still connected to them.
   *
   * @param prefix The start of the databases' names.
   */
  async dropStartingWith(prefix: string): Promise<void> {
    await Databases.administer(async (client) => {
      const found = await client.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
        [prefix],
      );
      for (const { datname } of found.rows) {
        await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    });
  },

  /** Connects to the database server, and runs the statements. */
  async administer(statements: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: Databases.server() });
    await client.connect();
    try {
      await statements(client);
    } finally {
      await client.end();
    }
  },

  /** Builds the address of the named database on the server. */
  urlOf(name: string): string {
    const url = new URL(Databases.server());
    url.pathname = `/${name}`;
    return url.toString();
  },

  /**
   * Builds the address of the database the tests connect to when they create theirs.
   *
   * The server is the one the programs use, and the database is `postgres`,
   * which every PostgreSQL server has.
   */
  server(): string {
    const setting = (name: string, trimmed = true): string => {
      const value = process.env[name] ?? "";
      if (value.trim() === "") {
        throw new Error(`${name} is not set. The tests make their databases on that server.`);
      }
      return trimmed ? value.trim() : value;
    };
    const host = setting("ACCESS_DESK_DATABASE_HOST");
    const user = encodeURIComponent(setting("ACCESS_DESK_DATABASE_USER"));
    const password = encodeURIComponent(setting("ACCESS_DESK_DATABASE_PASSWORD", false));
    const address = isIP(host) === 6 ? `[${host}]` : host;
    const port = setting("ACCESS_DESK_DATABASE_PORT");
    return `postgresql://${user}:${password}@${address}:${port}/postgres`;
  },
};
