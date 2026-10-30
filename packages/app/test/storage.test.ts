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

import { PostgresStorageFactory } from "@spine-event-engine/storage-postgres";
import { describe, expect, it, vi } from "vitest";
import { TestStorages } from "@access-desk/testing/storage";
import { Storage } from "../src/storage.js";

describe("The storage of Resources should", () => {
  it.runIf(TestStorages.profile() === "postgresql")(
    "close what it opened when it cannot open the rest, in PostgreSQL",
    async () => {
      const databases = await TestStorages.databases(1);
      const [organizationUrl = ""] = databases.urls;
      const missing = new URL(organizationUrl);
      missing.pathname = `/accessdesk_test_missing_${crypto.randomUUID().replaceAll("-", "")}`;
      const closing = vi.spyOn(PostgresStorageFactory.prototype, "close");
      try {
        await expect(
          Storage.openResources({
            kind: "postgresql",
            organizations: [{ organization: "acme", url: organizationUrl }],
            subscriptionsUrl: missing.toString(),
          }),
        ).rejects.toThrow();

        expect(closing).toHaveBeenCalledOnce();
      } finally {
        closing.mockRestore();
        await databases.drop();
      }
    },
  );
});
