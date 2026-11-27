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

import { create } from "@bufbuild/protobuf";
import { OrganizationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

import { closeAfterTest } from "./closing.js";

type ClientModule = typeof import("../../../dist/src/server/client.js");

/** Builds the identifier of an organization. */
export function organizationId(uuid: string) {
  return create(OrganizationIdSchema, { value: uuid });
}

/** Builds the command that creates an organization. */
export function creation(organization: string, name: string = organization) {
  return create(CreateOrganizationSchema, { id: { value: organization }, name });
}

/** Picks out the name an organization's view shows, once it shows one. */
export function named(view: { readonly name: string }): string | undefined {
  return view.name === "" ? undefined : view.name;
}

/** Waits for the first value an observer is given, for a while. */
export function firstGiven<Value>(patienceMs: number) {
  const given = Promise.withResolvers<Value | undefined>();
  const timer = setTimeout(() => {
    given.resolve(undefined);
  }, patienceMs);
  return {
    observe: (value: Value) => {
      given.resolve(value);
    },
    value: given.promise.finally(() => {
      clearTimeout(timer);
    }),
  };
}

/** Describes creating an organization, which shows in its view under its name. */
export function creationShown(organization: string, name: string = organization) {
  return {
    command: CreateOrganizationSchema,
    message: creation(organization, name),
    view: OrganizationViewSchema,
    idSchema: OrganizationIdSchema,
    id: organizationId(organization),
    shows: named,
  };
}

/**
 * Opens the connection a program keeps to an application server, closed after
 * the test.
 */
export async function givenConnection(address: () => string) {
  const { ServerConnection }: ClientModule = await import("../../../dist/src/server/client.js");
  const connection = new ServerConnection(address);
  closeAfterTest(() => connection.close());
  return connection;
}
