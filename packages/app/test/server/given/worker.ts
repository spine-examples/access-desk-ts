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

/**
 * A worker of an application server a test starts.
 *
 * The coordinator, in the test's process, starts each worker in a separate
 * Node process, which runs this module as it is. The worker takes the setup
 * of the application server from the test, through the environment.
 */

type AppModule = typeof import("../../../dist/src/index.js");
type Setup = import("../../../dist/src/index.js").ApplicationServerSetup;

const app: AppModule = await import("../../../dist/src/index.js");
const setup = JSON.parse(process.env.ACCESS_DESK_TEST_SERVER_SETUP ?? "") as Setup;
await app.ApplicationServer.start(setup, import.meta.url);
