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

/** Closes resources in turn, each even when another fails. */
export const Closing = {
  /**
   * Closes each in turn, even when an earlier one fails to close.
   *
   * @param resources The resources to close, first to last.
   * @throws AggregateError if any resource failed to close.
   */
  async inOrder(...resources: { close(): unknown }[]): Promise<void> {
    const failures: unknown[] = [];
    for (const resource of resources) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Not everything closed.");
    }
  },
};
