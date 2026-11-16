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
import {
  EnvironmentType,
  PersistentTenantIndex,
  ServerEnvironment,
} from "@spine-event-engine/server";
import { ServerTests } from "@spine-event-engine/server/testing";
import { StorageGroup, type StorageFactory } from "@spine-event-engine/storage";

/** The storage group the register of tenants is kept in. */
const TENANTS = new StorageGroup("tenants");

/** The register of the tenants of the environment set up last, while it is open. */
let registered: PersistentTenantIndex | undefined;

/**
 * The server environment a test's contexts run in.
 *
 * Spine sets up one environment per process, with the storage every context
 * keeps its data in. So a test sets it up afresh over separate storage before it
 * builds a context, and resets it once the contexts are closed.
 */
export const TestEnvironment = {
  /**
   * Sets up the environment over the storage, and registers the tenants.
   *
   * It resets the environment an earlier test left first. With no tenants,
   * the environment is single-tenant and keeps no register.
   *
   * @param storage The storage the test's contexts keep their data in.
   * @param tenants The tenants the test works in, for a multitenant context.
   */
  async start(storage: StorageFactory, tenants: readonly TenantId[] = []): Promise<void> {
    await TestEnvironment.reset();
    const index =
      tenants.length === 0
        ? undefined
        : await PersistentTenantIndex.create({ storageFactory: storage, group: TENANTS });
    registered = index;
    ServerEnvironment.when(EnvironmentType.Local).use({
      storageFactory: storage,
      ...(index === undefined ? {} : { tenantIndex: index }),
    });
    await ServerEnvironment.instance().completeSetup();
    for (const tenant of tenants) {
      await index?.keep(tenant);
    }
  },

  /**
   * Closes the environment, so the next test can set up a new one.
   *
   * The register of tenants closes first, as the environment closes the
   * storage it is kept in.
   */
  async reset(): Promise<void> {
    const index = registered;
    registered = undefined;
    try {
      await index?.close();
    } finally {
      await ServerTests.resetEnvironment();
    }
  },
};
