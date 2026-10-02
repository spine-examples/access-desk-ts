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
import { type Timestamp, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { ResourceIdSchema } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { SubmitAccessExtensionRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  CreateAccessGrantSchema,
  ExtendAccessGrantSchema,
  RevokeAccessGrantSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/commands_pb.js";
import {
  AccessGrantViewSchema,
  type AccessGrantView,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";

import { actor, readWhere } from "../../../given/resources-context.js";
import { ManualClock } from "../../../given/manual-clock.js";
import {
  approveAccessRequest,
  resourceUuid,
  seed,
  submitAndAssign,
  submitExtensionRequest,
} from "../../request/given/access-request.js";
import { managerHasTask } from "../../request/given/access-decision-assignment.js";
import {
  awaitCatalogItem,
  createResource,
  openResource,
  type ResourceDraft,
} from "../../../resource/given/resource.js";

/** The requester's access to the payroll resource, which holds the grants these tests issue. */
const requesterAccess = { grantee: { uuid: actor }, resource: { uuid: resourceUuid } };

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

/** The longest access, in total, the resources granted in these tests permit. */
const maximumDuration = { seconds: 7200n };

/**
 * Registers the payroll resource, managed by `primary` and permitting two hours
 * of access in total, so that its grants can be extended.
 */
export function seedGrantedResource(box: BlackBox): Promise<void> {
  return seed(box, [actor, "primary"], { policy: { maximumDuration } });
}

/**
 * Registers one more resource, open for requests, managed by `primary` and
 * permitting two hours of access in total.
 *
 * Call it after {@link seedGrantedResource}, which creates the organization.
 */
export async function seedOtherResource(box: BlackBox, resource: string): Promise<void> {
  const scope = box.onBehalfOf(actor);
  await createResource(scope, resource, {
    name: resource,
    manager: [{ uuid: "primary" }],
    maximumDuration,
  });
  await openResource(scope, resource);
  await awaitCatalogItem(box, scope, resource, (item) => item.policy?.openForRequests ?? false);
}

/** Who is granted access to what, and over which minutes of the test. */
export interface GrantDraft {
  readonly grantee?: string;
  readonly resource?: string;
  readonly start?: number;
  readonly end?: number;
}

/**
 * Has the grantee ask for read access over an interval, and `primary` approve
 * it at once, which issues a grant with the same identifier as the request.
 *
 * The grantee reads the payroll resource over the first hour of the test by
 * default. The clock must not have passed the start of the interval, so that
 * the grant keeps it.
 *
 * @param box The BlackBox to drive.
 * @param request The request, and so the grant, identifier.
 * @param draft Who is granted access to what, and when.
 */
export async function issueGrant(
  box: BlackBox,
  request: string,
  { grantee = actor, resource = resourceUuid, start = 0, end = 60 }: GrantDraft = {},
): Promise<void> {
  await submitAndAssign(box, box.onBehalfOf(grantee), request, "primary", {
    requester: { uuid: grantee },
    resource: { uuid: resource },
    period: {
      kind: { case: "scheduled", value: { start: minutesIn(start), end: minutesIn(end) } },
    },
  });
  await approveAccessRequest(box, request, "primary");
}

/**
 * Has the requester ask to extend the grant by some minutes, and `primary`
 * approve it.
 */
export async function approveExtension(
  box: BlackBox,
  request: string,
  grant: string,
  minutes: number,
): Promise<void> {
  const requester = box.onBehalfOf(actor);
  await requester.post(
    SubmitAccessExtensionRequestSchema,
    submitExtensionRequest(request, {
      grant: { uuid: grant },
      duration: { seconds: BigInt(minutes * 60) },
    }),
  );
  await box.eventually(
    () => managerHasTask(requester, "primary", request),
    (present) => present,
  );
  await approveAccessRequest(box, request, "primary");
}

/** Posts `RevokeAccessGrant` on behalf of `manager`, naming them as the revoking person. */
export function revokeGrant(box: BlackBox, id: string, manager: string, reason: string) {
  return box.onBehalfOf(manager).post(
    RevokeAccessGrantSchema,
    create(RevokeAccessGrantSchema, {
      id: requesterAccess,
      grant: { uuid: id },
      manager: { uuid: manager },
      reason,
    }),
  );
}

/**
 * Posts `CreateAccessGrant` directly, as an approved first-time request does,
 * for read access over `[start, end)` minutes into the test.
 */
export function postCreateAccessGrant(
  scope: BlackBoxScope,
  id: string,
  start: number,
  end: number,
) {
  return scope.post(
    CreateAccessGrantSchema,
    create(CreateAccessGrantSchema, {
      id: requesterAccess,
      grant: { uuid: id },
      request: { uuid: id },
      accessLevel: { name: "Read", rank: 1 },
      start: minutesIn(start),
      end: minutesIn(end),
      manager: [{ uuid: "primary" }],
    }),
  );
}

/** Posts `ExtendAccessGrant` directly, as the grant itself does when an extension is approved. */
export function postExtendAccessGrant(
  scope: BlackBoxScope,
  id: string,
  request: string,
  end: Timestamp,
) {
  return scope.post(
    ExtendAccessGrantSchema,
    create(ExtendAccessGrantSchema, {
      id: requesterAccess,
      grant: { uuid: id },
      request: { uuid: request },
      end,
    }),
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
 * access begins at the approval, so the grant gives access at once.
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
  await approveAccessRequest(box, request, "primary");
  await awaitGrantIssued(box, requester, request);
  return requester;
}
