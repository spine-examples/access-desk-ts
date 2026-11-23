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
 * It is the best for a machine with four dedicated CPUs: three for the
 * application server, and one for the delivery server. A worker spends much
 * of its time waiting for PostgreSQL and the delivery server, so four workers
 * fit into three CPUs, and a fifth adds nothing.
 *
 * There must be at least two workers. While the Identity bounded context adds
 * a person to an organization, its worker waits until the organization
 * confirms, and only another worker can handle the confirmation.
 */
export const WORKERS = 4;

/** The part every type URL of a receiver of the Identity bounded context contains. */
const IDENTITY_TYPE_URL_PART = "/accessdesk.identity.";

/** The type URL of the membership of an email address in the Identity bounded context. */
const MEMBERSHIP_TYPE_URL = TypeUrls.derive(MembershipSchema);

/** The type URLs of the views of the Resources bounded context. */
const RESOURCES_VIEW_TYPE_URLS: ReadonlySet<string> = new Set(
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
 * The people of the Identity bounded context, the accounts they sign in with,
 * their email addresses, and the views of the context.
 *
 * People sign in here, so a sign-in does not depend on the work of the
 * organizations.
 */
const IDENTITY = new ShardRange(0, 1);

/**
 * The memberships of email addresses in the Identity bounded context.
 *
 * Adding a person waits for the organization to confirm, so the memberships
 * are kept apart and hold up no other receiver while they wait. With one
 * shard, at most one worker waits at a time, and the others are free to
 * handle the confirmation.
 */
const IDENTITY_MEMBERSHIPS = new ShardRange(IDENTITY.next, 1);

/**
 * The organizations of the Resources bounded context, with their members,
 * resources, access requests, and the access people hold: the aggregates and
 * processes of the context.
 *
 * The range has a shard for each worker, as Resources views do. Fewer shards
 * would leave workers idle, and more only cost CPU.
 */
const RESOURCES = new ShardRange(IDENTITY_MEMBERSHIPS.next, WORKERS);

/**
 * The views of the Resources bounded context, with the audit trail.
 *
 * In a range of their own, the views catch up without holding up the
 * organizations. The range has a shard for each worker, as Resources does.
 */
const RESOURCES_VIEWS = new ShardRange(RESOURCES.next, WORKERS);

/** The number of shards in all ranges. */
const SHARD_COUNT = RESOURCES_VIEWS.next;

/**
 * The shards the messages of Access Desk are delivered in.
 *
 * A shard is a group of receivers, such as aggregates and views, whose
 * messages are delivered one after another by one worker at a time. A receiver
 * always stays in the same shard, so it gets its messages in order. The
 * receivers are grouped into four ranges:
 *
 * 1. Identity: the people of the Identity bounded context, their accounts,
 *    email addresses, and views; one shard.
 * 2. Identity memberships: the memberships of email addresses; one shard.
 * 3. Resources: the organizations of the Resources bounded context, with
 *    their resources, access requests, and the access people hold; a shard
 *    for each of the `WORKERS`.
 * 4. Resources views: the views of the Resources bounded context, with the
 *    audit trail; a shard for each of the `WORKERS`.
 *
 * Every process that shares the delivery server must split the messages the
 * same way, and the split must not change while messages wait.
 */
export const AccessDeskDeliveryStrategy: DeliveryStrategy = {
  shardCount: SHARD_COUNT,

  shardFor(targetId: Any, targetType: string): ShardIndex {
    return rangeOf(targetType).shardOf(targetId, targetType, SHARD_COUNT);
  },
};

/** Finds the range of a receiver, by the type of its state. */
function rangeOf(targetType: string): ShardRange {
  if (targetType === MEMBERSHIP_TYPE_URL) {
    return IDENTITY_MEMBERSHIPS;
  }
  if (targetType.includes(IDENTITY_TYPE_URL_PART)) {
    return IDENTITY;
  }
  return RESOURCES_VIEW_TYPE_URLS.has(targetType) ? RESOURCES_VIEWS : RESOURCES;
}
