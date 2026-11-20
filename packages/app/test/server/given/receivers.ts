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

import { create, type Message } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { StringValueSchema, type Any } from "@bufbuild/protobuf/wkt";
import { AnyPacker, TypeUrls } from "@spine-event-engine/core";
import type { ShardIndex } from "@spine-event-engine/server";
import {
  MembershipSchema,
  MembershipViewSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import {
  ExternalIdentitySchema,
  ExternalIdentityViewSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/external_identity_pb.js";
import { PersonEmailSchema } from "@access-desk/identity-model/generated/accessdesk/identity/person/person_email_pb.js";
import {
  PersonSchema,
  PersonViewSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/person/person_pb.js";
import {
  AccessGrantViewSchema,
  ResourceAccessSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/resource_access_pb.js";
import {
  AccessDecisionAssignmentSchema,
  AccessRequestSchema,
  AccessRequestViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import { AuditEntrySchema } from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
import {
  OrganizationSchema,
  OrganizationViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { ResourceRegistrationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_pb.js";
import {
  ResourceCatalogItemSchema,
  ResourceSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";

type StrategyModule = typeof import("../../../dist/src/server/delivery-strategy.js");
const { AccessDeskDeliveryStrategy }: StrategyModule =
  await import("../../../dist/src/server/delivery-strategy.js");

/** The strategy under test. */
export const STRATEGY = AccessDeskDeliveryStrategy;

/** The receivers of the Identity range: those people sign in through. */
export const IDENTITY = [
  ExternalIdentitySchema,
  ExternalIdentityViewSchema,
  PersonEmailSchema,
  PersonSchema,
  PersonViewSchema,
  MembershipViewSchema,
];

/** The receiver of the Identity memberships range: the membership of an email address. */
export const IDENTITY_MEMBERSHIPS = [MembershipSchema];

/** The receivers of the Resources range: the organizations, and what they hold. */
export const RESOURCES = [
  OrganizationSchema,
  ResourceRegistrationSchema,
  ResourceSchema,
  AccessRequestSchema,
  ResourceAccessSchema,
];

/** The receivers of the Resources views range: the views of the Resources bounded context. */
export const RESOURCES_VIEWS = [
  OrganizationViewSchema,
  ResourceCatalogItemSchema,
  AccessRequestViewSchema,
  AccessDecisionAssignmentSchema,
  AccessGrantViewSchema,
  AuditEntrySchema,
];

/** The number of receivers of each kind the tests place, to see where all of them go. */
const RECEIVERS = 300;

/**
 * Builds the identifier of a receiver, packed as the strategy takes it.
 *
 * @param value The identifier's text.
 */
export function receiverId(value: string): Any {
  return AnyPacker.pack(StringValueSchema, create(StringValueSchema, { value }));
}

/**
 * Places many receivers of some kinds in their shards.
 *
 * @param kinds The kinds of receiver, by their state.
 * @returns The shard of every receiver placed.
 */
export function placed(kinds: readonly GenMessage<Message>[]): ShardIndex[] {
  return kinds.flatMap((kind) =>
    Array.from({ length: RECEIVERS }, (_, receiver) =>
      STRATEGY.shardFor(receiverId(`receiver-${receiver.toString()}`), TypeUrls.derive(kind)),
    ),
  );
}

/**
 * Finds the shards the receivers of some kinds go to.
 *
 * @param kinds The kinds of receiver, by their state.
 * @returns The index of every shard any of them went to.
 */
export function shardsOf(kinds: readonly GenMessage<Message>[]): Set<number> {
  return new Set(placed(kinds).map((shard) => shard.index));
}
