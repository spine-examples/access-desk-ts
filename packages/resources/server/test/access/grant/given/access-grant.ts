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

import { create, type MessageShape } from "@bufbuild/protobuf";
import { type Timestamp, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { ResourceIdSchema } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import {
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
  RevokeAccessGrantSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessGrantViewSchema,
  GrantCoverageSchema,
  type AccessGrantView,
  type GrantCoverage,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";

import { actor, readAll, readWhere } from "../../../given/resources-context.js";
import { ManualClock } from "../../../given/manual-clock.js";
import {
  approveAccessRequest,
  resourceUuid,
  seed,
  submitAndAssign,
} from "../../request/given/access-request.js";
import type { ResourceDraft } from "../../../resource/given/resource.js";

/** The moment every grant test starts at, on a whole minute. */
export const startOfTest = new Date("2030-01-01T10:00:00Z");

/** A clock stopped at {@link startOfTest}. */
export function testClock(): ManualClock {
  return new ManualClock(startOfTest);
}

/** The time a number of minutes after {@link startOfTest}. */
export function minutesIn(minutes: number): Timestamp {
  return timestampFromDate(new Date(startOfTest.getTime() + minutes * 60_000));
}

/**
 * Builds a `CreateAccessGrant` issuing the requester read access to the payroll
 * resource for the first hour of the test, revocable by `primary`.
 */
export function createGrantCommand(
  id: string,
  overrides: Record<string, unknown> = {},
): MessageShape<typeof CreateAccessGrantSchema> {
  return create(CreateAccessGrantSchema, {
    id: { uuid: id },
    request: { uuid: id },
    access: {
      grantee: { uuid: actor },
      resource: { uuid: resourceUuid },
      accessLevel: { name: "Read", rank: 1 },
    },
    start: minutesIn(0),
    end: minutesIn(60),
    approvedBy: { uuid: "primary" },
    manager: [{ uuid: "primary" }],
    ...overrides,
  });
}

/**
 * Registers the payroll resource that {@link createGrantCommand} grants access to,
 * permitting two hours of access in total, so that its grants can be extended.
 */
export function seedGrantedResource(box: BlackBox): Promise<void> {
  return seed(box, [actor, "primary"], { policy: { maximumDuration: { seconds: 7200n } } });
}

/** Posts `CreateAccessGrant` directly, as the grant itself does on approval. */
export function createGrant(
  scope: BlackBoxScope,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return scope.post(CreateAccessGrantSchema, createGrantCommand(id, overrides));
}

/** Posts `RevokeAccessGrant` naming `manager` as the revoking person. */
export function revokeGrant(scope: BlackBoxScope, id: string, manager: string, reason: string) {
  return scope.post(
    RevokeAccessGrantSchema,
    create(RevokeAccessGrantSchema, { id: { uuid: id }, manager: { uuid: manager }, reason }),
  );
}

/** Posts `ExtendAccessGrant` moving the grant's end as the named request approved. */
export function extendGrant(scope: BlackBoxScope, id: string, request: string, end: Timestamp) {
  return scope.post(
    ExtendAccessGrantSchema,
    create(ExtendAccessGrantSchema, { id: { uuid: id }, request: { uuid: request }, end }),
  );
}

/** The grants a person holds, through the access query by grantee. */
export function readAccessHeldBy(
  reader: BlackBoxScope,
  grantee: string = actor,
): Promise<AccessGrantView[]> {
  return readWhere(
    reader,
    AccessGrantViewSchema,
    `access-held-by-${grantee}`,
    "grantee",
    PersonIdSchema,
    create(PersonIdSchema, { uuid: grantee }),
  );
}

/** The access granted to a resource, through the access query by resource. */
export function readAccessTo(
  reader: BlackBoxScope,
  resource: string = resourceUuid,
): Promise<AccessGrantView[]> {
  return readWhere(
    reader,
    AccessGrantViewSchema,
    `access-to-${resource}`,
    "resource",
    ResourceIdSchema,
    create(ResourceIdSchema, { uuid: resource }),
  );
}

/** Every person's coverage of every resource. */
export function readCoverage(reader: BlackBoxScope): Promise<GrantCoverage[]> {
  return readAll(reader, GrantCoverageSchema, "grant-coverage");
}

/** Waits until the requester's view of a grant satisfies the predicate, and returns it. */
export async function awaitGrantView(
  box: BlackBox,
  reader: BlackBoxScope,
  grant: string,
  accept: (item: AccessGrantView) => boolean,
): Promise<AccessGrantView> {
  const matches = (item: AccessGrantView): boolean => item.id?.uuid === grant && accept(item);
  const items = await box.eventually(
    () => readAccessHeldBy(reader),
    (rows) => rows.some(matches),
  );
  const found = items.find(matches);
  if (found === undefined) {
    throw new Error(`Access grant view "${grant}" not found.`);
  }
  return found;
}

/** Waits until the requester's view lists the grant, and returns it. */
export function awaitGrantIssued(
  box: BlackBox,
  reader: BlackBoxScope,
  grant: string,
): Promise<AccessGrantView> {
  return awaitGrantView(box, reader, grant, () => true);
}

/** Waits until the requester's view shows the grant as revoked, and returns it. */
export function awaitGrantRevoked(
  box: BlackBox,
  reader: BlackBoxScope,
  grant: string,
): Promise<AccessGrantView> {
  return awaitGrantView(box, reader, grant, (item) => item.revoked);
}

/**
 * Seeds the payroll resource, then has the requester ask for immediate access
 * and `primary` approve it, and waits until the grant is issued. Immediate
 * access begins at the approval, so the grant confers access at once.
 *
 * The grant shares its identifier with the request.
 *
 * @param box The BlackBox to drive.
 * @param request The request, and so the grant, identifier.
 * @param minutes How long the requested access lasts.
 * @param policy Overrides of the resource's policy.
 * @returns The requester's scope.
 */
export async function givenActiveGrant(
  box: BlackBox,
  request: string,
  minutes = 10,
  policy: Partial<ResourceDraft> = {},
): Promise<BlackBoxScope> {
  const requester = box.onBehalfOf(actor);
  await seed(box, [actor, "primary"], { policy });
  await submitAndAssign(box, requester, request, "primary", {
    period: { kind: { case: "immediateDuration", value: { seconds: BigInt(minutes * 60) } } },
  });
  await approveAccessRequest(requester, request, "primary");
  await awaitGrantIssued(box, requester, request);
  return requester;
}
