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

/** The page's settings. */
interface Settings {
  /** The address the page calls the application at. */
  readonly apiUrl: string;
}

/** The settings, once the page has read them. */
let settings: Settings | undefined;

/** The settings the page runs with. */
export const Config = {
  /**
   * Reads the settings from the page's own server, before the page starts.
   *
   * @throws Error when the server gives no settings, or no address of the application.
   */
  async load(): Promise<void> {
    const response = await fetch("/config.json", { cache: "no-cache" });
    const read = response.ok ? ((await response.json()) as Partial<Settings>) : {};
    if (typeof read.apiUrl !== "string" || read.apiUrl === "") {
      throw new Error("The page's server gives no address of the application.");
    }
    settings = { apiUrl: new URL(read.apiUrl).origin };
  },

  /** The address the page calls the application at. */
  get apiUrl(): string {
    if (settings === undefined) {
      throw new Error("The page reads its settings before they are loaded.");
    }
    return settings.apiUrl;
  },
};
