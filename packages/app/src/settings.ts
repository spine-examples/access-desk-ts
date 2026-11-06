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

/** The PostgreSQL server the programs keep their data on, and the account they sign in with. */
export interface DatabaseServer {
  /** The address of the server. */
  readonly host: string;
  /** The port of the server. */
  readonly port: number;
  /** The account the programs sign in with. */
  readonly user: string;
  /** The password of that account, exactly as it is written. */
  readonly password: string;
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
  /** The PostgreSQL server the application server keeps its data on. */
  readonly database: DatabaseServer;
  /**
   * The key the application server checks, with the gateway, who makes each
   * request the gateway passes on. A token derived from it proves the
   * server's calls to itself. The server refuses a call this key does not
   * prove.
   */
  readonly forwardingProofKey: Buffer;
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
  /**
   * The PostgreSQL server the gateway keeps the subscriptions people hold and
   * the sessions they ended on.
   */
  readonly database: DatabaseServer;
  /**
   * The private key the gateway signs sessions with.
   *
   * A session stays good across a restart of the gateway while the key stays
   * the same.
   */
  readonly sessionKey: KeyObject;
  /**
   * The key the gateway signs, for the application server, who makes each
   * request it passes on, and each call it makes itself.
   */
  readonly forwardingProofKey: Buffer;
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
   * Reads organizations that must be listed, each once, separated by commas.
   */
  organizations(name: string): string[] {
    const text = this.text(name);
    const organizations = text.split(",").map((organization) => organization.trim());
    const valid =
      organizations.every((organization) => organization !== "") &&
      new Set(organizations).size === organizations.length;
    if (text !== "" && !valid) {
      this.#problems.push(
        `${name} must list organizations, each once, separated by commas, and is "${text}".`,
      );
    }
    return text === "" || !valid ? [] : organizations;
  }

  /**
   * Reads the PostgreSQL server, from `ACCESS_DESK_DATABASE_HOST`, `_PORT`,
   * `_USER`, and `_PASSWORD`.
   */
  databaseServer(): DatabaseServer {
    return {
      host: this.text("ACCESS_DESK_DATABASE_HOST"),
      port: this.port("ACCESS_DESK_DATABASE_PORT"),
      user: this.text("ACCESS_DESK_DATABASE_USER"),
      password: this.secret("ACCESS_DESK_DATABASE_PASSWORD"),
    };
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

  /** Reads a key of at least 32 bytes that must be set, written in base64. */
  sharedKey(name: string): Buffer {
    const text = this.secret(name);
    const key = Buffer.from(text, "base64");
    if (text !== "" && key.length < 32) {
      this.#problems.push(`${name} must be a key of at least 32 bytes, written in base64.`);
    }
    return key;
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
      database: reading.databaseServer(),
      forwardingProofKey: reading.sharedKey("ACCESS_DESK_FORWARDING_PROOF_KEY"),
    });
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
      database: reading.databaseServer(),
      sessionKey: reading.signingKey("ACCESS_DESK_SESSION_KEY"),
      forwardingProofKey: reading.sharedKey("ACCESS_DESK_FORWARDING_PROOF_KEY"),
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
