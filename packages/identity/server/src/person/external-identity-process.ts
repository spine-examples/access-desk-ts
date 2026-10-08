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
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { Assign, Command, ProcessManager, React, Throws } from "@spine-event-engine/server";
import type { ExternalIdentityId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AddSignInAccountSchema,
  RegisterPersonSchema,
  type AddSignInAccount,
  type RegisterPerson,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/commands_pb.js";
import {
  RegisterPersonEmailSchema,
  type RegisterPersonEmail,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_commands_pb.js";
import type { PersonEmailRegistered } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import type { PersonEmailAlreadyRegistered as EmailAlreadyRegistered } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections_pb.js";
import type {
  PersonRegistered,
  SignInAccountAdded,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import type { LinkExternalIdentity } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_commands_pb.js";
import {
  ExternalIdentityLinkedSchema,
  ExternalIdentityLinkingStartedSchema,
  type ExternalIdentityLinked,
  type ExternalIdentityLinkingStarted,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_events_pb.js";
import { ExternalIdentitySchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import { ExternalIdentityAlreadyKnown } from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_rejections.js";

/**
 * The linking of an account, held with an identity provider such as GitHub or
 * Google, to the person who signs in with it.
 *
 * 1. Somebody signs in with an account Access Desk has not seen, and the
 *    provider confirms the account's email address.
 * 2. The email address is registered.
 * 3. When the address was not registered yet, a new person is registered with
 *    the account. When it is already registered for a person, the account is
 *    added to that person.
 */
export class ExternalIdentityProcessManager extends ProcessManager<
  ExternalIdentityId,
  typeof ExternalIdentitySchema
> {
  /** Starts linking the account, unless that has already been done or begun. */
  @Assign
  @Throws(ExternalIdentityAlreadyKnown)
  linkExternalIdentity(command: LinkExternalIdentity): ExternalIdentityLinkingStarted {
    if (this.state.emailAddress !== undefined) {
      throw ExternalIdentityAlreadyKnown.create({ id: this.id });
    }
    const { name } = command;
    const emailAddress = create(EmailAddressSchema, {
      value: (command.emailAddress?.value ?? "").trim().toLowerCase(),
    });
    this.update((draft) => {
      draft.emailAddress = emailAddress;
      draft.name = name;
    });
    return create(ExternalIdentityLinkingStartedSchema, { id: this.id, emailAddress });
  }

  /** Registers the account's email address. */
  @Command
  onExternalIdentityLinkingStarted(event: ExternalIdentityLinkingStarted): RegisterPersonEmail {
    const { emailAddress } = event;
    return create(RegisterPersonEmailSchema, { emailAddress, invoker: this.id });
  }

  /** Registers a new person, as the email address was not registered before. */
  @Command
  onPersonEmailRegistered(event: PersonEmailRegistered): RegisterPerson {
    return create(RegisterPersonSchema, {
      id: event.person,
      emailAddress: event.emailAddress,
      name: this.state.name,
      account: this.id,
    });
  }

  /** Adds the account to the person the email address is registered for. */
  @Command
  onPersonEmailAlreadyRegistered(rejection: EmailAlreadyRegistered): AddSignInAccount {
    return create(AddSignInAccountSchema, { id: rejection.person, account: this.id });
  }

  /** Links the account to the person registered with it. */
  @React
  onPersonRegistered(event: PersonRegistered): ExternalIdentityLinked {
    return this.linked(event);
  }

  /** Links the account to the person it was added to. */
  @React
  onSignInAccountAdded(event: SignInAccountAdded): ExternalIdentityLinked {
    return this.linked(event);
  }

  private linked(event: PersonRegistered | SignInAccountAdded): ExternalIdentityLinked {
    const person = event.id;
    if (person === undefined) {
      throw new Error("An account is linked to a person.");
    }
    this.update((draft) => {
      draft.person = person;
    });
    return create(ExternalIdentityLinkedSchema, { id: this.id, person });
  }
}
