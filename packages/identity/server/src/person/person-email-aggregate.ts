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

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { EmailAddress } from "@spine-event-engine/proto";
import { Aggregate, Assign, Throws } from "@spine-event-engine/server";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type { RegisterPersonEmail } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_commands_pb.js";
import {
  PersonEmailRegisteredSchema,
  type PersonEmailRegistered,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_events_pb.js";
import { PersonEmailAlreadyRegistered } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_rejections.js";
import { PersonEmailSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_pb.js";

/**
 * The email address a person is registered under.
 *
 * An address belongs to one person only, the one registered when somebody
 * first signed in under it. Whoever signs in under it afterwards, with
 * whatever account, is that same person. This is what makes a GitHub account
 * and a Google account one person.
 */
export class PersonEmailAggregate extends Aggregate<EmailAddress, typeof PersonEmailSchema> {
  /**
   * Registers the address for a new person, unless it already belongs to
   * somebody.
   */
  @Assign
  @Throws(PersonEmailAlreadyRegistered)
  registerPersonEmail(command: RegisterPersonEmail): PersonEmailRegistered {
    const { invoker } = command;
    const owner = this.state.person;
    if (owner !== undefined) {
      throw PersonEmailAlreadyRegistered.create({ emailAddress: this.id, person: owner, invoker });
    }
    const person = create(PersonIdSchema, { uuid: randomUUID() });
    this.update((draft) => {
      draft.emailAddress = this.id;
      draft.person = person;
    });
    return create(PersonEmailRegisteredSchema, { emailAddress: this.id, person, invoker });
  }
}
