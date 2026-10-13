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

import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { SignalEnvelopes } from "@spine-event-engine/core";
import { TenantIdSchema, UserIdSchema } from "@spine-event-engine/proto";
import { type BoundedContext, Server, SignalMetadata } from "@spine-event-engine/server";
import { type OrganizationId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

// Imported from compiled output, like the contexts it assembles: vitest cannot
// execute the handler classes' standard decorators from raw TypeScript source.
type AccessDeskModule = typeof import("../../../dist/src/server/access-desk.js");

/** A running application server and its contexts, owned by a test. */
export interface Hosted {
  /** The HTTP address the server listens at. */
  readonly url: string;
  /** The global, single-tenant Identity context. */
  readonly identity: BoundedContext;
  /** The organization-scoped Resources context. */
  readonly resources: BoundedContext;
  /** Stops the server and closes its assembled contexts. */
  stop(): Promise<void>;
}

/**
 * Encodes an organization's value ID as its Spine tenant. Each organization has one tenant.
 *
 * @param organization The organization that owns the tenant-scoped state.
 */
export function tenant(organization: OrganizationId) {
  return create(TenantIdSchema, { kind: { case: "value", value: organization.uuid } });
}

/** Starts both application contexts on a free port, without creating an organization. */
export async function givenServer(): Promise<Hosted> {
  const assembly: AccessDeskModule = await import("../../../dist/src/server/access-desk.js");
  let url = "";
  const contexts = await assembly.AccessDesk.assemble({ server: () => url });
  const server = await new Server({
    contexts: [contexts.identity, contexts.resources],
    port: 0,
  }).start();
  url = server.baseUrl;
  return {
    url,
    identity: contexts.identity,
    resources: contexts.resources,
    stop: async () => {
      await server.close();
      await contexts.close();
    },
  };
}

/**
 * Posts a command directly to a context under the supplied actor and optional tenant.
 *
 * @param context The bounded context receiving the command.
 * @param schema The command's protobuf schema.
 * @param command The typed command message to post.
 * @param acting Optional actor and organization tenancy for the command.
 */
export async function give<Schema extends GenMessage<Message>>(
  context: BoundedContext,
  schema: Schema,
  command: MessageShape<Schema>,
  acting: {
    /** Spine actor/service identity, not an organization ID. */
    readonly actor?: string;
    /** Value ID of the organization whose tenant receives the command. */
    readonly organization?: OrganizationId;
  } = {},
): Promise<void> {
  await context.commandBus().post(
    SignalEnvelopes.command({
      context: new SignalMetadata().commandContext({
        actor: create(UserIdSchema, { value: acting.actor ?? "access-desk" }),
        ...(acting.organization === undefined ? {} : { tenantId: tenant(acting.organization) }),
      }),
      schema,
      message: command,
    }),
  );
}

/**
 * Creates an organization in its own tenant, using its UUID as the display name.
 *
 * @param hosted The running server whose Resources context receives the command.
 * @param organization The new organization's value ID; its UUID also becomes the display name.
 */
export function givenOrganization(hosted: Hosted, organization: OrganizationId): Promise<void> {
  return give(
    hosted.resources,
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: organization, name: organization.uuid }),
    { organization },
  );
}

/**
 * Reads an organization's view from its own tenant; returns undefined before it appears.
 *
 * @param hosted The running server whose Resources context holds the view.
 * @param organization The organization's value ID, used for both lookup and tenant.
 */
export function organizationView(
  hosted: Hosted,
  organization: OrganizationId,
): Promise<OrganizationView | undefined> {
  return hosted.resources.stand().read(OrganizationViewSchema, organization, {
    tenantId: tenant(organization),
  });
}

/**
 * Repeats an eventually consistent read until accepted or the ten-second deadline passes.
 *
 * @param read The asynchronous read to repeat.
 * @param accept Whether the latest read satisfies the test's condition.
 */
export async function eventually<Value>(
  read: () => Promise<Value>,
  accept: (value: Value) => boolean,
): Promise<Value> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
