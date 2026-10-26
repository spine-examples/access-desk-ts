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
 * `ACCESS_DESK_TEST_STORAGE` names where: `memory`, or `postgresql`. On
 * PostgreSQL, every storage gets databases of its own, made on the server the
 * programs keep their data on, from the database `ACCESS_DESK_TEST_DATABASE`
 * names.
 *
 * The tests of every package share it.
 */
export interface TestStorage {
  /**
   * The address of the database the storage keeps its data in.
   *
   * Nothing in memory, and nothing for storage that keeps each tenant in a
   * database of its own.
   */
  readonly url: string | undefined;
  /**
   * Opens the storage over its data.
   *
   * Every call opens it anew over the same data, as a program does when it
   * restarts. In memory, every call gives the same storage, which is how
   * memory outlasts a context.
   */
  open(): Promise<StorageFactory>;
  /** Closes everything opened, and deletes the data. */
  drop(): Promise<void>;
}

/** Where a program keeps its data, as the application's settings say it. */
export type StorageSettingsOfTest =
  { readonly kind: "memory" } | { readonly kind: "postgresql"; readonly url: string };

/** Throwaway PostgreSQL databases, for a test that opens storage as the application does. */
export interface TestDatabases {
  /** The address of each database. */
  readonly urls: readonly string[];
  /** Deletes the databases. Whoever opened storage over them closes it first. */
  drop(): Promise<void>;
}

/** Makes the storage of the tests. */
export const TestStorages = {
  /**
   * Where the tests keep their data in this run.
   *
   * `pnpm run test` and `pnpm run test:postgresql` name it. A run that names
   * none, such as one from an editor, takes it from `.env`.
   */
  profile(): "memory" | "postgresql" {
    const profile = process.env.ACCESS_DESK_TEST_STORAGE;
    if (profile === "memory" || profile === "postgresql") {
      return profile;
    }
    throw new Error(
      `ACCESS_DESK_TEST_STORAGE must be "memory" or "postgresql", and is "${profile ?? ""}". ` +
        "Set it in .env, or run `pnpm run test` or `pnpm run test:postgresql`.",
    );
  },

  /**
   * The settings that name single-tenant storage, as the application reads them.
   *
   * @param storage Storage made by {@link TestStorages.singleTenant}.
   */
  settingsOf(storage: TestStorage): StorageSettingsOfTest {
    if (TestStorages.profile() === "memory") {
      return { kind: "memory" };
    }
    if (storage.url === undefined) {
      throw new Error("Only single-tenant storage is named by one database.");
    }
    return { kind: "postgresql", url: storage.url };
  },

  /**
   * New, empty PostgreSQL databases, for a test that opens storage over them
   * as the application does.
   *
   * @param count How many to make.
   */
  async databases(count: number): Promise<TestDatabases> {
    const urls = await Databases.create(count);
    return { urls, drop: () => Databases.drop(urls) };
  },

  /**
   * Storage for a single-tenant context.
   *
   * @param registry Every type the context's messages use.
   */
  async singleTenant(registry: TypeRegistryLookup): Promise<TestStorage> {
    if (TestStorages.profile() === "memory") {
      return new InMemoryTestStorage();
    }
    const [url = ""] = await Databases.create(1);
    return new PostgresTestStorage(registry, [url], url, (builder) => builder.setOptions({ url }));
  },

  /**
   * Storage for a multitenant context, which keeps each tenant apart.
   *
   * @param registry Every type the context's messages use.
   * @param tenants Every tenant the context serves. PostgreSQL keeps each in
   *   a database of its own, and must know them all from the start.
   */
  async multitenant(
    registry: TypeRegistryLookup,
    tenants: readonly TenantId[],
  ): Promise<TestStorage> {
    if (TestStorages.profile() === "memory") {
      return new InMemoryTestStorage();
    }
    const urls = await Databases.create(tenants.length);
    return new PostgresTestStorage(registry, urls, undefined, (builder) =>
      builder.setTenantOptions(
        tenants.map((tenantId, index) => ({ tenantId, options: { url: urls[index] ?? "" } })),
      ),
    );
  },
};

/** Storage in memory, which lives as long as the test. */
class InMemoryTestStorage implements TestStorage {
  readonly url = undefined;
  readonly #factory = new InMemoryStorageFactory();

  open(): Promise<StorageFactory> {
    return Promise.resolve(this.#factory);
  }

  drop(): Promise<void> {
    this.#factory.close();
    return Promise.resolve();
  }
}

/** Storage in throwaway PostgreSQL databases. */
class PostgresTestStorage implements TestStorage {
  readonly url: string | undefined;
  /** Every type the context's messages use. */
  readonly #registry: TypeRegistryLookup;
  /** The databases the storage keeps its data in. */
  readonly #databases: readonly string[];
  /** Points a new storage at the databases. */
  readonly #configure: (builder: PostgresStorageFactoryBuilder) => PostgresStorageFactoryBuilder;
  /** Every storage opened so far. */
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
      factory.close();
    }
    await Databases.drop(this.#databases);
  }
}

/** The throwaway databases of the tests on PostgreSQL. */
const Databases = {
  /**
   * Makes new, empty databases.
   *
   * @param count How many to make.
   * @returns The address of each.
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
   * Deletes databases, even while something is still connected to them.
   *
   * @param urls The address of each.
   */
  async drop(urls: readonly string[]): Promise<void> {
    await Databases.administer(async (client) => {
      for (const url of urls) {
        const name = new URL(url).pathname.slice(1);
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    });
  },

  /** Runs statements against the server the tests make their databases in. */
  async administer(statements: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: Databases.server() });
    await client.connect();
    try {
      await statements(client);
    } finally {
      await client.end();
    }
  },

  /** The address of a database of the test server. */
  urlOf(name: string): string {
    const url = new URL(Databases.server());
    url.pathname = `/${name}`;
    return url.toString();
  },

  /**
   * The address of the database the tests make their databases from: the one
   * `ACCESS_DESK_TEST_DATABASE` names, on the server of
   * `ACCESS_DESK_DATABASE_HOST`, `_PORT`, `_USER`, and `_PASSWORD`, as the
   * programs reach it.
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
    // The password is taken as it is written, as the programs take it.
    const password = encodeURIComponent(setting("ACCESS_DESK_DATABASE_PASSWORD", false));
    const address = isIP(host) === 6 ? `[${host}]` : host;
    const port = setting("ACCESS_DESK_DATABASE_PORT");
    const database = encodeURIComponent(setting("ACCESS_DESK_TEST_DATABASE"));
    return `postgresql://${user}:${password}@${address}:${port}/${database}`;
  },
};
