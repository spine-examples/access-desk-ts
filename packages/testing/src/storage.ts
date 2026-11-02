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
import { InMemoryStorageFactory, type StorageFactory } from "@spine-event-engine/storage";
import {
  PostgresStorageFactory,
  type PostgresStorageFactoryBuilder,
} from "@spine-event-engine/storage-postgres";
import { Client } from "pg";

/**
 * The storage a test keeps its contexts' data in, and deletes when it ends.
 *
 * `ACCESS_DESK_TEST_STORAGE` names where: `memory`, or `postgresql`.
 * On PostgreSQL, each storage gets separate new databases.
 */
export interface TestStorage {
  /** The address of the storage's database, when it has just one. */
  readonly url: string | undefined;
  /**
   * Opens the storage, as a program does when it starts.
   *
   * PostgreSQL keeps the data across restarts; memory does not.
   */
  open(): Promise<StorageFactory>;
  /** Closes the storage and deletes its data. */
  drop(): Promise<void>;
}

/** Keeps the application's data in its memory. */
export interface MemoryStorageSettings {
  readonly kind: "memory";
}

/** Keeps the application's data in a PostgreSQL database. */
export interface PostgresStorageSettings {
  readonly kind: "postgresql";
  /** The address of the database. */
  readonly url: string;
}

/** Where the application keeps its data, as its settings name it. */
export type StorageSettings = MemoryStorageSettings | PostgresStorageSettings;

/** Empty PostgreSQL databases, for a test that opens storage over them itself. */
export interface TestDatabases {
  /** The address of each database. */
  readonly urls: readonly string[];
  /** Deletes the databases. Close the storage over them first. */
  drop(): Promise<void>;
}

/**
 * Creates storage for the tests, in memory or in new PostgreSQL databases, as
 * `ACCESS_DESK_TEST_STORAGE` says.
 */
export const TestStorages = {
  /**
   * Reads where this run keeps its data.
   */
  profile(): "memory" | "postgresql" {
    const profile = process.env.ACCESS_DESK_TEST_STORAGE;
    if (profile === "memory" || profile === "postgresql") {
      return profile;
    }
    throw new Error(
      `ACCESS_DESK_TEST_STORAGE must be "memory" or "postgresql", and is "${profile ?? ""}".`,
    );
  },

  /**
   * Returns the application settings that point at the storage.
   *
   * @param storage Storage from {@link TestStorages.singleTenant}.
   */
  settingsOf(storage: TestStorage): StorageSettings {
    if (TestStorages.profile() === "memory") {
      return { kind: "memory" };
    }
    if (storage.url === undefined) {
      throw new Error("Only single-tenant storage is named by one database.");
    }
    return { kind: "postgresql", url: storage.url };
  },

  /**
   * Whether the tests keep their data in PostgreSQL, so it outlasts a restart
   * of a context.
   */
  durable(): boolean {
    return TestStorages.profile() === "postgresql";
  },

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
    if (TestStorages.profile() === "memory") {
      return new InMemoryTestStorage();
    }
    const [url = ""] = await Databases.create(1);
    return new PostgresTestStorage(registry, [url], url, (builder) => builder.setOptions({ url }));
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
    if (TestStorages.profile() === "memory") {
      return new InMemoryTestStorage();
    }
    const urls = await Databases.create(tenants.length + 1);
    const [shared = "", ...tenantUrls] = urls;
    return new PostgresTestStorage(registry, urls, undefined, (builder) =>
      builder.setOptions({ url: shared }).setTenantOptions(
        tenants.map((tenantId, index) => ({
          tenantId,
          options: { url: tenantUrls[index] ?? "" },
        })),
      ),
    );
  },
};

/** Storage in memory. */
class InMemoryTestStorage implements TestStorage {
  readonly url = undefined;
  readonly #factory = new InMemoryStorageFactory();

  open(): Promise<StorageFactory> {
    return Promise.resolve(this.#factory);
  }

  drop(): Promise<void> {
    return this.#factory.close();
  }
}

/** Storage in PostgreSQL databases made for one test. */
class PostgresTestStorage implements TestStorage {
  readonly url: string | undefined;
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
    url: string | undefined,
    configure: (builder: PostgresStorageFactoryBuilder) => PostgresStorageFactoryBuilder,
  ) {
    this.#registry = registry;
    this.#databases = databases;
    this.url = url;
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
      const found = await client.query<{ dbname: string }>(
        "SELECT dbname FROM pg_database WHERE starts_with(dbname, $1)",
        [prefix],
      );
      for (const { dbname } of found.rows) {
        await client.query(`DROP DATABASE IF EXISTS "${dbname}" WITH (FORCE)`);
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
        throw new Error(
          `${name} is not set. The tests on PostgreSQL make their databases on that server.`,
        );
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
