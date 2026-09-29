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

import { create, toBinary } from "@bufbuild/protobuf";
import { type Any, AnySchema, type Timestamp } from "@bufbuild/protobuf/wkt";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import {
  ActivateAccessGrantSchema,
  RevokeAccessGrantSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import { CommandScheduledSchema } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/events_pb.js";
import {
  SchedulingSchema,
  type Scheduling,
} from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/scheduling_pb.js";
import { ScheduleCommandSchema } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/commands_pb.js";

import { readAll } from "../../given/resources-context.js";

/** The packed command that begins a grant's access. */
export function packedActivation(grant: string): Any {
  return AnyMessages.pack(
    ActivateAccessGrantSchema,
    create(ActivateAccessGrantSchema, { id: { uuid: grant } }),
  );
}

/** A command in the right wire form whose content is `value`. */
function packedAsActivation(value: Uint8Array): Any {
  return create(AnySchema, { typeUrl: TypeUrls.derive(ActivateAccessGrantSchema), value });
}

/**
 * Commands the organization never plans.
 */
export const unschedulable: Record<string, Any> = {
  "that is not a command": AnyMessages.pack(
    CommandScheduledSchema,
    create(CommandScheduledSchema, {
      id: { uuid: "plan" },
      command: packedActivation("grant-event"),
      due: { seconds: 60n },
    }),
  ),
  "that is a known command but is not schedulable": AnyMessages.pack(
    RevokeAccessGrantSchema,
    create(RevokeAccessGrantSchema, {
      id: { uuid: "grant-revoke" },
      manager: { uuid: "primary" },
      reason: "Planned.",
    }),
  ),
  "of a kind the organization does not know": create(AnySchema, {
    typeUrl: "type.accessdesk/accessdesk.resources.access.grant.TransferAccessGrant",
    value: new Uint8Array([]),
  }),
  "that does not read back": packedAsActivation(new Uint8Array([0xff, 0xff, 0xff])),
  // Field 99, a varint the command does not define.
  "that carries more than the command defines": packedAsActivation(
    new Uint8Array([
      ...toBinary(
        ActivateAccessGrantSchema,
        create(ActivateAccessGrantSchema, { id: { uuid: "grant-extra" } }),
      ),
      0x98,
      0x06,
      0x01,
    ]),
  ),
};

/** The grant whose access a planned command begins, when it begins access. */
export function activatedGrant(command: Any | undefined): string | undefined {
  return command === undefined
    ? undefined
    : AnyMessages.unpack(command, ActivateAccessGrantSchema)?.id?.uuid;
}

/** Posts `ScheduleCommand` planning a packed command when due, under a new plan. */
export function scheduleCommand(scope: BlackBoxScope, command: Any, due: Timestamp) {
  return scope.post(
    ScheduleCommandSchema,
    create(ScheduleCommandSchema, { id: { uuid: crypto.randomUUID() }, command, due }),
  );
}

/** Posts `ScheduleCommand` planning to begin a grant's access when due, under a new plan. */
export function scheduleActivation(scope: BlackBoxScope, grant: string, due: Timestamp) {
  return scheduleCommand(scope, packedActivation(grant), due);
}

/** Every planned command of the organization. */
export function readSchedules(reader: BlackBoxScope): Promise<Scheduling[]> {
  return readAll(reader, SchedulingSchema, "schedules");
}

/**
 * Waits until the plan to begin a grant's access satisfies the predicate,
 * and returns it.
 */
export async function awaitActivationPlan(
  box: BlackBox,
  reader: BlackBoxScope,
  grant: string,
  accept: (plan: Scheduling) => boolean = () => true,
): Promise<Scheduling> {
  const matches = (plan: Scheduling): boolean =>
    activatedGrant(plan.command) === grant && accept(plan);
  const plans = await box.eventually(
    () => readSchedules(reader),
    (rows) => rows.some(matches),
  );
  const found = plans.find(matches);
  if (found === undefined) {
    throw new Error(`No plan begins the access of grant "${grant}".`);
  }
  return found;
}
