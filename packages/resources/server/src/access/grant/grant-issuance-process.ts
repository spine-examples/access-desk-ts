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
import { AnyMessages } from "@spine-event-engine/core";
import { Command, ProcessManager, React } from "@spine-event-engine/server";
import {
  AccessGrantIdSchema,
  AccessRequestIdSchema,
  type AccessGrantId,
  type AccessRequestId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  AccessGrantStatus,
  type AccessExtension,
  type NewAccessRequest,
} from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import type { AccessRequestApproved } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import { GrantIssuanceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/grant_issuance_pb.js";
import {
  ActivateAccessGrantSchema,
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
  type ActivateAccessGrant,
  type CreateAccessGrant,
  type ExtendAccessGrant,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessGrantActivationScheduledSchema,
  type AccessGrantActivationScheduled,
  type AccessGrantCreated,
  type AccessGrantExtended,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  ScheduleCommandSchema,
  type ScheduleCommand,
} from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/commands_pb.js";
import type { CommandScheduled } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/events_pb.js";
import { equals } from "../../proto/equals.js";
import { effectiveInterval, requestedInterval } from "../access-period.js";
import { invokerOf } from "../../invoker-id.js";

/**
 * The issuing of one access grant from the requests approved for it.
 *
 * 1. When a first-time request is approved, the process creates the grant for
 *    the access the approval makes effective.
 * 2. Once the grant is created, access due to begin now is activated at once.
 *    Access that begins later has its activation scheduled for its start.
 * 3. When Scheduling confirms the scheduled activation, the process reports the
 *    grant's activation as scheduled.
 * 4. When an extension request for the grant is approved, the process moves the
 *    grant's end to the end the request proposed.
 */
export class GrantIssuanceProcessManager extends ProcessManager<
  AccessGrantId,
  typeof GrantIssuanceSchema
> {
  /**
   * Gives an approved request its effect on the grant.
   *
   * An approved first-time request creates the grant. An approved extension
   * request extends the grant it names.
   */
  @Command
  async issueOnApproval(
    event: AccessRequestApproved,
  ): Promise<CreateAccessGrant | ExtendAccessGrant> {
    const kind = event.snapshot?.kind;
    switch (kind?.case) {
      case "newRequest":
        return this.create(event, kind.value);
      case "extension":
        return this.extend(event, kind.value);
      default:
        throw new Error("An approved request must ask for new access or for an extension.");
    }
  }

  /**
   * Starts a newly created grant, and notes the approved request that issued it.
   *
   * Access that begins later has its activation scheduled for its start.
   */
  @Command
  startGrantOnCreation(event: AccessGrantCreated): ActivateAccessGrant | ScheduleCommand {
    const request = event.request;
    switch (event.status) {
      case AccessGrantStatus.PENDING_ACTIVATION:
        this.update((draft) => {
          draft.id = this.id;
          draft.request = request;
        });
        return create(ActivateAccessGrantSchema, { id: this.id });
      case AccessGrantStatus.PENDING_SCHEDULING:
        this.update((draft) => {
          draft.id = this.id;
          draft.request = request;
        });
        return create(ScheduleCommandSchema, {
          id: { uuid: crypto.randomUUID() },
          command: AnyMessages.pack(
            ActivateAccessGrantSchema,
            create(ActivateAccessGrantSchema, { id: this.id }),
          ),
          due: event.start,
          invoker: invokerOf(AccessGrantIdSchema, this.id, GrantIssuanceSchema),
        });
      default:
        throw new Error("A grant is created pending either its scheduling or its activation.");
    }
  }

  /**
   * Reports the grant's activation as scheduled, once Scheduling confirms the
   * activation command it was asked to schedule.
   */
  @React
  onActivationScheduled(event: CommandScheduled): AccessGrantActivationScheduled {
    return create(AccessGrantActivationScheduledSchema, { id: this.id, start: event.due });
  }

  /** Records the approved extension request that the grant has applied. */
  @React
  onGrantExtended(event: AccessGrantExtended): undefined {
    const request = event.request;
    if (request !== undefined) {
      this.update((draft) => {
        draft.id = this.id;
        draft.extension = including(draft.extension, request);
      });
    }
    return undefined;
  }

  /**
   * Creates the grant for the access an approved first-time request grants.
   *
   * 1. Immediate access counts its duration from the approval.
   * 2. Scheduled access approved within its interval begins at the approval.
   * 3. Scheduled access approved before its start keeps its interval and waits
   *    for its start.
   * 4. Scheduled access approved after its end keeps its interval, and the
   *    grant expires before activation.
   *
   * The longest the access may last is the resource's maximum duration at the
   * time of approval.
   */
  private async create(
    event: AccessRequestApproved,
    request: NewAccessRequest,
  ): Promise<CreateAccessGrant> {
    const approvedAt = event.whenDecided;
    const { resource, accessLevel, period } = request;
    const interval =
      approvedAt === undefined || period === undefined
        ? undefined
        : (effectiveInterval(period, approvedAt) ?? requestedInterval(period, approvedAt));
    if (interval === undefined || resource === undefined) {
      throw new Error(
        "An approved first-time request must carry its approval time, resource, and period.",
      );
    }
    const maximumLifetime = (
      await this.select(ResourceCatalogItemSchema, {}).findById(resource as never)
    )?.policy?.maximumDuration;
    if (maximumLifetime === undefined) {
      throw new Error("The resource of an approved request must be in the catalog.");
    }
    this.update((draft) => {
      draft.id = this.id;
      draft.request = event.id;
    });
    return create(CreateAccessGrantSchema, {
      id: this.id,
      request: event.id,
      access: { grantee: event.snapshot?.requester, resource, accessLevel },
      start: interval.start,
      end: interval.end,
      maximumLifetime,
      approvedBy: event.decidedBy,
      manager: event.manager,
    });
  }

  /**
   * Moves the grant's end to the end an approved extension request proposed, and
   * records the request among the grant's extensions.
   */
  private extend(event: AccessRequestApproved, extension: AccessExtension): ExtendAccessGrant {
    const request = event.id;
    if (
      request !== undefined &&
      !this.state.extension.some((applied) => equals(AccessRequestIdSchema, applied, request))
    ) {
      this.update((draft) => {
        draft.id = this.id;
        draft.extension = [...draft.extension, request];
      });
    }
    return create(ExtendAccessGrantSchema, {
      id: this.id,
      request,
      end: extension.proposedEnd,
    });
  }
}

/** The requests with `request` added, unless it is already among them. */
function including(
  requests: readonly AccessRequestId[],
  request: AccessRequestId,
): AccessRequestId[] {
  return requests.some((known) => equals(AccessRequestIdSchema, known, request))
    ? [...requests]
    : [...requests, request];
}
