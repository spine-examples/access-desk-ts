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
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import {
  AccessGrantCreatedSchema,
  AccessGrantExtendedSchema,
  AccessGrantRevokedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/events_pb.js";
import {
  SubmitAccessExtensionRequestSchema,
  SubmitAccessRequestSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  AccessExtensionRequestSubmissionFailedSchema,
  AccessExtensionRequestSubmittedSchema,
  AccessRequestApprovalFailedSchema,
  AccessRequestApprovalStartedSchema,
  AccessRequestCanceledSchema,
  AccessRequestDeniedSchema,
  AccessRequestSubmissionFailedSchema,
  AccessRequestSubmittedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/events_pb.js";
import { OrganizationMemberAddedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import {
  ResourceClosedForRequestsSchema,
  ResourceOpenedForRequestsSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/events_pb.js";
import {
  ResourceRegisteredSchema,
  ResourceRegistrationFailedSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_events_pb.js";
import {
  approveExtension,
  awaitGrantIssued,
  awaitGrantRevoked,
  givenActiveGrant,
  minutesIn,
  revokeGrant,
  testClock,
} from "../access/grant/given/resource-access.js";
import {
  approveAccessRequest,
  cancelAccessRequest,
  denyAccessRequest,
  resourceUuid,
  seed,
  submitAndAssign,
  submitExtensionRequest,
  submitRequest,
} from "../access/request/given/access-request.js";
import {
  actor,
  closeResourcesBlackBoxes,
  loadResourcesContext,
  resourcesBlackBox,
} from "../given/resources-context.js";
import { addOrganizationMember, createOrganization } from "../organization/given/organization.js";
import { closeResource, openResource, registerResource } from "../resource/given/resource.js";
import { awaitEntries, awaitEntry, factsOf, readHistoryOf } from "./given/audit-entry.js";

// The history is made of the facts the other flows record, produced here
// through the real commands of those flows.
beforeAll(loadResourcesContext, 30_000);
afterEach(closeResourcesBlackBoxes);

describe("AuditEntryProjection should", () => {
  it("on 'OrganizationMemberAdded' keep who became a member, and name the administrator who added them", async () => {
    const box = await resourcesBlackBox(testClock());
    const administrator = box.onBehalfOf("noah");
    await createOrganization(administrator);

    await addOrganizationMember(administrator, "maya", OrganizationRole.MEMBER, "noah");

    const { entry, fact } = await awaitEntry(box, administrator, OrganizationMemberAddedSchema);
    expect(fact.person?.uuid).toBe("maya");
    expect(entry.when).toEqual(minutesIn(0));
    expect(entry.actor?.uuid).toBe("noah");
    expect(entry.resource).toBeUndefined();
  });

  it("on 'ResourceRegistered' tell which resource was registered, and by whom", async () => {
    const box = await resourcesBlackBox(testClock());
    const administrator = box.onBehalfOf("noah");
    await createOrganization(administrator);

    await registerResource(administrator, "ledger");

    const { entry, fact } = await awaitEntry(box, administrator, ResourceRegisteredSchema);
    expect(fact.id?.uuid).toBe("ledger");
    expect(entry).toMatchObject({
      resource: { uuid: "ledger" },
      actor: { uuid: "noah" },
      when: minutesIn(0),
    });
  });

  it("on 'ResourceRegistrationFailed' tell which resource could not be registered, and who tried", async () => {
    const box = await resourcesBlackBox(testClock());
    const administrator = box.onBehalfOf("noah");
    await createOrganization(administrator);
    await registerResource(administrator, "ledger-1", "ledger");
    await awaitEntry(box, administrator, ResourceRegisteredSchema);

    // The organization holds a resource under that name already.
    await registerResource(administrator, "ledger-2", "ledger");

    const { entry, fact } = await awaitEntry(box, administrator, ResourceRegistrationFailedSchema);
    expect(fact.id?.uuid).toBe("ledger-2");
    expect(entry).toMatchObject({ resource: { uuid: "ledger-2" }, actor: { uuid: "noah" } });
  });

  it("on 'ResourceOpenedForRequests' and 'ResourceClosedForRequests' tell each opening and closing apart", async () => {
    const box = await resourcesBlackBox(testClock());
    const manager = box.onBehalfOf("primary");
    // Seeding opens the resource once.
    await seed(box, [actor, "primary"]);

    await closeResource(manager, resourceUuid);
    await awaitEntry(box, manager, ResourceClosedForRequestsSchema);
    await openResource(manager, resourceUuid);

    // The clock has not moved, and the two openings are still two entries.
    const opened = await awaitEntries(box, manager, ResourceOpenedForRequestsSchema, 2);
    expect(opened.map((entry) => entry.actor?.uuid).sort()).toEqual(["primary", actor].sort());
    expect(opened.every((entry) => entry.resource?.uuid === resourceUuid)).toBe(true);
    const closed = await awaitEntry(box, manager, ResourceClosedForRequestsSchema);
    expect(closed.entry).toMatchObject({
      resource: { uuid: resourceUuid },
      actor: { uuid: "primary" },
    });
  });

  it("on 'AccessRequestSubmitted' keep the request, and tell who asked for access to what", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);

    await submitAndAssign(box, requester, "audit-requested", "primary");

    const { entry, fact } = await awaitEntry(box, requester, AccessRequestSubmittedSchema);
    expect(fact.id?.uuid).toBe("audit-requested");
    expect(fact.snapshot?.justification).toBe("Need payroll review");
    expect(entry).toMatchObject({
      resource: { uuid: resourceUuid },
      actor: { uuid: actor },
      when: minutesIn(0),
    });
  });

  it("on 'AccessExtensionRequestSubmitted' keep the request, and tell who asked to extend access to what", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = await givenActiveGrant(box, "audit-grant", 10);

    await requester.post(
      SubmitAccessExtensionRequestSchema,
      submitExtensionRequest("audit-extension", { grant: { uuid: "audit-grant" } }),
    );

    const { entry, fact } = await awaitEntry(box, requester, AccessExtensionRequestSubmittedSchema);
    expect(fact.id?.uuid).toBe("audit-extension");
    expect(fact.snapshot?.justification).toBe("Keep payroll access a little longer");
    expect(entry).toMatchObject({ resource: { uuid: resourceUuid }, actor: { uuid: actor } });
  });

  it("on 'AccessRequestSubmissionFailed' tell whose request never reached a manager", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);

    // The resource lets nobody hold access for two hours.
    await requester.post(
      SubmitAccessRequestSchema,
      submitRequest("audit-too-long", {
        period: { kind: { case: "immediateDuration", value: { seconds: 7200n } } },
      }),
    );

    const { entry, fact } = await awaitEntry(box, requester, AccessRequestSubmissionFailedSchema);
    expect(fact.id?.uuid).toBe("audit-too-long");
    expect(entry.actor?.uuid).toBe(actor);
  });

  it("on 'AccessExtensionRequestSubmissionFailed' tell whose extension request never reached a manager", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);

    // Nobody holds the access the request asks to extend.
    await requester.post(
      SubmitAccessExtensionRequestSchema,
      submitExtensionRequest("audit-no-grant", { grant: { uuid: "no-such-grant" } }),
    );

    const { entry, fact } = await awaitEntry(
      box,
      requester,
      AccessExtensionRequestSubmissionFailedSchema,
    );
    expect(fact.id?.uuid).toBe("audit-no-grant");
    expect(entry.actor?.uuid).toBe(actor);
  });

  it("on 'AccessRequestApprovalStarted' tell which manager approved a request, and when", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "audit-approved", "primary");
    clock.advanceMinutes(5);

    await approveAccessRequest(box, "audit-approved", "primary");

    const { entry, fact } = await awaitEntry(box, requester, AccessRequestApprovalStartedSchema);
    expect(fact.id?.uuid).toBe("audit-approved");
    expect(entry).toMatchObject({
      resource: { uuid: resourceUuid },
      actor: { uuid: "primary" },
      when: minutesIn(5),
    });
  });

  it("on 'AccessRequestApprovalFailed' tell which approved request could not be granted", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = await givenActiveGrant(box, "audit-grant", 10);
    await requester.post(
      SubmitAccessExtensionRequestSchema,
      submitExtensionRequest("audit-late", { grant: { uuid: "audit-grant" } }),
    );
    await awaitEntry(box, requester, AccessExtensionRequestSubmittedSchema);
    // The access ends before the manager decides.
    clock.advanceMinutes(10);

    await approveAccessRequest(box, "audit-late", "primary");

    const { entry, fact } = await awaitEntry(box, requester, AccessRequestApprovalFailedSchema);
    expect(fact.id?.uuid).toBe("audit-late");
    expect(entry).toMatchObject({
      resource: { uuid: resourceUuid },
      actor: { uuid: "primary" },
      when: minutesIn(10),
    });
  });

  it("on 'AccessRequestDenied' keep the reason, and tell which manager denied a request, and when", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "audit-denied", "primary");
    clock.advanceMinutes(5);

    await denyAccessRequest(box, "audit-denied", "primary", "Insufficient justification.");

    const { entry, fact } = await awaitEntry(box, requester, AccessRequestDeniedSchema);
    expect(fact.id?.uuid).toBe("audit-denied");
    expect(fact.reason).toBe("Insufficient justification.");
    expect(entry).toMatchObject({
      resource: { uuid: resourceUuid },
      actor: { uuid: "primary" },
      when: minutesIn(5),
    });
  });

  it("on 'AccessRequestCanceled' tell that the requester canceled their request", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = box.onBehalfOf(actor);
    await seed(box, [actor, "primary"]);
    await submitAndAssign(box, requester, "audit-canceled", "primary");

    await cancelAccessRequest(requester, "audit-canceled");

    const { entry, fact } = await awaitEntry(box, requester, AccessRequestCanceledSchema);
    expect(fact.id?.uuid).toBe("audit-canceled");
    expect(entry).toMatchObject({ resource: { uuid: resourceUuid }, actor: { uuid: actor } });
  });

  it("on 'AccessGrantCreated' keep the grant, and tell by whose approval access was granted to what", async () => {
    const box = await resourcesBlackBox(testClock());

    const requester = await givenActiveGrant(box, "audit-grant", 10);

    const { entry, fact } = await awaitEntry(box, requester, AccessGrantCreatedSchema);
    expect(fact).toMatchObject({
      id: { uuid: "audit-grant" },
      request: { uuid: "audit-grant" },
      access: { grantee: { uuid: actor } },
    });
    expect(entry).toMatchObject({ resource: { uuid: resourceUuid }, actor: { uuid: "primary" } });
  });

  it("on 'AccessGrantExtended' keep the grant, and tell by whose approval access was extended", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = await givenActiveGrant(box, "audit-grant", 10);

    await approveExtension(box, "audit-extension", "audit-grant", 5);

    const { entry, fact } = await awaitEntry(box, requester, AccessGrantExtendedSchema);
    expect(fact).toMatchObject({
      id: { uuid: "audit-grant" },
      request: { uuid: "audit-extension" },
    });
    expect(entry).toMatchObject({ resource: { uuid: resourceUuid }, actor: { uuid: "primary" } });
  });

  it("on 'AccessGrantRevoked' keep the reason, and tell which manager revoked access, and when", async () => {
    const clock = testClock();
    const box = await resourcesBlackBox(clock);
    const requester = await givenActiveGrant(box, "audit-grant", 10);
    await awaitGrantIssued(box, requester, "audit-grant");
    clock.advanceMinutes(3);

    await revokeGrant(box, "audit-grant", "primary", "No longer on the project.");
    await awaitGrantRevoked(box, requester, "audit-grant");

    const { entry, fact } = await awaitEntry(box, requester, AccessGrantRevokedSchema);
    expect(fact).toMatchObject({
      id: { uuid: "audit-grant" },
      reason: "No longer on the project.",
    });
    expect(entry).toMatchObject({
      resource: { uuid: resourceUuid },
      actor: { uuid: "primary" },
      when: minutesIn(3),
    });
  });

  it("tell the history of one resource apart from everything else", async () => {
    const box = await resourcesBlackBox(testClock());
    const requester = await givenActiveGrant(box, "audit-grant", 10);
    await registerResource(requester, "ledger");
    await awaitEntry(box, requester, ResourceRegisteredSchema);

    const history = await readHistoryOf(requester, resourceUuid);

    // What happened to the payroll resource, and nothing of the members or of the ledger.
    expect(factsOf(history).sort()).toEqual(
      [
        "ResourceOpenedForRequests",
        "AccessRequestSubmitted",
        "AccessRequestApprovalStarted",
        "AccessGrantCreated",
      ].sort(),
    );
    expect(history.every((entry) => entry.resource?.uuid === resourceUuid)).toBe(true);
    expect(factsOf(await readHistoryOf(requester, "ledger"))).toEqual(["ResourceRegistered"]);
  });
});
