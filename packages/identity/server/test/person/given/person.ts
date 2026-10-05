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
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import {
  ExternalIdentityIdSchema,
  type ExternalIdentityId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { IdentityProvider } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import {
  AddSignInAccountSchema,
  RegisterPersonSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/commands_pb.js";
import { RegisterPersonEmailSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_commands_pb.js";
import { LinkExternalIdentitySchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_commands_pb.js";
import {
  ExternalIdentityViewSchema,
  type ExternalIdentityView,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import {
  PersonViewSchema,
  type PersonView,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";

import { readAll } from "../../given/identity-context.js";

/** GitHub, as the provider of a test account. */
export const github = IdentityProvider.GITHUB;
/** Google, as the provider of a test account. */
export const google = IdentityProvider.GOOGLE;

/** The account the provider gives the subject, such as GitHub account `1001`. */
export function account(provider: IdentityProvider, subject: string): ExternalIdentityId {
  return create(ExternalIdentityIdSchema, { provider, subject });
}

/**
 * Posts `LinkExternalIdentity` for the account, with the email address the
 * provider confirmed. The display name is the account's subject followed by
 * `(name)`.
 */
export function linkExternalIdentity(
  scope: BlackBoxScope,
  identity: ExternalIdentityId,
  email: string,
) {
  return scope.post(
    LinkExternalIdentitySchema,
    create(LinkExternalIdentitySchema, {
      id: identity,
      emailAddress: { value: email },
      name: `${identity.subject} (name)`,
    }),
  );
}

/** Posts `RegisterPersonEmail` for the email address, on behalf of the account being linked. */
export function registerPersonEmail(
  scope: BlackBoxScope,
  email: string,
  invoker: ExternalIdentityId,
) {
  return scope.post(
    RegisterPersonEmailSchema,
    create(RegisterPersonEmailSchema, { emailAddress: { value: email }, invoker }),
  );
}

/**
 * Posts `RegisterPerson` for the person with the given identifier, email
 * address, and first account. The display name is the identifier followed by
 * `(name)`.
 */
export function registerPerson(
  scope: BlackBoxScope,
  person: string,
  email: string,
  identity: ExternalIdentityId,
) {
  return scope.post(
    RegisterPersonSchema,
    create(RegisterPersonSchema, {
      id: { uuid: person },
      emailAddress: { value: email },
      name: `${person} (name)`,
      account: identity,
    }),
  );
}

/** Posts `AddSignInAccount`, adding the account to the person with the given identifier. */
export function addSignInAccount(
  scope: BlackBoxScope,
  person: string,
  identity: ExternalIdentityId,
) {
  return scope.post(
    AddSignInAccountSchema,
    create(AddSignInAccountSchema, { id: { uuid: person }, account: identity }),
  );
}

/**
 * Waits until `PersonView` has the person with the given identifier, in a
 * state the caller accepts, and returns that view.
 */
export async function awaitPerson(
  box: BlackBox,
  scope: BlackBoxScope,
  person: string,
  accept: (view: PersonView) => boolean = () => true,
): Promise<PersonView> {
  const matches = (view: PersonView): boolean => view.id?.uuid === person && accept(view);
  const people = await box.eventually(
    () => readAll(scope, PersonViewSchema, "query-person-view"),
    (rows) => rows.some(matches),
  );
  const found = people.find(matches);
  if (found === undefined) {
    throw new Error(`Person "${person}" not found.`);
  }
  return found;
}

/**
 * Waits until `ExternalIdentityView` has the account, which it does once the
 * account is linked to a person, and returns that view.
 */
export async function awaitLinked(
  box: BlackBox,
  scope: BlackBoxScope,
  identity: ExternalIdentityId,
): Promise<ExternalIdentityView> {
  const matches = (view: ExternalIdentityView): boolean =>
    view.id?.provider === identity.provider && view.id.subject === identity.subject;
  const accounts = await box.eventually(
    () => readAll(scope, ExternalIdentityViewSchema, "query-external-identity-view"),
    (rows) => rows.some(matches),
  );
  const found = accounts.find(matches);
  if (found === undefined) {
    throw new Error(`Account "${identity.subject}" is not linked.`);
  }
  return found;
}
