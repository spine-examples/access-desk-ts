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
import type { AuthenticatedPrincipal, IncomingRequest } from "@spine-event-engine/auth";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { Filter_Operator, TargetSchema } from "@spine-event-engine/proto/client";
import { describe, expect, it, vi } from "vitest";
import { OrganizationRole } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import { AddMemberSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/commands_pb.js";
import { MembershipViewSchema } from "@access-desk/identity-model/generated/accessdesk/identity/membership/membership_pb.js";
import {
  OrganizationIdSchema,
  PersonIdSchema,
} from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { AccessGrantViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/resource_access_pb.js";
import {
  AccessDecisionAssignmentSchema,
  AccessRequestViewSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import { AuditEntrySchema } from "@access-desk/resources-model/generated/accessdesk/resources/audit/audit_entry_pb.js";
import { ResourceIdSchema } from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import { AddOrganizationMemberSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { CancelAccessRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import { OpenResourceForRequestsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/commands_pb.js";
import { OrganizationMemberSchema } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";
import type { AccessDesk } from "../../src/gateway/access-desk.js";
import { Policy } from "../../src/gateway/policy.js";

const principal: AuthenticatedPrincipal = {
  id: "person-1",
  attributes: { email: "maya@example.com", name: "Maya", organization: "acme" },
};

function command(message: Message, messageType = ""): IncomingRequest {
  return { kind: "command", message, messageType } as IncomingRequest;
}

function target(schema: typeof MembershipViewSchema | typeof OrganizationViewSchema) {
  return create(TargetSchema, {
    type: TypeUrls.derive(schema),
    criterion: { case: "includeAll", value: true },
  });
}

/**
 * A request for the read models of one kind whose column equals a value.
 *
 * @param schema The kind of read model.
 * @param column The column the condition is put on.
 * @param value The value the column must have, packed as the request carries it.
 * @param operator How the column is compared with the value. Equality when left out.
 */
function where(
  schema: Parameters<typeof TypeUrls.derive>[0],
  column: string,
  value: ReturnType<typeof AnyMessages.pack>,
  operator = Filter_Operator.EQUAL,
) {
  return create(TargetSchema, {
    type: TypeUrls.derive(schema),
    criterion: {
      case: "filters",
      value: { filter: [{ filter: [{ fieldPath: { fieldName: [column] }, value, operator }] }] },
    },
  });
}

/**
 * A request for the read models of one kind kept under the given identifiers.
 *
 * @param schema The kind of read model.
 * @param ids The identifiers, each packed as the request carries it.
 */
function byId(
  schema: Parameters<typeof TypeUrls.derive>[0],
  ...ids: ReturnType<typeof AnyMessages.pack>[]
) {
  return create(TargetSchema, {
    type: TypeUrls.derive(schema),
    criterion: { case: "filters", value: { idFilter: { id: ids } } },
  });
}

const me = AnyMessages.pack(PersonIdSchema, create(PersonIdSchema, { uuid: "person-1" }));
const somebodyElse = AnyMessages.pack(PersonIdSchema, create(PersonIdSchema, { uuid: "person-2" }));
const payroll = AnyMessages.pack(ResourceIdSchema, create(ResourceIdSchema, { uuid: "payroll" }));

function desk(role: OrganizationRole = OrganizationRole.MEMBER) {
  const member = vi
    .fn()
    .mockResolvedValue(create(OrganizationMemberSchema, { person: { uuid: "person-1" }, role }));
  const manages = vi.fn().mockResolvedValue(true);
  const requested = vi.fn().mockResolvedValue(true);
  return { member, manages, requested };
}

describe("Gateway request classification should", () => {
  it("route membership commands, queries, and subscriptions outside organizations", () => {
    const memberships = target(MembershipViewSchema);
    const organization = target(OrganizationViewSchema);

    expect(
      Policy.concernsNoOrganization(
        command(create(AddMemberSchema), TypeUrls.derive(AddMemberSchema)),
      ),
    ).toBe(true);
    expect(
      Policy.concernsNoOrganization(
        command(
          create(OpenResourceForRequestsSchema),
          TypeUrls.derive(OpenResourceForRequestsSchema),
        ),
      ),
    ).toBe(false);
    expect(
      Policy.concernsNoOrganization({ kind: "query", target: memberships } as IncomingRequest),
    ).toBe(true);
    expect(
      Policy.concernsNoOrganization({ kind: "subscribe", target: memberships } as IncomingRequest),
    ).toBe(true);
    expect(
      Policy.concernsNoOrganization({ kind: "query", target: organization } as IncomingRequest),
    ).toBe(false);
    expect(Policy.concernsNoOrganization({ kind: "activate" } as IncomingRequest)).toBe(false);
    expect(Policy.concernsNoOrganization({ kind: "cancel" } as IncomingRequest)).toBe(false);
  });
});

describe("Gateway policy should", () => {
  it("refuse everything to a person who belongs to no organization", async () => {
    const application = desk(OrganizationRole.ADMINISTRATOR);
    const authorize = Policy.authorization(application as unknown as AccessDesk);
    const nowhere = { id: "person-1", attributes: { email: "maya@example.com", name: "Maya" } };
    const adding = create(AddMemberSchema, {
      id: { emailAddress: { value: "noah@example.com" } },
      organization: { uuid: "acme" },
      addedBy: { uuid: "person-1" },
    });

    expect(await authorize(nowhere, command(adding))).toBe(false);
    expect(application.member).not.toHaveBeenCalled();
  });

  it("let an administrator add people only to their own organization, in their own name", async () => {
    const administrator = Policy.authorization(
      desk(OrganizationRole.ADMINISTRATOR) as unknown as AccessDesk,
    );
    const member = Policy.authorization(desk() as unknown as AccessDesk);
    const addingTo = (organization: string, addedBy: string | null = "person-1") =>
      command(
        create(AddMemberSchema, {
          id: { emailAddress: { value: "noah@example.com" } },
          organization: { uuid: organization },
          ...(addedBy === null ? {} : { addedBy: { uuid: addedBy } }),
        }),
      );

    expect(await administrator(principal, addingTo("acme"))).toBe(true);
    expect(await administrator(principal, addingTo("globex"))).toBe(false);
    expect(await member(principal, addingTo("acme"))).toBe(false);
    // Not in the name of another person, nor with the field left empty.
    expect(await administrator(principal, addingTo("acme", "person-2"))).toBe(false);
    expect(await administrator(principal, addingTo("acme", null))).toBe(false);
  });

  it("refuse missing email and missing organization before checking membership", async () => {
    const application = desk();
    const authorize = Policy.authorization(application as unknown as AccessDesk);
    const reading = { kind: "query", target: target(OrganizationViewSchema) } as IncomingRequest;

    expect(await authorize({ id: "person-1", attributes: {} }, reading)).toBe(false);
    expect(
      await authorize({ id: "person-1", attributes: { email: "maya@example.com" } }, reading),
    ).toBe(false);
    expect(application.member).not.toHaveBeenCalled();
  });

  it("convert principal scalars to value objects for membership and refuse nonmembers", async () => {
    const application = desk();
    application.member.mockResolvedValueOnce(undefined);
    const authorize = Policy.authorization(application as unknown as AccessDesk);
    const reading = { kind: "query", target: target(OrganizationViewSchema) } as IncomingRequest;

    expect(await authorize(principal, reading)).toBe(false);
    expect(application.member).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: "acme" }),
      expect.objectContaining({ uuid: "person-1" }),
    );
  });

  it("allow member reads and subscriptions, but refuse an unlisted command", async () => {
    const application = desk();
    const authorize = Policy.authorization(application as unknown as AccessDesk);
    const view = target(OrganizationViewSchema);

    expect(await authorize(principal, { kind: "query", target: view } as IncomingRequest)).toBe(
      true,
    );
    expect(await authorize(principal, { kind: "subscribe", target: view } as IncomingRequest)).toBe(
      true,
    );
    expect(await authorize(principal, command(create(AddOrganizationMemberSchema)))).toBe(false);
    expect(await authorize(principal, { kind: "activate" } as IncomingRequest)).toBe(true);
    expect(await authorize(principal, { kind: "cancel" } as IncomingRequest)).toBe(true);
  });

  it("allow an administrator only the exact memberships query for their organization", async () => {
    const administrator = desk(OrganizationRole.ADMINISTRATOR);
    const member = desk();
    const acme = create(OrganizationIdSchema, { uuid: "acme" });
    const globex = create(OrganizationIdSchema, { uuid: "globex" });
    const targetFor = (id: typeof acme) =>
      create(TargetSchema, {
        type: TypeUrls.derive(MembershipViewSchema),
        criterion: {
          case: "filters",
          value: {
            filter: [
              {
                filter: [
                  {
                    fieldPath: { fieldName: ["organization"] },
                    value: AnyMessages.pack(OrganizationIdSchema, id),
                    operator: Filter_Operator.EQUAL,
                  },
                ],
              },
            ],
          },
        },
      });
    const queryFor = (id: typeof acme): IncomingRequest =>
      ({ kind: "query", target: targetFor(id) }) as IncomingRequest;
    const authorize = (application: ReturnType<typeof desk>) =>
      Policy.authorization(application as unknown as AccessDesk);

    expect(await authorize(administrator)(principal, queryFor(acme))).toBe(true);
    expect(await authorize(administrator)(principal, queryFor(globex))).toBe(false);
    // Not of every organization at once.
    expect(
      await authorize(administrator)(principal, {
        kind: "query",
        target: create(TargetSchema, {
          type: TypeUrls.derive(MembershipViewSchema),
          criterion: { case: "includeAll", value: true },
        }),
      } as IncomingRequest),
    ).toBe(false);
    expect(await authorize(member)(principal, queryFor(acme))).toBe(false);
    expect(
      await authorize(administrator)(principal, {
        kind: "subscribe",
        target: targetFor(acme),
      } as IncomingRequest),
    ).toBe(false);
  });

  it("let a manager read and watch the audit trail of a resource they manage, and refuse any other member", async () => {
    const manager = desk();
    const member = desk();
    member.manages.mockResolvedValue(false);
    const everything = create(TargetSchema, {
      type: TypeUrls.derive(AuditEntrySchema),
      criterion: { case: "includeAll", value: true },
    });

    for (const kind of ["query", "subscribe"] as const) {
      const asking = (target: typeof everything, application = manager) =>
        Policy.authorization(application as unknown as AccessDesk)(principal, {
          kind,
          target,
        } as IncomingRequest);

      expect(await asking(where(AuditEntrySchema, "resource", payroll))).toBe(true);
      // The audit trail of the whole organization is not a manager's to see.
      expect(await asking(everything)).toBe(false);
      expect(await asking(where(AuditEntrySchema, "actor", me))).toBe(false);
      // Somebody who manages nothing sees no audit trail at all.
      expect(await asking(where(AuditEntrySchema, "resource", payroll), member)).toBe(false);
      expect(await asking(everything, member)).toBe(false);
    }
    expect(manager.manages).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: "acme" }),
      expect.objectContaining({ uuid: "person-1" }),
      expect.objectContaining({ uuid: "payroll" }),
    );
  });

  it("let an administrator read and watch the audit trail of the whole organization", async () => {
    const administrator = desk(OrganizationRole.ADMINISTRATOR);
    administrator.manages.mockResolvedValue(false);
    const authorize = Policy.authorization(administrator as unknown as AccessDesk);
    const everything = create(TargetSchema, {
      type: TypeUrls.derive(AuditEntrySchema),
      criterion: { case: "includeAll", value: true },
    });

    for (const kind of ["query", "subscribe"] as const) {
      expect(await authorize(principal, { kind, target: everything } as IncomingRequest)).toBe(
        true,
      );
      // Of a resource too, whether or not they manage it.
      expect(
        await authorize(principal, {
          kind,
          target: where(AuditEntrySchema, "resource", payroll),
        } as IncomingRequest),
      ).toBe(true);
    }
  });

  it("let every member read and watch the organization and its catalog", async () => {
    const authorize = Policy.authorization(desk() as unknown as AccessDesk);

    for (const schema of [OrganizationViewSchema, ResourceCatalogItemSchema]) {
      const everything = create(TargetSchema, {
        type: TypeUrls.derive(schema),
        criterion: { case: "includeAll", value: true },
      });
      for (const kind of ["query", "subscribe"] as const) {
        expect(await authorize(principal, { kind, target: everything } as IncomingRequest)).toBe(
          true,
        );
      }
    }
  });

  it("let a member read and watch only their own requests and grants", async () => {
    const application = desk();
    application.manages.mockResolvedValue(false);
    const authorize = Policy.authorization(application as unknown as AccessDesk);
    const own = [
      where(AccessRequestViewSchema, "requester", me),
      where(AccessGrantViewSchema, "grantee", me),
    ];
    const notTheirs = [
      // Everything of the organization, or somebody else's.
      create(TargetSchema, {
        type: TypeUrls.derive(AccessRequestViewSchema),
        criterion: { case: "includeAll", value: true },
      }),
      create(TargetSchema, {
        type: TypeUrls.derive(AccessGrantViewSchema),
        criterion: { case: "includeAll", value: true },
      }),
      where(AccessRequestViewSchema, "requester", somebodyElse),
      where(AccessGrantViewSchema, "grantee", somebodyElse),
      // The right value under the wrong column, or a condition other than equality.
      where(AccessRequestViewSchema, "grantee", me),
      where(AccessGrantViewSchema, "requester", me),
      where(AccessRequestViewSchema, "requester", me, Filter_Operator.GREATER_THAN),
      // By identifier, which says nothing of whose it is.
      byId(AccessRequestViewSchema, me),
      // A resource the person does not manage.
      where(AccessRequestViewSchema, "resource", payroll),
      where(AccessGrantViewSchema, "resource", payroll),
    ];

    for (const kind of ["query", "subscribe"] as const) {
      for (const target of own) {
        expect(await authorize(principal, { kind, target } as IncomingRequest)).toBe(true);
      }
      for (const target of notTheirs) {
        expect(await authorize(principal, { kind, target } as IncomingRequest)).toBe(false);
      }
    }
  });

  it("refuse a request that puts a second condition beside the person's own", async () => {
    const authorize = Policy.authorization(desk() as unknown as AccessDesk);
    const own = {
      fieldPath: { fieldName: ["requester"] },
      value: me,
      operator: Filter_Operator.EQUAL,
    };
    const other = {
      fieldPath: { fieldName: ["requester"] },
      value: somebodyElse,
      operator: Filter_Operator.EQUAL,
    };
    const asking = (filters: object) =>
      ({
        kind: "query",
        target: create(TargetSchema, {
          type: TypeUrls.derive(AccessRequestViewSchema),
          criterion: { case: "filters", value: filters },
        }),
      }) as IncomingRequest;

    // Either of two people, in one condition or in two.
    expect(await authorize(principal, asking({ filter: [{ filter: [own, other] }] }))).toBe(false);
    expect(
      await authorize(principal, asking({ filter: [{ filter: [own] }, { filter: [other] }] })),
    ).toBe(false);
    expect(
      await authorize(
        principal,
        asking({ filter: [{ filter: [own], compositeFilter: [{ filter: [other] }] }] }),
      ),
    ).toBe(false);
    // The person's own, narrowed by identifiers the gateway cannot judge.
    expect(
      await authorize(principal, asking({ idFilter: { id: [me] }, filter: [{ filter: [own] }] })),
    ).toBe(false);
    // A column of a nested value.
    expect(
      await authorize(
        principal,
        asking({
          filter: [
            {
              filter: [
                {
                  fieldPath: { fieldName: ["snapshot", "requester"] },
                  value: me,
                  operator: Filter_Operator.EQUAL,
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("let a manager read and watch the requests and grants of a resource they manage", async () => {
    const application = desk();
    const authorize = Policy.authorization(application as unknown as AccessDesk);

    for (const schema of [AccessRequestViewSchema, AccessGrantViewSchema]) {
      for (const kind of ["query", "subscribe"] as const) {
        expect(
          await authorize(principal, {
            kind,
            target: where(schema, "resource", payroll),
          } as IncomingRequest),
        ).toBe(true);
      }
    }
    expect(application.manages).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: "acme" }),
      expect.objectContaining({ uuid: "person-1" }),
      expect.objectContaining({ uuid: "payroll" }),
    );
  });

  it("let a manager read and watch their own queue of requests, and nobody else's", async () => {
    const authorize = Policy.authorization(desk() as unknown as AccessDesk);
    const asking = (kind: "query" | "subscribe", target: ReturnType<typeof byId>) =>
      authorize(principal, { kind, target } as IncomingRequest);

    for (const kind of ["query", "subscribe"] as const) {
      expect(await asking(kind, byId(AccessDecisionAssignmentSchema, me))).toBe(true);
      expect(await asking(kind, byId(AccessDecisionAssignmentSchema, somebodyElse))).toBe(false);
      expect(await asking(kind, byId(AccessDecisionAssignmentSchema, me, somebodyElse))).toBe(
        false,
      );
      expect(await asking(kind, byId(AccessDecisionAssignmentSchema))).toBe(false);
      expect(
        await asking(
          kind,
          create(TargetSchema, {
            type: TypeUrls.derive(AccessDecisionAssignmentSchema),
            criterion: { case: "includeAll", value: true },
          }),
        ),
      ).toBe(false);
    }
  });

  it("let an administrator register a resource only in the organization they entered", async () => {
    const registering = (organization: string | undefined) =>
      command(
        create(RegisterResourceSchema, {
          id: { uuid: "payroll" },
          ...(organization === undefined ? {} : { organizationId: { uuid: organization } }),
        }),
      );
    const administrator = Policy.authorization(
      desk(OrganizationRole.ADMINISTRATOR) as unknown as AccessDesk,
    );
    const member = Policy.authorization(desk() as unknown as AccessDesk);

    expect(await administrator(principal, registering("acme"))).toBe(true);
    expect(await administrator(principal, registering("globex"))).toBe(false);
    expect(await administrator(principal, registering(undefined))).toBe(false);
    expect(await member(principal, registering("acme"))).toBe(false);
  });

  it("use the typed request id for cancellation and refuse a missing id", async () => {
    const application = desk();
    const authorize = Policy.authorization(application as unknown as AccessDesk);

    expect(await authorize(principal, command(create(CancelAccessRequestSchema)))).toBe(false);
    expect(application.requested).not.toHaveBeenCalled();
    expect(
      await authorize(
        principal,
        command(create(CancelAccessRequestSchema, { id: { uuid: "req-1" } })),
      ),
    ).toBe(true);
    expect(application.requested).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: "acme" }),
      expect.objectContaining({ uuid: "person-1" }),
      expect.objectContaining({ uuid: "req-1" }),
    );
  });

  it("require a resource id before either a manager or administrator opens it", async () => {
    for (const role of [OrganizationRole.MEMBER, OrganizationRole.ADMINISTRATOR]) {
      const application = desk(role);
      const authorize = Policy.authorization(application as unknown as AccessDesk);

      expect(await authorize(principal, command(create(OpenResourceForRequestsSchema)))).toBe(
        false,
      );
      expect(application.manages).not.toHaveBeenCalled();
      expect(
        await authorize(
          principal,
          command(create(OpenResourceForRequestsSchema, { id: { uuid: "payroll" } })),
        ),
      ).toBe(true);
      if (role === OrganizationRole.MEMBER) {
        expect(application.manages).toHaveBeenCalledWith(
          expect.objectContaining({ uuid: "acme" }),
          expect.objectContaining({ uuid: "person-1" }),
          expect.objectContaining({ uuid: "payroll" }),
        );
      }
    }
  });
});
