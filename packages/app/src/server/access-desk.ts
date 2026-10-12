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

import type { BoundedContext } from "@spine-event-engine/server";
import { createIdentityContext } from "@access-desk/identity-server";
import { createResourcesContext } from "@access-desk/resources-server";
import { organizationMembersThrough } from "./organization-members.js";

/** How the application is assembled. */
export interface AccessDeskOptions {
  /**
   * Tells the address of the server that hosts the contexts, once it listens.
   *
   * An accepted invitation adds the person to the organization's members
   * through this address.
   */
  readonly server: () => string;
}

/** The assembled application. */
export interface AccessDesk {
  /** The Identity context, which says who a person is and who invited them where. */
  readonly identity: BoundedContext;
  /** The Resources context, which holds each organization, its members, and what it owns. */
  readonly resources: BoundedContext;
  /** Closes the connections through which Identity reaches the organizations. */
  close(): Promise<void>;
}

/**
 * Assembles Access Desk from its contexts.
 *
 * Identity says who a person is and holds the invitations. Resources holds
 * the organizations, their members, and what they own. When a person accepts
 * an invitation, Identity has the organization add them to its members.
 *
 * @param options How to assemble the application.
 * @returns The contexts, ready to be hosted by a server.
 */
export async function assembleAccessDesk(options: AccessDeskOptions): Promise<AccessDesk> {
  const members = organizationMembersThrough(options.server);
  const identity = await createIdentityContext({ members });
  const resources = await createResourcesContext();
  return { identity, resources, close: () => members.close() };
}
