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
import { InvitationStatus } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import type { CommandContext, EventContext } from "@spine-event-engine/proto";
import { Assign, Command, ProcessManager, Throws } from "@spine-event-engine/server";
import type { PersonId } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  OrganizationIdSchema,
  type InvitationId,
  type OrganizationId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  AddOrganizationMemberSchema,
  type AddOrganizationMember,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import type {
  AcceptInvitation,
  DeclineInvitation,
  InviteMember,
  RevokeInvitation,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/commands_pb.js";
import {
  InvitationAcceptedSchema,
  InvitationDeclinedSchema,
  InvitationRevokedSchema,
  MemberInvitedSchema,
  type InvitationAccepted,
  type InvitationDeclined,
  type InvitationRevoked,
  type MemberInvited,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/events_pb.js";
import { InvitationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/invitation_pb.js";
import {
  NotInvitedPerson,
  InvitationNotPending,
  MemberAlreadyInvited,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/invitation/rejections.js";

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
 * 4. The organization adds the person as a member with the role the
 *    invitation gives.
 */
export class InvitationProcessManager extends ProcessManager<
  InvitationId,
  typeof InvitationSchema
> {
  /** Invites the person, unless they are already invited or have already accepted. */
  @Assign
  @Throws(MemberAlreadyInvited)
  inviteMember(command: InviteMember): MemberInvited {
    const status = this.state.status;
    if (
      status === InvitationStatus.INVITATION_PENDING ||
      status === InvitationStatus.INVITATION_ACCEPTED
    ) {
      throw MemberAlreadyInvited.create({ id: this.id });
    }
    const role = command.role;
    this.update((draft) => {
      draft.id = this.id;
      draft.role = role;
      draft.status = InvitationStatus.INVITATION_PENDING;
    });
    return create(MemberInvitedSchema, { id: this.id, role });
  }

  /** Takes the invitation back while nobody has accepted it. */
  @Assign
  @Throws(InvitationNotPending)
  revokeInvitation(_command: RevokeInvitation): InvitationRevoked {
    this.assertPending();
    this.update((draft) => {
      draft.status = InvitationStatus.INVITATION_REVOKED;
    });
    return create(InvitationRevokedSchema, { id: this.id });
  }

  /**
   * Accepts the invitation for the invited person while it is waiting.
   *
   * The person who accepts is the one acting, never somebody they name.
   */
  @Assign
  @Throws(NotInvitedPerson, InvitationNotPending)
  acceptInvitation(command: AcceptInvitation, context: CommandContext): InvitationAccepted {
    this.assertAnswersForThemselves(command.person, context);
    this.assertPending();
    this.update((draft) => {
      draft.status = InvitationStatus.INVITATION_ACCEPTED;
    });
    return create(InvitationAcceptedSchema, {
      id: this.id,
      person: command.person,
      name: command.name,
      role: this.state.role,
    });
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
      draft.status = InvitationStatus.INVITATION_DECLINED;
    });
    return create(InvitationDeclinedSchema, { id: this.id, person: command.person });
  }

  /** Adds the person who accepted the invitation to the organization. */
  @Command
  onInvitationAccepted(event: InvitationAccepted, context: EventContext): AddOrganizationMember {
    return create(AddOrganizationMemberSchema, {
      organizationId: this.organizationOf(context),
      person: event.person,
      name: event.name,
      role: event.role,
    });
  }

  /**
   * The organization a fact happened in.
   *
   * Each organization is its own tenant, so the organization is the tenant the
   * fact was recorded for, never one the fact itself names.
   */
  private organizationOf(context: EventContext): OrganizationId {
    const origin = context.origin;
    const actor =
      origin.case === "importContext"
        ? origin.value
        : origin.case === "pastMessage"
          ? origin.value.actorContext
          : undefined;
    const tenant = actor?.tenantId?.kind;
    if (tenant?.case !== "value" || tenant.value === "") {
      throw new Error("A fact in the Resources context must happen in an organization.");
    }
    return create(OrganizationIdSchema, { uuid: tenant.value });
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
    if (this.state.status !== InvitationStatus.INVITATION_PENDING) {
      throw InvitationNotPending.create({ id: this.id });
    }
  }
}
