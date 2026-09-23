/*
 * Copyright 2026, TeamDev. All rights reserved.
 * Licensed under the Apache License, Version 2.0.
 */

import { type BlackBoxScope } from "@spine-event-engine/testing";
import {
  AccessDecisionAssignmentSchema,
  type AccessDecisionAssignment,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";

import { readAll } from "../../../given/resources-context.js";

/** Every manager's decision queue in the organization. */
export function readAssignments(reader: BlackBoxScope): Promise<AccessDecisionAssignment[]> {
  return readAll(reader, AccessDecisionAssignmentSchema, "assignments");
}

/** The request ids currently in one manager's decision queue. */
export async function decisionTasks(
  reader: BlackBoxScope,
  manager: string,
): Promise<readonly string[]> {
  const rows = await readAssignments(reader);
  return (rows.find((row) => row.id?.uuid === manager)?.task ?? []).map(
    (task) => task.request?.uuid ?? "",
  );
}

/** Whether a request is currently in one manager's decision queue. */
export async function managerHasTask(
  reader: BlackBoxScope,
  manager: string,
  id: string,
): Promise<boolean> {
  return (await decisionTasks(reader, manager)).includes(id);
}
