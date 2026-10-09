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

/** Where a program listens. */
export interface Listening {
  /** The address to listen on, such as `127.0.0.1`. */
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
  /**
   * The address at which the gateway reaches the application server, which is
   * where that server listens.
   */
  readonly serverUrl: string;
  /**
   * The HTTPS address people open the application at, which is where the web
   * client listens. An identity provider sends a person back there, and only
   * that page may call the gateway.
   */
  readonly webUrl: string;
  /** GitHub as an identity provider, when it is set up. */
  readonly github: ProviderSettings | undefined;
  /** Google as an identity provider, when it is set up. */
  readonly google: ProviderSettings | undefined;
}

/**
 * Reads settings from the environment and remembers everything that is wrong
 * with them, so one message can tell it all.
 */
class Reading {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #problems: string[] = [];

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
  }

  /** A setting as it is written, or nothing when it is not there. */
  #value(name: string): string {
    return this.#environment[name]?.trim() ?? "";
  }

  /** A setting that must be there. */
  text(name: string): string {
    const value = this.#value(name);
    if (value === "") {
      this.#problems.push(`${name} is not set.`);
    }
    return value;
  }

  /** A port that must be there. */
  port(name: string): number {
    const text = this.text(name);
    const port = Number(text);
    if (text !== "" && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      this.#problems.push(`${name} must be a port between 1 and 65535, and is "${text}".`);
    }
    return port;
  }

  /** Where a program listens, by the settings that name its host and port. */
  listening(prefix: string): Listening {
    return { host: this.text(`${prefix}_HOST`), port: this.port(`${prefix}_PORT`) };
  }

  /**
   * An identity provider, which is set up by both of its settings or by
   * neither.
   */
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

  /**
   * Gives back the settings that were read, or says everything that is wrong
   * with them.
   */
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

/**
 * How the application server is set up, as the environment says.
 *
 * @param environment The environment the program runs in.
 * @returns The settings of the application server.
 */
export function serverSettingsOf(environment: NodeJS.ProcessEnv): ServerSettings {
  const reading = new Reading(environment);
  return reading.done({ listening: reading.listening("ACCESS_DESK_SERVER") });
}

/**
 * How the gateway is set up, as the environment says.
 *
 * @param environment The environment the program runs in.
 * @returns The settings of the gateway.
 */
export function gatewaySettingsOf(environment: NodeJS.ProcessEnv): GatewaySettings {
  const reading = new Reading(environment);
  const listening = reading.listening("ACCESS_DESK_GATEWAY");
  const server = reading.listening("ACCESS_DESK_SERVER");
  const web = reading.listening("ACCESS_DESK_WEB");
  return reading.done({
    listening,
    serverUrl: `http://${server.host}:${server.port.toString()}`,
    webUrl: `https://${web.host}:${web.port.toString()}/`,
    github: reading.provider("GITHUB"),
    google: reading.provider("GOOGLE"),
  });
}
