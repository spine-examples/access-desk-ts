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
import { Aggregate, Assign } from "@spine-event-engine/server";
import type { PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type {
  AddSignInAccount,
  RegisterPerson,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/commands_pb.js";
import {
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
  type PersonRegistered,
  type SignInAccountAdded,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import { PersonSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";

/**
 * One person who signs in to Access Desk.
 *
 * A person is registered the first time they sign in, under the email address
 * their identity provider confirmed. They may sign in with several accounts,
 * such as GitHub and Google. All of them are the same person, whom Access Desk
 * always knows by the same identifier.
 */
export class PersonAggregate extends Aggregate<PersonId, typeof PersonSchema> {
  /** Registers the person with the account they first signed in with. */
  @Assign
  registerPerson(command: RegisterPerson): PersonRegistered {
    const { emailAddress, name, account } = command;
    if (
      this.state.emailAddress !== undefined ||
      emailAddress === undefined ||
      account === undefined
    ) {
      throw new Error("A person is registered once, under an email address and with an account.");
    }
    this.update((draft) => {
      draft.id = this.id;
      draft.emailAddress = emailAddress;
      draft.name = name;
      draft.account = [account];
    });
    return create(PersonRegisteredSchema, { id: this.id, emailAddress, name, account });
  }

  /** Adds another account the person signs in with. */
  @Assign
  addSignInAccount(command: AddSignInAccount): SignInAccountAdded {
    const { account } = command;
    if (this.state.emailAddress === undefined || account === undefined) {
      throw new Error("An account is added to a registered person.");
    }
    this.update((draft) => {
      draft.account.push(account);
    });
    return create(SignInAccountAddedSchema, { id: this.id, account });
  }
}
