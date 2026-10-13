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
   * Returns the address of the application server, once it listens.
   *
   * Identity uses it to add a person to an organization's members when they
   * accept an invitation.
   */
  readonly server: () => string;
}

/** The assembled application. */
export interface AccessDesk {
  /** The Identity context, which holds people, their accounts, and invitations. */
  readonly identity: BoundedContext;
  /** The Resources context, which holds each organization, its members, and what it owns. */
  readonly resources: BoundedContext;
  /** Closes Identity's connection to the organizations. */
  close(): Promise<void>;
}

/**
 * Assembles Access Desk from its contexts.
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
