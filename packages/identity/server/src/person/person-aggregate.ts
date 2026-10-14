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
  JoinOrganization,
  RegisterPerson,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/commands_pb.js";
import {
  OrganizationJoinedSchema,
  PersonRegisteredSchema,
  SignInAccountAddedSchema,
  type OrganizationJoined,
  type PersonRegistered,
  type SignInAccountAdded,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/events_pb.js";
import { PersonSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";

/**
 * One person who signs in to Access Desk.
 *
 * A person is registered the first time they sign in, under the email address
 * their identity provider confirmed. They may sign in with several accounts
 * under that address. All of them are the same person, whom Access Desk always
 * knows by the same identifier.
 */
export class PersonAggregate extends Aggregate<PersonId, typeof PersonSchema> {
  /** Registers the person with the account they first signed in with. */
  @Assign
  registerPerson(command: RegisterPerson): PersonRegistered {
    const { emailAddress, invoker } = command;
    if (this.state.emailAddress !== undefined || emailAddress === undefined) {
      throw new Error("A person is registered once, under an email address.");
    }
    this.update((draft) => {
      draft.emailAddress = emailAddress;
    });
    return create(PersonRegisteredSchema, { id: this.id, emailAddress, invoker });
  }

  /** Adds another account the person signs in with. */
  @Assign
  addSignInAccount(command: AddSignInAccount): SignInAccountAdded {
    const { account } = command;
    if (this.state.emailAddress === undefined || account === undefined) {
      throw new Error("An account is added to a registered person.");
    }
    const name = this.state.name === "" ? command.name : "";
    this.update((draft) => {
      draft.account.push(account);
      if (name !== "") {
        draft.name = name;
      }
    });
    return create(SignInAccountAddedSchema, { id: this.id, account, name });
  }

  /** Makes the person a member of an organization. */
  @Assign
  joinOrganization(command: JoinOrganization): OrganizationJoined {
    const { membership, organization } = command;
    const current = this.state.organization;
    if (
      this.state.emailAddress === undefined ||
      organization === undefined ||
      (current !== undefined && current.uuid !== organization.uuid)
    ) {
      throw new Error("A registered person joins one organization only.");
    }
    this.update((draft) => {
      draft.organization = organization;
    });
    return create(OrganizationJoinedSchema, { id: this.id, membership, organization });
  }
}
