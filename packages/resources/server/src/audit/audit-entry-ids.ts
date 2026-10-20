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

import { createHash } from "node:crypto";
import { create, type Message } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { Any } from "@bufbuild/protobuf/wkt";
import { TypeUrls } from "@spine-event-engine/core";
import type { Version } from "@spine-event-engine/proto";
import {
  AuditEntryIdSchema,
  type AuditEntryId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";

/**
 * The namespace of the IDs: a version 4 UUID made once for the audit trail of
 * Access Desk.
 *
 * Changing it changes every ID.
 */
const NAMESPACE = "f5c35638-fa55-49cb-811c-96f501697888";

/**
 * A name-based UUID in the namespace of the IDs, version 5 of RFC 9562.
 *
 * The same name always gives the same UUID.
 *
 * @param name The name within the namespace.
 * @returns The UUID, in its usual hyphenated form.
 */
function nameBasedUuid(name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(NAMESPACE.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  // The version, 5, and the variant of RFC 9562.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Makes the IDs of the entries of an organization's audit trail.
 *
 * An entry's ID is a name-based UUID, version 5 of RFC 9562. It is computed
 * from what recorded the action, the version of it, and the type of the event
 * that records the action. So the same action always gets the same ID.
 */
export const AuditEntryIds = {
  /**
   * The ID of the entry for one action.
   *
   * @param producer What recorded the action.
   * @param version The version of what recorded the action.
   * @param eventType The type of the event that records the action.
   * @returns The ID.
   */
  of(producer: Any, version: Version, eventType: GenMessage<Message>): AuditEntryId {
    const name = [
      producer.typeUrl,
      Buffer.from(producer.value).toString("hex"),
      version.number.toString(),
      TypeUrls.derive(eventType),
    ].join("\n");
    return create(AuditEntryIdSchema, { uuid: nameBasedUuid(name) });
  },
};
