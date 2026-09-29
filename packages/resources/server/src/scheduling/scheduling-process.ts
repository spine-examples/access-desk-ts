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
import type { Any } from "@bufbuild/protobuf/wkt";
import { AnyMessages, type MessageSchema } from "@spine-event-engine/core";
import { Assign, ProcessManager } from "@spine-event-engine/server";
import type { ScheduledCommandId } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { SchedulingSchema } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/scheduling_pb.js";
import type { ScheduleCommand } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/commands_pb.js";
import {
  CommandScheduledSchema,
  type CommandScheduled,
} from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/events_pb.js";
import { SchedulableCommand } from "@access-desk/resources-model/generated/interfaces/schedulable-command.js";
import { typeRegistry } from "../../generated/model-registry.js";

/**
 * One command an organization plans to run at a set time.
 *
 * Only a command declared schedulable is planned, for a due time.
 */
export class SchedulingProcessManager extends ProcessManager<
  ScheduledCommandId,
  typeof SchedulingSchema
> {
  /** Plans the command for its due time. */
  @Assign
  scheduleCommand(command: ScheduleCommand): CommandScheduled {
    if (this.state.command !== undefined) {
      throw new Error("A command is planned once under its plan.");
    }
    const due = command.due;
    const packed = command.command;
    if (packed === undefined || due === undefined || !isSchedulable(packed)) {
      throw new Error("Only a schedulable command, due at a set time, can be planned.");
    }
    this.update((draft) => {
      Object.assign(draft, create(SchedulingSchema, { id: this.id, command: packed, due }));
    });
    return create(CommandScheduledSchema, { id: this.id, command: packed, due });
  }
}

/** The commands declared schedulable. */
const schedulableCommands = new Set<MessageSchema>(SchedulableCommand.schemas);

/**
 * Whether a packed command may be planned.
 *
 * It may when all of the following hold:
 *
 * 1. It is of a known kind declared as a `SchedulableCommand`.
 * 2. It reads back completely, with nothing its kind does not define.
 */
function isSchedulable(packed: Any): boolean {
  const known = typeRegistry.findByTypeUrl(packed.typeUrl);
  if (known === undefined || !schedulableCommands.has(known.schema)) {
    return false;
  }
  try {
    const command = AnyMessages.unpack(packed, known.schema);
    return command !== undefined && (command.$unknown?.length ?? 0) === 0;
  } catch {
    return false;
  }
}
