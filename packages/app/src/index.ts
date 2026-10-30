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
 * Access Desk as two programs: the application server, which hosts the
 * contexts, and the gateway, the only one a browser talks to.
 */
export { typeRegistry } from "../generated/model-registry.js";
export { AccessDesk, type AccessDeskOptions } from "./server/access-desk.js";
export { Gateway, type GatewayOptions } from "./gateway/gateway.js";
export { RevokedTokens } from "./gateway/revoked-tokens.js";
export { Storage } from "./storage.js";
export type { StorageSettings } from "./settings.js";
export type { ExternalSignIn } from "./gateway/routes/sign-in-routes.js";
export { type SignInProvider } from "./gateway/providers.js";
