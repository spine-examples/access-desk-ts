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
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { TopicSchema } from "@spine-event-engine/proto/client";
import { expect } from "vitest";
import { PersonIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  AccessRequestViewSchema,
  type AccessRequestView,
} from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_pb.js";
import { AccessRequestViewQuery } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/access_request_query.js";
import { SubmitAccessRequestSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/request/commands_pb.js";
import {
  AccessRequestIdSchema,
  ResourceIdSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { OpenResourceForRequestsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/commands_pb.js";
import { ResourceCatalogItemSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_pb.js";
import { RegisterResourceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/resource/resource_registration_commands_pb.js";
import { Sensitivity } from "@access-desk/resources-model/generated/accessdesk/resources/values_pb.js";

import {
  afterwards,
  browserClient,
  eventually,
  everything,
  organizationId,
  post,
  read,
  tenant,
  type Asking,
  type Running,
} from "./gateway.js";
import { givenMember } from "./membership.js";
import type { Signed } from "./sign-in.js";

/**
 * Has an administrator of Acme register a resource they manage themselves.
 *
 * @param running The running application.
 * @param administrator An administrator of Acme who works in it.
 * @param resource The identifier of the resource, which is also its name.
 * @param organization The organization the command names. Acme when left
 *   out. The administrator acts in Acme either way, so any other organization
 *   here is one the gateway must refuse.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function registerResource(
  running: Running,
  administrator: Signed,
  resource: string,
  organization = "acme",
): Promise<string> {
  return post(
    running,
    { ...administrator, organization: "acme" },
    RegisterResourceSchema,
    create(RegisterResourceSchema, {
      id: { uuid: resource },
      organizationId: organizationId(organization),
      name: resource,
      description: `${resource} production`,
      category: "application",
      sensitivity: Sensitivity.RESTRICTED,
      manager: [{ uuid: administrator.person }],
      accessLevel: [{ name: "Read", rank: 1 }],
      maximumDuration: { seconds: 3600n },
    }),
  );
}

/**
 * Reads a resource of an organization's catalog, as the application server holds it.
 *
 * @param running The running application.
 * @param organization The organization's name.
 * @param resource The identifier of the resource.
 * @returns The catalog item, or `undefined` when the catalog has no such resource.
 */
export function catalogItem(running: Running, organization: string, resource: string) {
  return running.resources
    .stand()
    .read(ResourceCatalogItemSchema, create(ResourceIdSchema, { uuid: resource }), {
      tenantId: tenant(organization),
    });
}

/**
 * Has `noah` administer Acme, register the payroll resource he manages, and
 * open it for requests.
 *
 * @param running The running application.
 * @returns `noah`, with a session in Acme.
 */
export async function givenOpenResource(running: Running): Promise<Signed> {
  const noah = await givenMember(running, "noah", "acme");
  expect(await registerResource(running, noah, "payroll")).toBe("ok");
  const catalogued = () => catalogItem(running, "acme", "payroll");
  await eventually(catalogued, (item) => item !== undefined);
  expect(
    await post(
      running,
      { ...noah, organization: "acme" },
      OpenResourceForRequestsSchema,
      create(OpenResourceForRequestsSchema, { id: { uuid: "payroll" } }),
    ),
  ).toBe("ok");
  await eventually(catalogued, (item) => item?.policy?.openForRequests === true);
  return noah;
}

/**
 * Has somebody ask for an hour of read access to payroll.
 *
 * @param running The running application.
 * @param as Who the browser acts as: the session it holds, when it holds one,
 *   and the person it says it acts for.
 * @param id The identifier of the request.
 * @param claimed What the command claims instead of the usual: the person
 *   who requests, who is the one acted for when left out, and the
 *   organization the request names, which is Acme when left out.
 * @returns `"ok"` when the gateway let the command through, and why not otherwise.
 */
export function submitRequest(
  running: Running,
  as: { readonly token?: string; readonly person: string },
  id: string,
  claimed: { readonly requester?: string; readonly organization?: string } = {},
): Promise<string> {
  return post(
    running,
    { ...as, organization: claimed.organization ?? "acme" },
    SubmitAccessRequestSchema,
    create(SubmitAccessRequestSchema, {
      id: { uuid: id },
      requester: { uuid: claimed.requester ?? as.person },
      resource: { uuid: "payroll" },
      accessLevel: { name: "Read", rank: 1 },
      justification: "Need payroll review",
      period: { kind: { case: "immediateDuration", value: { seconds: 60n } } },
    }),
  );
}

/**
 * Reads a request of an organization, as the application server holds it.
 *
 * @param running The running application.
 * @param organization The organization's name.
 * @param id The identifier of the request.
 * @returns The request, or `undefined` when there is none.
 */
export function accessRequest(running: Running, organization: string, id: string) {
  return running.resources
    .stand()
    .read(AccessRequestViewSchema, create(AccessRequestIdSchema, { uuid: id }), {
      tenantId: tenant(organization),
    });
}

/**
 * Which requests a browser asks for: the person's own, everything of the
 * organization, those a given person made, or those for a given resource.
 */
export type RequestsAsked =
  "own" | "all" | { readonly requester: string } | { readonly resource: string };

/**
 * Reads requests through the gateway as the browser client does.
 *
 * @param running The running application.
 * @param as The signed-in person who reads.
 * @param asked Which requests to ask for. The person's own when left out.
 * @param organization The organization the request names. Acme when left out.
 * @returns The requests, or `"refused"` when the gateway or the application
 *   server did not answer the request.
 */
export function readRequests(
  running: Running,
  as: Signed,
  asked: RequestsAsked = "own",
  organization = "acme",
): Promise<AccessRequestView[] | "refused"> {
  const acting = { ...as, organization };
  const requestedBy = (person: string): Asking =>
    AccessRequestViewQuery.create()
      .requester()
      .is(create(PersonIdSchema, { uuid: person }))
      .build();
  const asking: Asking =
    asked === "own"
      ? requestedBy(as.person)
      : asked === "all"
        ? everything(AccessRequestViewSchema, acting)
        : "requester" in asked
          ? requestedBy(asked.requester)
          : AccessRequestViewQuery.create()
              .resource()
              .is(create(ResourceIdSchema, { uuid: asked.resource }))
              .build();
  return read(running, acting, AccessRequestViewSchema, asking);
}

/** What a browser has been told while it watches the catalog of an organization. */
export interface Watched {
  /** The resources it was told about, in the order it was told. */
  readonly told: string[];
  /**
   * Waits until the browser is told about a resource.
   *
   * @param resource The identifier of the resource.
   * @param patienceMs How long to wait. Fifteen seconds when left out.
   * @returns Whether it was told in time.
   */
  hears(resource: string, patienceMs?: number): Promise<boolean>;
  /**
   * Waits until the browser is told nothing more, because its stream has ended.
   *
   * @returns Whether the telling ended in time.
   */
  stops(): Promise<boolean>;
}

/**
 * Watches the catalog of an organization through the gateway as the browser
 * client does. The watching is closed when the test is over.
 *
 * @param running The running application.
 * @param as The signed-in person who watches.
 * @param organization The organization whose catalog it is. Acme when left out.
 * @returns What the browser has been told since, once its subscription is opened.
 */
export async function watchCatalog(
  running: Running,
  as: Signed,
  organization = "acme",
): Promise<Watched> {
  const acting = { ...as, organization };
  const client = browserClient(running, acting);
  afterwards(() => client.close().catch(() => undefined));
  const subscription = await client.onBehalfOf(as.person).createSubscription(
    create(TopicSchema, {
      id: { value: `catalog-${crypto.randomUUID()}` },
      target: {
        type: TypeUrls.derive(ResourceCatalogItemSchema),
        criterion: { case: "includeAll", value: true },
      },
    }),
    { kind: "entity", authoritativeQuery: () => everything(ResourceCatalogItemSchema, acting) },
  );
  const told: string[] = [];
  let ended = false;
  void (async () => {
    try {
      for await (const delivery of subscription.updates) {
        if (delivery.kind !== "update" || delivery.update.update.case !== "entityUpdates") {
          continue;
        }
        for (const { kind } of delivery.update.update.value.update) {
          const item =
            kind.case === "state"
              ? AnyMessages.unpack(kind.value, ResourceCatalogItemSchema)
              : undefined;
          if (item?.id !== undefined) {
            told.push(item.id.uuid);
          }
        }
      }
    } catch {
      // A stream the gateway ended is one the browser is told nothing more on.
    } finally {
      ended = true;
    }
  })();
  await subscription.activate();
  return {
    told,
    hears: (resource, patienceMs) =>
      eventually(
        () => Promise.resolve(told.includes(resource)),
        (heard) => heard,
        patienceMs,
      ),
    stops: () =>
      eventually(
        () => Promise.resolve(ended),
        (stopped) => stopped,
      ),
  };
}

/**
 * Waits until a browser is really being told what it watches.
 *
 * A subscription tells only what happens after it has opened all the way to
 * the application server, which is a moment after the browser's call returns.
 * So an administrator registers resources until the browser hears of one.
 *
 * @param running The running application.
 * @param administrator An administrator of Acme who works in it, to register the resources.
 * @param watched What the browser has been told, as {@link watchCatalog} returned it.
 */
export async function givenTold(
  running: Running,
  administrator: Signed,
  watched: Watched,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = `probe-${crypto.randomUUID()}`;
    expect(await registerResource(running, administrator, probe)).toBe("ok");
    if (await watched.hears(probe, 500)) {
      return;
    }
  }
  throw new Error("The browser was never told what it watches.");
}
