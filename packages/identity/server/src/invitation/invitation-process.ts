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
import { InvitationStatus } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import type { CommandContext } from "@spine-event-engine/proto";
import { Assign, ProcessManager, Throws, type EntityOptions } from "@spine-event-engine/server";
import type {
  InvitationId,
  PersonId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import type {
  AcceptInvitation,
  DeclineInvitation,
  InviteMember,
  RevokeInvitation,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/commands_pb.js";
import {
  InvitationAcceptedSchema,
  InvitationDeclinedSchema,
  InvitationRevokedSchema,
  MemberInvitedSchema,
  type InvitationAccepted,
  type InvitationDeclined,
  type InvitationRevoked,
  type MemberInvited,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/events_pb.js";
import { InvitationSchema } from "@access-desk/identity-model/generated/accessdesk/identity/invitation/invitation_pb.js";
import {
  NotInvitedPerson,
  InvitationNotPending,
  MemberAlreadyInvited,
} from "@access-desk/identity-model/generated/accessdesk/identity/invitation/rejections.js";
import type { OrganizationMembers } from "./organization-members.js";

/**
 * An organization's invitation of one person to become its member.
 *
 * 1. An administrator invites a person by their email address, and says which
 *    role they will hold.
 * 2. The invitation waits. An administrator may take it back, and may later
 *    invite the same person again.
 * 3. The person, having signed in, accepts the invitation or declines it.
 *    They answer for themselves: nobody accepts or declines on behalf of
 *    another person. A person who declined may be invited again.
 * 4. When a person accepts, the organization adds them to its members with
 *    the role the invitation gives. The invitation is accepted once the
 *    organization has done so.
 */
export class InvitationProcessManager extends ProcessManager<
  InvitationId,
  typeof InvitationSchema
> {
  /**
   * The service that adds a person to the members of an organization.
   */
  readonly #members: OrganizationMembers;

  /**
   * @param options What Spine gives every invitation it constructs.
   * @param members The service that adds a person to the members of an organization.
   */
  constructor(
    options: EntityOptions<InvitationId, typeof InvitationSchema>,
    members: OrganizationMembers,
  ) {
    super(options);
    this.#members = members;
  }

  /** Invites the person, unless they are already invited or have already accepted. */
  @Assign
  @Throws(MemberAlreadyInvited)
  inviteMember(command: InviteMember): MemberInvited {
    const status = this.state.status;
    if (status === InvitationStatus.PENDING || status === InvitationStatus.ACCEPTED) {
      throw MemberAlreadyInvited.create({ id: this.id });
    }
    const role = command.role;
    this.update((draft) => {
      draft.role = role;
      draft.status = InvitationStatus.PENDING;
    });
    return create(MemberInvitedSchema, { id: this.id, role });
  }

  /** Takes the invitation back while nobody has accepted it. */
  @Assign
  @Throws(InvitationNotPending)
  revokeInvitation(_command: RevokeInvitation): InvitationRevoked {
    this.assertPending();
    this.update((draft) => {
      draft.status = InvitationStatus.REVOKED;
    });
    return create(InvitationRevokedSchema, { id: this.id });
  }

  /**
   * Accepts the invitation for the invited person while it is waiting.
   *
   * The person who accepts is the one acting, never somebody they name. The
   * organization adds them to its members first. Only when it has done so is
   * the invitation accepted. Otherwise, it keeps waiting.
   */
  @Assign
  @Throws(NotInvitedPerson, InvitationNotPending)
  async acceptInvitation(
    command: AcceptInvitation,
    context: CommandContext,
  ): Promise<InvitationAccepted> {
    const { person, name } = command;
    const organization = this.id.organization;
    this.assertAnswersForThemselves(person, context);
    this.assertPending();
    if (person === undefined || organization === undefined) {
      throw new Error("An invitation is accepted by a person, for an organization.");
    }
    const role = this.state.role;
    await this.#members.add({ organization, person, name, role });
    this.update((draft) => {
      draft.status = InvitationStatus.ACCEPTED;
    });
    return create(InvitationAcceptedSchema, { id: this.id, person, name, role });
  }

  /**
   * Declines the invitation for the invited person while it is waiting.
   *
   * The person who declines is the one acting, never somebody they name.
   */
  @Assign
  @Throws(NotInvitedPerson, InvitationNotPending)
  declineInvitation(command: DeclineInvitation, context: CommandContext): InvitationDeclined {
    this.assertAnswersForThemselves(command.person, context);
    this.assertPending();
    this.update((draft) => {
      draft.status = InvitationStatus.DECLINED;
    });
    return create(InvitationDeclinedSchema, { id: this.id, person: command.person });
  }

  private assertAnswersForThemselves(person: PersonId | undefined, context: CommandContext): void {
    if (person === undefined) {
      throw new Error("An invitation is answered by a person.");
    }
    const acting = context.actorContext?.actor?.value ?? "";
    if (person.uuid !== acting) {
      throw NotInvitedPerson.create({ id: this.id, person });
    }
  }

  private assertPending(): void {
    if (this.state.status !== InvitationStatus.PENDING) {
      throw InvitationNotPending.create({ id: this.id });
    }
  }
}
