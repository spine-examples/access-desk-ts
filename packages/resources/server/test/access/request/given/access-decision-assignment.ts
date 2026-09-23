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
