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
import {
  type BoundedContext,
  PersistentTenantIndex,
  Server,
  SignalMetadata,
} from "@spine-event-engine/server";
import { StorageGroup } from "@spine-event-engine/storage";
import { TestEnvironment } from "@access-desk/testing/environment";
import { TestStorages } from "@access-desk/testing/storage";
import { type OrganizationId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AuditEntrySchema,
  type AuditEntry,
} from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

// Imported from compiled output, like the contexts it assembles: vitest cannot
// execute the handler classes' standard decorators from raw TypeScript source.
type AppModule = typeof import("../../../dist/src/index.js");
type ServerDatabases = import("../../../dist/src/index.js").ServerDatabases;

/**
 * The organizations the tests of the application work in.
 *
 * The server keeps only these, as only these are registered, and refuses
 * everything given in any other organization.
 */
const ORGANIZATIONS = ["acme", "globex"] as const;

/** The storage group the server keeps the register of organizations in. */
const REGISTER = new StorageGroup("organizations");

/** A running application server and its contexts, owned by a test. */
export interface Hosted {
  /** The HTTP address the server listens at. */
  readonly url: string;
  /** The storage the server keeps its data in. */
  readonly storage: ServerStorage;
  /** The register of the organizations the server keeps. */
  readonly organizations: PersistentTenantIndex;
  /** The global, single-tenant Identity context. */
  readonly identity: BoundedContext;
  /** The organization-scoped Resources context. */
  readonly resources: BoundedContext;
  /**
   * Stops the server and closes its assembled contexts.
   *
   * It deletes the data the server kept, unless the test passed its storage in.
   */
  stop(): Promise<void>;
}

/** The storage of an application server, which a test can start a server over again. */
export interface ServerStorage {
  /** The databases the server keeps its data in, as its settings name them. */
  readonly settings: ServerDatabases;
  /** Deletes the data the storage kept. */
  drop(): Promise<void>;
}

/**
 * Creates the storage of an application server.
 *
 * It is a new shared database. The database of each organization is named
 * after the shared one, and deleted with it.
 */
export async function givenServerStorage(): Promise<ServerStorage> {
  const shared = await TestStorages.databases(1);
  const [url = ""] = shared.urls;
  const name = new URL(url).pathname.slice(1);
  return {
    settings: { url, organizationDatabase: `${name}_{organization}` },
    drop: async () => {
      await TestStorages.dropDatabasesStartingWith(`${name}_`);
      await shared.drop();
    },
  };
}

/**
 * Creates the database of an organization, as an administrator does, unless it
 * is there already.
 *
 * @param storage The storage of the server.
 * @param organization The organization's identifier.
 */
async function givenDatabaseOf(storage: ServerStorage, organization: string): Promise<void> {
  const app: AppModule = await import("../../../dist/src/index.js");
  const url = new URL(app.Storage.organizationDatabase(storage.settings, organization));
  await TestStorages.createDatabases([url.pathname.slice(1)]);
}

/**
 * Registers an organization with a running application server: creates the
 * organization's database, and adds the organization to the server's
 * register.
 *
 * @param hosted The running server.
 * @param organization The organization's identifier.
 */
export async function givenRegistered(hosted: Hosted, organization: string): Promise<void> {
  await givenDatabaseOf(hosted.storage, organization);
  await hosted.organizations.keep(
    create(TenantIdSchema, { kind: { case: "value", value: organization } }),
  );
}

/**
 * Encodes an organization's value ID as its Spine tenant. Each organization has one tenant.
 *
 * @param organization The organization that owns the tenant-scoped state.
 */
export function tenant(organization: OrganizationId) {
  return create(TenantIdSchema, { kind: { case: "value", value: organization.uuid } });
}

/**
 * Creates the databases of the test organizations and registers them before
 * the server starts.
 *
 * @param storage The storage of the server.
 */
async function givenOrganizationsRegistered(storage: ServerStorage): Promise<void> {
  const app: AppModule = await import("../../../dist/src/index.js");
  const factory = await app.Storage.openServer(storage.settings);
  try {
    const register = await PersistentTenantIndex.create({
      storageFactory: factory,
      group: REGISTER,
    });
    try {
      for (const organization of ORGANIZATIONS) {
        await givenDatabaseOf(storage, organization);
        await register.keep(
          create(TenantIdSchema, { kind: { case: "value", value: organization } }),
        );
      }
    } finally {
      await register.close();
    }
  } finally {
    await factory.close();
  }
}

/**
 * Creates the storage of an application server, with the databases of the
 * organizations the tests work in, and registers those organizations.
 */
export async function givenRegisteredStorage(): Promise<ServerStorage> {
  const storage = await givenServerStorage();
  await givenOrganizationsRegistered(storage);
  return storage;
}

/**
 * Starts both application contexts on a free port, without creating an organization.
 *
 * The server keeps the organizations the tests work in, registered before it
 * starts, and its data in the storage of the run.
 *
 * @param storage The storage to start the server over, to keep the data an
 *   earlier server kept. New, empty storage when left out.
 */
export async function givenServer(storage?: ServerStorage): Promise<Hosted> {
  const app: AppModule = await import("../../../dist/src/index.js");
  const kept = storage ?? (await givenServerStorage());
  await givenOrganizationsRegistered(kept);
  let url = "";
  await TestEnvironment.reset();
  const contexts = await app.AccessDesk.assemble({
    server: () => url,
    storage: await app.Storage.openServer(kept.settings),
  });
  const server = await new Server({
    contexts: [contexts.identity, contexts.resources],
    resources: [contexts.members, contexts.organizations],
    port: 0,
    services: { readerAdmission: "trusted-network" },
  }).start();
  url = server.baseUrl;
  return {
    url,
    storage: kept,
    organizations: contexts.organizations,
    identity: contexts.identity,
    resources: contexts.resources,
    stop: async () => {
      await server.close();
      await TestEnvironment.reset();
      if (storage === undefined) {
        await kept.drop();
      }
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
 * Creates an organization in a separate tenant, using its UUID as the display name,
 * and waits until its view shows it.
 *
 * @param hosted The running server whose Resources context receives the command.
 * @param organization The new organization's value ID; its UUID also becomes the display name.
 */
export async function givenOrganization(
  hosted: Hosted,
  organization: OrganizationId,
): Promise<void> {
  await give(
    hosted.resources,
    CreateOrganizationSchema,
    create(CreateOrganizationSchema, { id: organization, name: organization.uuid }),
    { organization },
  );
  const shown = await eventually(
    () => organizationView(hosted, organization),
    (view) => view !== undefined,
  );
  if (shown === undefined) {
    throw new Error(`Organization ${organization.uuid} does not show in its view.`);
  }
}

/**
 * Reads an organization's view from the organization's tenant; returns undefined before it appears.
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
 * Reads the whole audit trail of an organization from the organization's tenant.
 *
 * @param hosted The running server whose Resources context keeps the audit trail.
 * @param organization The organization's value ID, used as the tenant.
 */
export async function auditTrailOf(
  hosted: Hosted,
  organization: OrganizationId,
): Promise<AuditEntry[]> {
  const entries = await hosted.resources
    .stand()
    .readAllVersioned(AuditEntrySchema, { tenantId: tenant(organization) });
  return entries.map(({ state }) => state);
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
