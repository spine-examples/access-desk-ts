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
import { VersionSchema, type Version } from "@spine-event-engine/proto";
import { describe, expect, it } from "vitest";
import {
  AccessRequestIdSchema,
  ResourceIdSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { ResourceOpenedForRequestsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import { ResourceRegisteredSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";

import { AuditEntryIds } from "../../src/audit/audit-entry-ids.js";

const payroll = AnyMessages.pack(ResourceIdSchema, create(ResourceIdSchema, { uuid: "payroll" }));

/** A version of what recorded an action, by its number. */
const version = (number: number): Version => create(VersionSchema, { number });

describe("AuditEntryIds should", () => {
  it("give the same action the same ID", () => {
    const first = AuditEntryIds.of(payroll, version(0), ResourceRegisteredSchema);
    const second = AuditEntryIds.of(payroll, version(0), ResourceRegisteredSchema);

    expect(second.uuid).toBe(first.uuid);
  });

  it("make the ID a version 5 UUID", () => {
    const id = AuditEntryIds.of(payroll, version(0), ResourceRegisteredSchema);

    expect(id.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("take only the number of the version", () => {
    const later = create(VersionSchema, { number: 0, timestamp: { seconds: 1_800_000_000n } });

    expect(AuditEntryIds.of(payroll, later, ResourceRegisteredSchema).uuid).toBe(
      AuditEntryIds.of(payroll, version(0), ResourceRegisteredSchema).uuid,
    );
  });

  it("give a different ID to any other action", () => {
    const id = AuditEntryIds.of(payroll, version(1), ResourceRegisteredSchema).uuid;
    const ledger = AnyMessages.pack(ResourceIdSchema, create(ResourceIdSchema, { uuid: "ledger" }));
    const request = AnyMessages.pack(
      AccessRequestIdSchema,
      create(AccessRequestIdSchema, { uuid: "payroll" }),
    );

    // Another thing that changed, another version of it, or another kind of action.
    const others = [
      AuditEntryIds.of(ledger, version(1), ResourceRegisteredSchema),
      AuditEntryIds.of(request, version(1), ResourceRegisteredSchema),
      AuditEntryIds.of(payroll, version(2), ResourceRegisteredSchema),
      AuditEntryIds.of(payroll, version(1), ResourceOpenedForRequestsSchema),
    ].map((other) => other.uuid);

    expect(new Set([id, ...others]).size).toBe(5);
  });
});
