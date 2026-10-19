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
import type { BlackBox, BlackBoxScope } from "@spine-event-engine/testing";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  MembershipViewSchema,
  type MembershipView,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";

import { readAll } from "../../given/identity-context.js";

/** The organization the tests add people to, unless they name another. */
export const organizationId = "acme";

/**
 * Posts `AddMember` for the email address.
 *
 * @param scope Where to post the command.
 * @param email The email address of the person to add.
 * @param role The role the person is to hold. A member's when left out.
 * @param organization The organization to add them to. Acme when left out.
 * @param addedBy The administrator who adds them. Left out when the
 *   application adds them itself.
 */
export function addMember(
  scope: BlackBoxScope,
  email: string,
  role: OrganizationRole = OrganizationRole.MEMBER,
  organization: string = organizationId,
  addedBy?: string,
) {
  return scope.post(
    AddMemberSchema,
    create(AddMemberSchema, {
      id: { emailAddress: { value: email } },
      organization: { uuid: organization },
      role,
      ...(addedBy === undefined ? {} : { addedBy: { uuid: addedBy } }),
    }),
  );
}

/**
 * Waits until the membership of an email address is listed and passes a check,
 * and returns it.
 *
 * @param box The context under test.
 * @param scope Where to read from.
 * @param email The email address, in lower case.
 * @param accept What the membership must show. Anything when left out.
 */
export async function awaitMembership(
  box: BlackBox,
  scope: BlackBoxScope,
  email: string,
  accept: (view: MembershipView) => boolean = () => true,
): Promise<MembershipView> {
  const matches = (view: MembershipView): boolean =>
    view.id?.emailAddress?.value === email && accept(view);
  const memberships = await box.eventually(
    () => readAll(scope, MembershipViewSchema, "query-membership-view"),
    (rows) => rows.some(matches),
  );
  const found = memberships.find(matches);
  if (found === undefined) {
    throw new Error(`The membership of "${email}" is not listed.`);
  }
  return found;
}
