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

import type { Any } from "@bufbuild/protobuf/wkt";
import { TypeUrls } from "@spine-event-engine/core";
import {
  ShardIndex,
  UniformAcrossAllShards,
  type DeliveryStrategy,
} from "@spine-event-engine/server";
import { MembershipSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { AccessGrantViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/resource_access_pb.js";
import {
  AccessDecisionAssignmentSchema,
  AccessRequestViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import { AuditEntrySchema } from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";

/**
 * The number of workers of the application server.
 *
 * A worker takes one shard at a time. While Identity adds a person to an
 * organization, its worker waits until the organization confirms, and another
 * worker handles the confirmation, so there must be at least two. Three
 * workers and the delivery server suit four CPUs.
 * The organizations and views ranges have a shard for each worker.
 */
export const WORKERS = 3;

/** The part every type URL of an Identity receiver contains. */
const IDENTITY = "/accessdesk.identity.";

/** The type URL of Identity's membership of an email address. */
const MEMBERSHIP = TypeUrls.derive(MembershipSchema);

/** The type URLs of the views of the Resources bounded context. */
const RESOURCES_VIEWS: ReadonlySet<string> = new Set(
  [
    OrganizationViewSchema,
    ResourceCatalogItemSchema,
    AccessRequestViewSchema,
    AccessDecisionAssignmentSchema,
    AccessGrantViewSchema,
    AuditEntrySchema,
  ].map((schema) => TypeUrls.derive(schema)),
);

/** A range of shards shared by a group of receivers. */
class ShardRange {
  /** The first shard of the range. */
  readonly first: number;
  /** Spreads the receivers over the range, each always to the same shard. */
  readonly #spread: UniformAcrossAllShards;

  constructor(first: number, count: number) {
    this.first = first;
    this.#spread = UniformAcrossAllShards.forNumber(count);
  }

  /** The number of shards in the range. */
  get count(): number {
    return this.#spread.shardCount;
  }

  /** The shard right after the range. */
  get next(): number {
    return this.first + this.count;
  }

  /** Finds the shard of a receiver within the range. */
  shardOf(targetId: Any, targetType: string, shardCount: number): ShardIndex {
    const within = this.#spread.shardFor(targetId, targetType);
    return new ShardIndex(this.first + within.index, shardCount);
  }
}

/**
 * Identity's people, the accounts they sign in with, their email addresses,
 * and Identity's views.
 *
 * People sign in here, so nothing in this range waits for another shard.
 */
const PEOPLE = new ShardRange(0, 1);

/**
 * Identity's memberships of email addresses.
 *
 * Adding a person to an organization holds the shard until the organization
 * confirms, which can take seconds. A range of its own keeps sign-ins from
 * waiting behind it. With one shard, at most one worker waits at a time, and
 * the others are free to handle the organization's confirmation.
 */
const MEMBERSHIPS = new ShardRange(PEOPLE.next, 1);

/**
 * The organizations of the Resources bounded context, with their members,
 * resources, access requests, and the access people hold.
 *
 * Nearly all the work of the application is here and in the views. Each of
 * these two ranges has a shard for every worker, so all workers can be busy
 * whichever range has messages at the moment.
 */
const ORGANIZATIONS = new ShardRange(MEMBERSHIPS.next, WORKERS);

/**
 * The views of the Resources bounded context, with the audit trail.
 *
 * In a range of their own, the views catch up without holding up the
 * organizations.
 */
const VIEWS = new ShardRange(ORGANIZATIONS.next, WORKERS);

/** The number of shards in all ranges. */
const SHARD_COUNT = VIEWS.next;

/**
 * The shards the messages of Access Desk are delivered in.
 *
 * The messages of one shard are delivered one after another, and a worker
 * takes one shard at a time. The receivers are grouped by how their work goes,
 * and each group has its own range of shards:
 *
 * 1. Identity's people: one shard.
 * 2. Identity's memberships: one shard.
 * 3. The organizations of the Resources bounded context: three shards.
 * 4. The views of the Resources bounded context: three shards.
 *
 * The last two ranges have a shard for each of the `WORKERS` of the
 * application server.
 *
 * Within a range, a receiver always goes to the same shard. Every process
 * that shares the delivery server must split the messages the same way, and
 * the split must not change while messages wait.
 */
export const AccessDeskDeliveryStrategy: DeliveryStrategy = {
  shardCount: SHARD_COUNT,

  shardFor(targetId: Any, targetType: string): ShardIndex {
    return rangeOf(targetType).shardOf(targetId, targetType, SHARD_COUNT);
  },
};

/** Finds the range of a receiver, by the type of its state. */
function rangeOf(targetType: string): ShardRange {
  if (targetType === MEMBERSHIP) {
    return MEMBERSHIPS;
  }
  if (targetType.includes(IDENTITY)) {
    return PEOPLE;
  }
  return RESOURCES_VIEWS.has(targetType) ? VIEWS : ORGANIZATIONS;
}
