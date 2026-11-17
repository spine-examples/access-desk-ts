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

import { TypeUrls } from "@spine-event-engine/core";
import { describe, expect, it } from "vitest";
import { OrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";

import {
  MEMBERSHIPS,
  ORGANIZATIONS,
  PEOPLE,
  STRATEGY,
  VIEWS,
  placed,
  receiverId,
  shardsOf,
} from "./given/receivers.js";

describe("The shards of Access Desk should", () => {
  it("give people and memberships one shard each, and organizations and views three each", () => {
    expect(STRATEGY.shardCount).toBe(8);
    expect(
      placed([...PEOPLE, ...MEMBERSHIPS, ...ORGANIZATIONS, ...VIEWS]).every(
        (shard) => shard.ofTotal === 8,
      ),
    ).toBe(true);
    expect(shardsOf(PEOPLE).size).toBe(1);
    expect(shardsOf(MEMBERSHIPS).size).toBe(1);
    expect(shardsOf(ORGANIZATIONS).size).toBe(3);
    expect(shardsOf(VIEWS).size).toBe(3);
  });

  it("keep every range apart from the others", () => {
    const ranges = [PEOPLE, MEMBERSHIPS, ORGANIZATIONS, VIEWS].map(shardsOf);

    const all = ranges.flatMap((range) => [...range]);
    expect(new Set(all).size).toBe(all.length);
    expect(Math.max(...all)).toBe(STRATEGY.shardCount - 1);
  });

  it("put a receiver in the same shard each time", () => {
    const id = receiverId("acme");
    const type = TypeUrls.derive(OrganizationSchema);

    const first = STRATEGY.shardFor(id, type);
    expect(STRATEGY.shardFor(id, type).key()).toBe(first.key());
  });
});
