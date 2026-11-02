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

import type { TenantId } from "@spine-event-engine/proto";
import { EnvironmentType, ServerEnvironment } from "@spine-event-engine/server";
import { ServerTests } from "@spine-event-engine/server/testing";
import type { StorageFactory } from "@spine-event-engine/storage";

/**
 * The server environment a test's contexts run in.
 *
 * Spine sets up one environment per process, with the storage every context
 * keeps its data in. So a test sets it up afresh over separate storage before it
 * builds a context, and resets it once the contexts are closed.
 */
export const TestEnvironment = {
  /**
   * Sets up the environment over the storage, and keeps the tenants.
   *
   * It resets the environment an earlier test left first.
   *
   * @param storage The storage the test's contexts keep their data in.
   * @param tenants The tenants the test works in, for a multitenant context.
   */
  async start(storage: StorageFactory, tenants: readonly TenantId[] = []): Promise<void> {
    await ServerTests.resetEnvironment();
    ServerEnvironment.when(EnvironmentType.Local).use({ storageFactory: storage });
    const environment = ServerEnvironment.instance();
    await environment.completeSetup();
    for (const tenant of tenants) {
      await environment.tenantIndex.keep(tenant);
    }
  },

  /**
   * Closes the environment, so the next test can set up a new one.
   */
  reset(): Promise<void> {
    return ServerTests.resetEnvironment();
  },
};
