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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import type { GrantCoverage } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/access_grant_pb.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "../../given/resources-context.js";
import { resourceUuid } from "../request/given/access-request.js";
import {
  awaitGrantIssued,
  createGrant,
  extendGrant,
  minutesIn,
  readCoverage,
  revokeGrant,
  seedGrantedResource,
  testClock,
} from "./given/access-grant.js";

// The projection is driven by posting the grant's own commands.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

/** Waits until one person's coverage of one resource satisfies the predicate. */
async function awaitCoverage(
  box: BlackBox,
  reader: BlackBoxScope,
  grantee: string,
  resource: string,
  accept: (coverage: GrantCoverage) => boolean,
): Promise<GrantCoverage> {
  const matches = (coverage: GrantCoverage): boolean =>
    coverage.id?.grantee?.uuid === grantee &&
    coverage.id.resource?.uuid === resource &&
    accept(coverage);
  const rows = await box.eventually(
    () => readCoverage(reader),
    (all) => all.some(matches),
  );
  const found = rows.find(matches);
  if (found === undefined) {
    throw new Error(`No coverage of "${resource}" for "${grantee}".`);
  }
  return found;
}

/** The identifiers of the grants in a coverage. */
function grantsOf(coverage: GrantCoverage): string[] {
  return coverage.grant.map((covering) => covering.id?.uuid ?? "");
}

describe("GrantCoverageProjection should", () => {
  it("cover a person's resource with an issued grant's level and period", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);

    await createGrant(scope, "grant-covered");

    const coverage = await awaitCoverage(
      box,
      scope,
      actor,
      resourceUuid,
      (c) => c.grant.length > 0,
    );
    expect(coverage.grant).toHaveLength(1);
    const [covering] = coverage.grant;
    expect(covering?.id?.uuid).toBe("grant-covered");
    expect(covering?.accessLevel?.rank).toBe(1);
    expect(covering?.start).toEqual(minutesIn(0));
    expect(covering?.end).toEqual(minutesIn(60));
  });

  it("keep each person's coverage of each resource apart", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);

    await createGrant(scope, "grant-mine");
    await createGrant(scope, "grant-theirs", {
      access: {
        grantee: { uuid: "colleague" },
        resource: { uuid: resourceUuid },
        accessLevel: { name: "Read", rank: 1 },
      },
    });
    await createGrant(scope, "grant-elsewhere", {
      access: {
        grantee: { uuid: actor },
        resource: { uuid: "vault" },
        accessLevel: { name: "Read", rank: 1 },
      },
    });

    const mine = await awaitCoverage(box, scope, actor, resourceUuid, (c) => c.grant.length > 0);
    const theirs = await awaitCoverage(
      box,
      scope,
      "colleague",
      resourceUuid,
      (c) => c.grant.length > 0,
    );
    const elsewhere = await awaitCoverage(box, scope, actor, "vault", (c) => c.grant.length > 0);
    expect(grantsOf(mine)).toEqual(["grant-mine"]);
    expect(grantsOf(theirs)).toEqual(["grant-theirs"]);
    expect(grantsOf(elsewhere)).toEqual(["grant-elsewhere"]);
  });

  it("move the end of an extended grant", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await seedGrantedResource(box);
    await createGrant(scope, "grant-longer");
    await awaitGrantIssued(box, scope, "grant-longer");

    await extendGrant(scope, "grant-longer", "ext-longer", minutesIn(90));

    const coverage = await awaitCoverage(
      box,
      scope,
      actor,
      resourceUuid,
      (c) => c.grant[0]?.end?.seconds === minutesIn(90).seconds,
    );
    expect(coverage.grant[0]?.start).toEqual(minutesIn(0));
  });

  it("stop covering access once it is revoked", async () => {
    const box = await resourcesBlackBox(testClock());
    const scope = box.onBehalfOf(actor);
    await createGrant(scope, "grant-withdrawn");
    await awaitGrantIssued(box, scope, "grant-withdrawn");

    await revokeGrant(scope, "grant-withdrawn", "primary", "No longer needed.");

    await awaitCoverage(box, scope, actor, resourceUuid, (c) => c.grant.length === 0);
  });
});
