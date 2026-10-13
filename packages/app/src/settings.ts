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

/** The addresses that are reached only from the same machine. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

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

/** How the application server is set up. */
export interface ServerSettings {
  /** Where the application server listens. */
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
  /** GitHub as an identity provider, when it is set up. */
  readonly github: ProviderSettings | undefined;
  /** Google as an identity provider, when it is set up. */
  readonly google: ProviderSettings | undefined;
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

  /** A setting's value, or an empty string when it is not set. */
  #value(name: string): string {
    return this.#environment[name]?.trim() ?? "";
  }

  /** A setting that must be set. */
  text(name: string): string {
    const value = this.#value(name);
    if (value === "") {
      this.#problems.push(`${name} is not set.`);
    }
    return value;
  }

  /** A port that must be set. */
  port(name: string): number {
    const text = this.text(name);
    const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (text !== "" && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      this.#problems.push(`${name} must be a port between 1 and 65535, and is "${text}".`);
    }
    return port;
  }

  /** Where a program listens, from its `_HOST` and `_PORT` settings. */
  listening(prefix: string): Listening {
    return { host: this.text(`${prefix}_HOST`), port: this.port(`${prefix}_PORT`) };
  }

  /** An identity provider. Both of its settings must be set, or neither. */
  provider(prefix: string): ProviderSettings | undefined {
    const clientId = this.#value(`${prefix}_CLIENT_ID`);
    const clientSecret = this.#value(`${prefix}_CLIENT_SECRET`);
    if (clientId === "" && clientSecret === "") {
      return undefined;
    }
    if (clientId === "" || clientSecret === "") {
      this.#problems.push(
        `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be set together, or neither.`,
      );
      return undefined;
    }
    return { clientId, clientSecret };
  }

  /** The identity providers people sign in through. At least one must be set up. */
  providers(): Pick<GatewaySettings, "github" | "google"> {
    const before = this.#problems.length;
    const github = this.provider("GITHUB");
    const google = this.provider("GOOGLE");
    if (github === undefined && google === undefined && this.#problems.length === before) {
      this.#problems.push(
        "No identity provider is set up. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, " +
          "or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or both pairs.",
      );
    }
    return { github, google };
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
   * The application server's settings, read from the environment.
   *
   * @param environment The environment the program runs in.
   * @returns The settings of the application server.
   */
  ofServer(environment: NodeJS.ProcessEnv): ServerSettings {
    const reading = new Reading(environment);
    return reading.done({ listening: reading.listening("ACCESS_DESK_SERVER") });
  },

  /**
   * The gateway's settings, read from the environment.
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
      ...reading.providers(),
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
