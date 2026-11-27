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
import type { Any } from "@bufbuild/protobuf/wkt";
import type { Subscription } from "@spine-event-engine/client-node";
import { AnyPacker } from "@spine-event-engine/core";
import type { Memberships } from "@access-desk/resources-server";
import {
  MembershipIdSchema,
  type MembershipId,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  ClaimMemberSchema,
  type ClaimMember,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import {
  MemberClaimedSchema,
  type MemberClaimed,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/events_pb.js";
import {
  MembershipViewSchema,
  type MembershipView,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import {
  MemberAlreadyClaimedSchema,
  MemberClaimedByOtherOrganizationSchema,
  type MemberClaimedByOtherOrganization,
} from "@access-desk/identity-model/generated/accessdesk/identity/membership/rejections_pb.js";
import { PATIENCE_MS, ServerConnection, ServerRequests, type ServerRequest } from "./client.js";
import { BackoffType, Retry } from "../retry.js";

/** The name under which the application itself acts. */
const SYSTEM = "access-desk";

/** The delay before claiming the person a second time, after a claim found no answer. */
const FIRST_DELAY_MS = 500;

/** The answer to a claim: the person claimed, or the claim of another organization. */
type ClaimAnswer = MemberClaimed | MemberClaimedByOtherOrganization;

/** The memberships, with the connection that reaches them. */
export interface ReachedMemberships extends Memberships {
  /** Closes the connection to the memberships. */
  close(): Promise<void>;
}

/** Creates the memberships, as an organization reaches them. */
export const ReachedMemberships = {
  /**
   * Reaches the memberships through the application server.
   *
   * People belong to no organization, and the Identity bounded context keeps
   * them apart from every tenant. So an organization claims a person as a
   * member the way any client of the server would:
   *
   * 1. It subscribes to the membership of the person's address, and posts the
   *    claim to the Identity bounded context, subscribed to its rejections.
   * 2. When another organization claimed the person or is claiming them, it
   *    answers with that rejection.
   * 3. When this organization claimed the person already, it reads the
   *    membership, which names them once that claim is finished.
   * 4. Otherwise, it waits until the membership names the person.
   * 5. When the server is not reached, or nothing answers in time, it claims
   *    the person again after a pause that doubles each time, while the
   *    patience lasts.
   *
   * @param server Returns the address of the application server, once it listens.
   * @param patienceMs The time to wait for the claim, every attempt included.
   *   Ten seconds when left out.
   * @returns The memberships, as the Resources bounded context claims them.
   */
  through(server: () => string, patienceMs: number = PATIENCE_MS): ReachedMemberships {
    const connection = new ServerConnection(server);
    return {
      async claim(command: ClaimMember): Promise<ClaimAnswer> {
        const { id, organization } = command;
        const address = id?.emailAddress?.value;
        if (id === undefined || address === undefined || organization === undefined) {
          throw new Error("The claim command names no email address or no organization.");
        }
        const retried = await Retry.execute(
          { backoffType: BackoffType.EXPONENTIAL, delayMs: FIRST_DELAY_MS, timeoutMs: patienceMs },
          (left) => claimOnce(connection.in().onBehalfOf(SYSTEM), command, id, left),
        );
        if (retried.kind === "succeeded") {
          return retried.result;
        }
        throw new Error(
          `The Identity bounded context did not claim the person under ${address} as 
          a member of ${organization.value} in time.`,
          { cause: retried.lastError },
        );
      },
      close: async () => {
        await connection.close().catch(() => undefined);
      },
    };
  },
};

/**
 * Claims a person as a member once, and waits for the answer.
 */
async function claimOnce(
  request: ServerRequest,
  command: ClaimMember,
  id: MembershipId,
  patienceMs: number,
): Promise<ClaimAnswer | undefined> {
  const answered = Promise.withResolvers<ClaimAnswer | undefined>();
  const timer = setTimeout(() => {
    answered.resolve(undefined);
  }, patienceMs);
  let membership: Subscription | undefined;
  let claim: Subscription | undefined;
  try {
    membership = await ServerRequests.subscribeTo(
      request,
      MembershipViewSchema,
      MembershipIdSchema,
      id,
      (view) => {
        const claimed = claimedIn(view, command);
        if (claimed !== undefined) {
          answered.resolve(claimed);
        }
      },
    );
    claim = await ServerRequests.postAndSubscribe(
      request,
      ClaimMemberSchema,
      command,
      [MemberClaimedByOtherOrganizationSchema, MemberAlreadyClaimedSchema],
      (rejection) => {
        void answerOf(request, command, id, rejection).then(
          (answer) => {
            if (answer !== undefined) {
              answered.resolve(answer);
            }
          },
          () => undefined,
        );
      },
    );
    return claim === undefined ? undefined : await answered.promise;
  } finally {
    clearTimeout(timer);
    await claim?.cancel();
    await membership?.cancel();
  }
}

/**
 * Finds the person a membership names for the organization that claims them.
 */
function claimedIn(view: MembershipView, command: ClaimMember): MemberClaimed | undefined {
  const { id, organization } = command;
  return view.organization?.value === organization?.value && view.person !== undefined
    ? create(MemberClaimedSchema, { id, person: view.person, organization })
    : undefined;
}

/**
 * Answers a claim the Identity bounded context rejected.
 *
 * The claim of another organization is the answer itself. When the same
 * organization claimed the person before, the membership answers, once it
 * names them.
 */
async function answerOf(
  request: ServerRequest,
  command: ClaimMember,
  id: MembershipId,
  rejection: Any,
): Promise<ClaimAnswer | undefined> {
  const taken = AnyPacker.tryUnpack(rejection, MemberClaimedByOtherOrganizationSchema);
  if (taken !== undefined) {
    return taken;
  }
  if (AnyPacker.tryUnpack(rejection, MemberAlreadyClaimedSchema) === undefined) {
    return undefined;
  }
  const read = await ServerRequests.readById(request, MembershipViewSchema, MembershipIdSchema, id);
  return read === undefined ? undefined : claimedIn(read, command);
}
