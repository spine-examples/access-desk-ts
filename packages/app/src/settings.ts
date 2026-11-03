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

import { createPrivateKey, createSecretKey, type KeyObject } from "node:crypto";
import { BlockList, isIP } from "node:net";

/** The addresses that are reached only from the same machine. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * Stands in for a session key that could not be read, as an empty text does
 * for a missing setting, so that one error names every problem.
 *
 * Nothing is signed with it: settings with a problem are refused as a whole.
 */
const UNREADABLE_KEY = createSecretKey(new Uint8Array(1));

/** Where an organization's identifier goes in the address of its database. */
const ORGANIZATION = "{organization}";

/** What the name of a database may be made of. */
const DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The longest name of a database, in characters. PostgreSQL cuts a longer
 * name short, so two databases could end up with one name.
 */
const DATABASE_NAME_LENGTH = 63;

/** Where a program listens. */
export interface Listening {
  /** The address to listen on. */
  readonly host: string;
  /** The port to listen on. */
  readonly port: number;
}

/** How Access Desk is registered with an identity provider. */
export interface ProviderSettings {
  /** The client identifier the provider gave the application. */
  readonly clientId: string;
  /** The client secret the provider gave the application. */
  readonly clientSecret: string;
}

/** The PostgreSQL database a program keeps its data in. */
export interface StorageSettings {
  /** The address of the database, with the account to sign in to it. */
  readonly url: string;
}

/** The PostgreSQL databases the application server keeps its data in. */
export interface ServerStorageSettings {
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

/** How the application server is set up. */
export interface ServerSettings {
  /** Where the application server listens. */
  readonly listening: Listening;
  /**
   * The organizations the application server keeps, by their identifiers.
   */
  // TODO:02-11-2026:mykyta.pimonov: Register organizations while the server
  //  runs, instead of listing them here, once Spine keeps the tenants given to
  //  its index across restarts.
  readonly organizations: readonly string[];
  /** Where the application server keeps its data. */
  readonly storage: ServerStorageSettings;
}

/** How the gateway is set up. */
export interface GatewaySettings {
  /** Where the gateway listens. */
  readonly listening: Listening;
  /** The address of the application server. */
  readonly serverUrl: string;
  /**
   * The HTTPS address people open the application at. Identity providers
   * send people back there, and only that page may call the gateway.
   */
  readonly webUrl: string;
  /** How Access Desk is registered with Google, which people sign in through. */
  readonly google: ProviderSettings;
  /** Where the gateway keeps the subscriptions people hold and the sessions they ended. */
  readonly storage: StorageSettings;
  /**
   * The private key the gateway signs sessions with.
   *
   * A session stays good across a restart of the gateway while the key stays
   * the same.
   */
  readonly sessionKey: KeyObject;
}

/**
 * Reads settings from the environment and collects every problem, so one
 * error can report them all.
 */
class Reading {
  /** The environment the settings are read from. */
  readonly #environment: NodeJS.ProcessEnv;
  /** The problems found so far, one sentence each. */
  readonly #problems: string[] = [];
  /** The PostgreSQL server the programs keep their data on, once read. */
  #databaseServer:
    | {
        readonly host: string;
        readonly port: number;
        readonly user: string;
        readonly password: string;
      }
    | undefined;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }

  /** Reads a setting's value, or an empty string when it is not set. */
  #value(name: string): string {
    return this.#environment[name]?.trim() ?? "";
  }

  /** Reads a setting that must be set. */
  text(name: string): string {
    const value = this.#value(name);
    if (value === "") {
      this.#problems.push(`${name} is not set.`);
    }
    return value;
  }

  /**
   * Reads a secret that must be set, taken exactly as it is written, with any
   * spaces around it.
   */
  secret(name: string): string {
    const value = this.#environment[name] ?? "";
    if (value === "") {
      this.#problems.push(`${name} is not set.`);
    }
    return value;
  }

  /** Reads a port that must be set. */
  port(name: string): number {
    const text = this.text(name);
    const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (text !== "" && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      this.#problems.push(`${name} must be a port between 1 and 65535, and is "${text}".`);
    }
    return port;
  }

  /** Reads where a program listens, from its `_HOST` and `_PORT` settings. */
  listening(prefix: string): Listening {
    return { host: this.text(`${prefix}_HOST`), port: this.port(`${prefix}_PORT`) };
  }

  /** Reads an identity provider, from its `_CLIENT_ID` and `_CLIENT_SECRET` settings. */
  provider(prefix: string): ProviderSettings {
    return {
      clientId: this.text(`${prefix}_CLIENT_ID`),
      clientSecret: this.text(`${prefix}_CLIENT_SECRET`),
    };
  }

  /**
   * Reads the database a program keeps its data in.
   *
   * @param database The setting that names the program's database on the
   *   PostgreSQL server.
   */
  storage(database: string): StorageSettings {
    return { url: this.#databaseUrl(this.#databaseName(database)) };
  }

  /**
   * Reads the databases the application server keeps its data in.
   *
   * `ACCESS_DESK_SERVER_DATABASE` names the shared database, and
   * `ACCESS_DESK_ORGANIZATION_DATABASE` names each organization's database,
   * with `{organization}` where its identifier goes.
   */
  serverStorage(): ServerStorageSettings {
    const name = "ACCESS_DESK_ORGANIZATION_DATABASE";
    const database = this.text(name);
    const fixed = database.replaceAll(ORGANIZATION, "");
    if (database !== "" && !(database.includes(ORGANIZATION) && DATABASE_NAME.test(fixed))) {
      this.#problems.push(
        `${name} must name a database of letters, digits, "-", and "_", ` +
          `with ${ORGANIZATION} where the organization goes, and is "${database}".`,
      );
    } else if (database !== "" && !this.#short(`${fixed}x`)) {
      this.#problems.push(
        `${name} leaves no room for the organization in a name of at most ` +
          `${DATABASE_NAME_LENGTH.toString()} characters, and is "${database}".`,
      );
    }
    return {
      url: this.#databaseUrl(this.#databaseName("ACCESS_DESK_SERVER_DATABASE")),
      organizationDatabase: database,
    };
  }

  /** Reads organizations that must be listed, each once, separated by commas. */
  organizations(name: string): string[] {
    const text = this.text(name);
    const organizations = text.split(",").map((organization) => organization.trim());
    const valid =
      organizations.every((organization) => DATABASE_NAME.test(organization)) &&
      new Set(organizations).size === organizations.length;
    if (text !== "" && !valid) {
      this.#problems.push(
        `${name} must list organizations, each once, separated by commas, each of ` +
          `letters, digits, "-", and "_", and is "${text}".`,
      );
    }
    return text === "" || !valid ? [] : organizations;
  }

  /** Reads the name of a database on the PostgreSQL server, which must be set. */
  #databaseName(name: string): string {
    const text = this.text(name);
    if (text !== "" && !DATABASE_NAME.test(text)) {
      this.#problems.push(
        `${name} must name a database of letters, digits, "-", and "_", and is "${text}".`,
      );
    } else if (!this.#short(text)) {
      this.#problems.push(
        `${name} must name a database of at most ${DATABASE_NAME_LENGTH.toString()} characters, ` +
          `and is "${text}".`,
      );
    }
    return text;
  }

  /** Whether a database's name is short enough for PostgreSQL to keep it whole. */
  #short(database: string): boolean {
    return Buffer.byteLength(database, "utf8") <= DATABASE_NAME_LENGTH;
  }

  /**
   * Builds the address of a database on the PostgreSQL server, from
   * `ACCESS_DESK_DATABASE_HOST`, `_PORT`, `_USER`, and `_PASSWORD`.
   */
  #databaseUrl(database: string): string {
    this.#databaseServer ??= {
      host: this.text("ACCESS_DESK_DATABASE_HOST"),
      port: this.port("ACCESS_DESK_DATABASE_PORT"),
      user: this.text("ACCESS_DESK_DATABASE_USER"),
      password: this.secret("ACCESS_DESK_DATABASE_PASSWORD"),
    };
    const { host, port, user, password } = this.#databaseServer;
    const address = isIP(host) === 6 ? `[${host}]` : host;
    return (
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${address}:${port.toString()}/${encodeURIComponent(database)}`
    );
  }

  /** Reads a P-256 private key that must be set, written in base64 as PKCS #8. */
  signingKey(name: string): KeyObject {
    const text = this.text(name);
    if (text === "") {
      return UNREADABLE_KEY;
    }
    try {
      const key = createPrivateKey({
        key: Buffer.from(text, "base64"),
        format: "der",
        type: "pkcs8",
      });
      if (key.asymmetricKeyDetails?.namedCurve === "prime256v1") {
        return key;
      }
    } catch {
      // Reported below, like a key of another kind.
    }
    this.#problems.push(`${name} must be a P-256 private key, written in base64 as PKCS #8.`);
    return UNREADABLE_KEY;
  }

  /** Returns the settings, or throws one error that lists every problem. */
  done<Settings>(settings: Settings): Settings {
    if (this.#problems.length > 0) {
      throw new Error(
        [
          "Access Desk is not set up. Copy `.env.example` to `.env` in the repository and fill it in.",
          ...this.#problems.map((problem) => `- ${problem}`),
        ].join("\n"),
      );
    }
    return settings;
  }
}

/** The settings of the application server and of the gateway. */
export const Settings = {
  /**
   * Reads the application server's settings from the environment.
   *
   * @param environment The environment the program runs in.
   * @returns The settings of the application server.
   */
  ofServer(environment: NodeJS.ProcessEnv): ServerSettings {
    const reading = new Reading(environment);
    return reading.done({
      listening: reading.listening("ACCESS_DESK_SERVER"),
      organizations: reading.organizations("ACCESS_DESK_ORGANIZATIONS"),
      storage: reading.serverStorage(),
    });
  },

  /**
   * Builds the address of an organization's database.
   *
   * The organization's identifier goes where `ACCESS_DESK_ORGANIZATION_DATABASE`
   * has `{organization}`.
   *
   * @param storage Where the application server keeps its data.
   * @param organization The organization's identifier.
   * @returns The address of the database, with the account to sign in to it.
   * @throws Error when the identifier is not of letters, digits, "-", and "_",
   *   when the name it makes is too long for PostgreSQL, or when it makes the
   *   name of the shared database.
   */
  organizationDatabase(storage: ServerStorageSettings, organization: string): string {
    if (!DATABASE_NAME.test(organization)) {
      throw new Error(
        `An organization's identifier must be of letters, digits, "-", and "_", ` +
          `and is "${organization}".`,
      );
    }
    const database = storage.organizationDatabase.replaceAll(ORGANIZATION, organization);
    if (Buffer.byteLength(database, "utf8") > DATABASE_NAME_LENGTH) {
      throw new Error(
        `The database of organization ${organization}, "${database}", is longer than ` +
          `${DATABASE_NAME_LENGTH.toString()} characters.`,
      );
    }
    const url = new URL(storage.url);
    if (decodeURIComponent(url.pathname.slice(1)) === database) {
      throw new Error(
        `The database of organization ${organization}, "${database}", is the shared one.`,
      );
    }
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  },

  /**
   * Reads the gateway's settings from the environment.
   *
   * @param environment The environment the program runs in.
   * @returns The settings of the gateway.
   */
  ofGateway(environment: NodeJS.ProcessEnv): GatewaySettings {
    const reading = new Reading(environment);
    const listening = reading.listening("ACCESS_DESK_GATEWAY");
    const server = reading.listening("ACCESS_DESK_SERVER");
    const web = reading.listening("ACCESS_DESK_WEB");
    return reading.done({
      listening,
      serverUrl: `http://${server.host}:${server.port.toString()}`,
      webUrl: `https://${web.host}:${web.port.toString()}/`,
      google: reading.provider("GOOGLE"),
      storage: reading.storage("ACCESS_DESK_GATEWAY_DATABASE"),
      sessionKey: reading.signingKey("ACCESS_DESK_SESSION_KEY"),
    });
  },

  /**
   * Whether an address is reached only from the same machine.
   *
   * @param host The address a program listens on.
   * @returns `true` for `localhost` and for a loopback address, such as
   *   `127.0.0.1` or `::1`.
   */
  onlyThisMachine(host: string): boolean {
    const address = host.trim().toLowerCase();
    const version = isIP(address);
    return (
      address === "localhost" ||
      (version !== 0 && LOOPBACK.check(address, version === 6 ? "ipv6" : "ipv4"))
    );
  },
};
