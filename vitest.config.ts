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

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/*/test/**/*.test.ts"],
    // BlackBox tests drive asynchronous cross-entity delivery and use bounded
    // `eventually` waits; multi-hop reconciliation needs headroom over the 5s
    // default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each BlackBox test starts its own in-process server; running whole test
    // files in parallel starves delivery and makes multi-hop flows flaky. Run
    // files sequentially so each gets the CPU it needs.
    fileParallelism: false,
    server: {
      deps: {
        external: [/[/\\]dist[/\\]/],
      },
    },
  },
});
