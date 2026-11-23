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

import { BlockList, isIP } from "node:net";
import { SessionKey } from "./gateway/session-key.js";

/** The addresses that are reached only from the same machine. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** The addresses that stand for every address of the machine a program listens on. */
const EVERY_ADDRESS = new BlockList();
EVERY_ADDRESS.addAddress("0.0.0.0", "ipv4");
EVERY_ADDRESS.addAddress("::", "ipv6");

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
  /** The address of the delivery server, which keeps the Inbox the workers share. */
  readonly deliveryUrl: string;
  /** The PostgreSQL server the application server keeps its data on. */
  readonly database: DatabaseServer;
}

/** The setup of the delivery server. */
export interface DeliverySettings {
  /** The address the delivery server listens on. */
  readonly listening: Listening;
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
  readonly sessionKey: SessionKey;
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

  /**
   * Reads the key the gateway signs sessions with, which must be set: a P-256
   * private key, written in base64 as PKCS #8.
   *
   * @returns The key, or `undefined` when there is a problem with it.
   */
  sessionKey(name: string): SessionKey | undefined {
    const text = this.text(name);
    const key = text === "" ? undefined : SessionKey.fromBase64(text);
    if (text !== "" && key === undefined) {
      this.#problems.push(`${name} must be a P-256 private key, written in base64 as PKCS #8.`);
    }
    return key;
  }

  /**
   * Returns the settings, or throws one error that lists every problem.
   *
   * A value that could not be read is `undefined` only alongside a problem
   * that names it, so settings without problems have every value.
   */
  done<Settings>(settings: Unread<Settings>): Settings {
    if (this.#problems.length > 0) {
      throw new Error(
        [
          "Access Desk is not set up. Copy `.env.example` to `.env` in the repository and fill it in.",
          ...this.#problems.map((problem) => `- ${problem}`),
        ].join("\n"),
      );
    }
    return settings as Settings;
  }
}

/** Settings as they are read, where a value that could not be read is `undefined`. */
type Unread<Settings> = { readonly [Name in keyof Settings]: Settings[Name] | undefined };

/** The settings of the application server, the delivery server, and the gateway. */
export const Settings = {
  /**
   * Reads the application server's settings from the environment.
   *
   * @param environment The environment the program runs in.
   * @returns The settings of the application server.
   */
  ofServer(environment: NodeJS.ProcessEnv): ServerSettings {
    const reading = new Reading(environment);
    const listening = reading.listening("ACCESS_DESK_SERVER");
    const delivery = reading.listening("ACCESS_DESK_DELIVERY");
    return reading.done({
      listening,
      deliveryUrl: Settings.urlOf(delivery),
      database: reading.databaseServer(),
    });
  },

  /**
   * Reads the delivery server's settings from the environment.
   *
   * @param environment The environment the program runs in.
   * @returns The settings of the delivery server.
   */
  ofDelivery(environment: NodeJS.ProcessEnv): DeliverySettings {
    const reading = new Reading(environment);
    return reading.done({ listening: reading.listening("ACCESS_DESK_DELIVERY") });
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
      serverUrl: Settings.urlOf(server),
      webUrl: `https://${web.host}:${web.port.toString()}/`,
      google: reading.provider("GOOGLE"),
      database: reading.databaseServer(),
      sessionKey: reading.sessionKey("ACCESS_DESK_SESSION_KEY"),
    });
  },

  /**
   * Builds the HTTP address at which a program reaches another one where it
   * listens.
   *
   * A program that listens on every address of its machine, on `0.0.0.0` or
   * `::`, is reached at its machine's loopback address, as the address it
   * listens on names no machine to connect to. An IPv6 address is put in
   * brackets.
   *
   * @param listening Where the program listens.
   * @returns The address to reach it at, such as `http://127.0.0.1:8090`.
   */
  urlOf(listening: Listening): string {
    const host = listening.host.trim().toLowerCase();
    const version = isIP(host);
    const family = version === 6 ? "ipv6" : "ipv4";
    const reached =
      version !== 0 && EVERY_ADDRESS.check(host, family)
        ? version === 6
          ? "::1"
          : "127.0.0.1"
        : listening.host.trim();
    const named = isIP(reached) === 6 ? `[${reached}]` : reached;
    return `http://${named}:${listening.port.toString()}`;
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
