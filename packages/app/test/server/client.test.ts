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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { OrganizationCreatedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { OrganizationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { OrganizationViewQuery } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_query.js";

import { givenOrganization, givenServer, organizationView, type Hosted } from "./given/hosted.js";

type ClientModule = typeof import("../../dist/src/server/client.js");
let client: ClientModule;
beforeAll(async () => {
  client = await import("../../dist/src/server/client.js");
});

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.reverse()) {
    await close();
  }
  closing = [];
});

async function hosted(): Promise<Hosted> {
  const server = await givenServer();
  closing.push(() => server.stop());
  return server;
}

function connectionTo(address: () => string) {
  const connection = new client.ServerConnection(address);
  closing.push(() => connection.close());
  return connection;
}

function creation(organization: string) {
  return {
    command: CreateOrganizationSchema,
    message: create(CreateOrganizationSchema, { id: { uuid: organization }, name: organization }),
    event: OrganizationCreatedSchema,
    answers: (event: { readonly id?: { readonly uuid: string } | undefined }) =>
      event.id?.uuid === organization,
  };
}

function organizationId(uuid: string) {
  return create(OrganizationIdSchema, { uuid });
}

describe("ServerConnection should", () => {
  it("give the same client for an organization each time, and another for another", () => {
    const connection = connectionTo(() => "http://127.0.0.1:1");
    const acme = create(OrganizationIdSchema, { uuid: "acme" });
    const sameAcme = create(OrganizationIdSchema, { uuid: "acme" });
    const globex = create(OrganizationIdSchema, { uuid: "globex" });

    expect(connection.in(acme)).toBe(connection.in(sameAcme));
    expect(connection.in(globex)).not.toBe(connection.in(acme));
    expect(connection.in()).toBe(connection.in());
    expect(connection.in()).not.toBe(connection.in(acme));
    expect(() => connection.in(create(OrganizationIdSchema, { uuid: "" }))).toThrow(
      "OrganizationId UUID must not be empty.",
    );
    expect(connection.in()).toBe(connection.in());
  });

  it("ask where the server is only when something is first asked, and only once", () => {
    let asked = 0;
    const connection = connectionTo(() => {
      asked += 1;
      return "http://127.0.0.1:1";
    });
    expect(asked).toBe(0);

    connection.in(create(OrganizationIdSchema, { uuid: "acme" }));
    connection.in(create(OrganizationIdSchema, { uuid: "globex" }));
    connection.in();

    expect(asked).toBe(1);
  });

  it("reach every organization of a server through the one connection", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    for (const organization of ["acme", "globex"]) {
      const created = await client.ServerRequests.postAndAwait(
        connection
          .in(create(OrganizationIdSchema, { uuid: organization }))
          .onBehalfOf("access-desk"),
        creation(organization),
      );
      expect(created?.name).toBe(organization);
    }

    expect((await organizationView(server, organizationId("acme")))?.name).toBe("acme");
    expect((await organizationView(server, organizationId("globex")))?.name).toBe("globex");
  });

  it("connect again after it was closed", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);
    const acme = connection.in(create(OrganizationIdSchema, { uuid: "acme" }));
    await client.ServerRequests.postAndAwait(acme.onBehalfOf("access-desk"), creation("acme"));

    await connection.close();

    expect(connection.in(create(OrganizationIdSchema, { uuid: "acme" }))).not.toBe(acme);
    const created = await client.ServerRequests.postAndAwait(
      connection.in(create(OrganizationIdSchema, { uuid: "globex" })).onBehalfOf("access-desk"),
      creation("globex"),
    );
    expect(created?.id?.uuid).toBe("globex");
  });
});

describe("postAndAwait should", () => {
  it("give the command and return the event that answers it", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    const created = await client.ServerRequests.postAndAwait(
      connection.in(create(OrganizationIdSchema, { uuid: "acme" })).onBehalfOf("access-desk"),
      creation("acme"),
    );

    expect(created).toMatchObject({ id: { uuid: "acme" }, name: "acme" });
  });

  it("return nothing when no event answers the command in time", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const connection = connectionTo(() => server.url);

    // An organization is created once, so creating it again leads to no event.
    const created = await client.ServerRequests.postAndAwait(
      connection.in(create(OrganizationIdSchema, { uuid: "acme" })).onBehalfOf("access-desk"),
      creation("acme"),
      300,
    );

    expect(created).toBeUndefined();
  });

  it("pass over events of the same kind that answer something else", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    const created = await client.ServerRequests.postAndAwait(
      connection.in(create(OrganizationIdSchema, { uuid: "acme" })).onBehalfOf("access-desk"),
      { ...creation("acme"), answers: () => false },
      300,
    );

    expect(created).toBeUndefined();
    expect((await organizationView(server, organizationId("acme")))?.name).toBe("acme");
  });
});

describe("readById should", () => {
  it("read a read model of an organization by its identifier", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const acme = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { uuid: "acme" }))
      .onBehalfOf("access-desk");

    const view = await client.ServerRequests.readById(
      acme,
      OrganizationViewSchema,
      OrganizationIdSchema,
      create(OrganizationIdSchema, { uuid: "acme" }),
    );

    expect(view?.name).toBe("acme");
  });

  it("read nothing under an identifier nothing is kept under", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const acme = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { uuid: "acme" }))
      .onBehalfOf("access-desk");

    const view = await client.ServerRequests.readById(
      acme,
      OrganizationViewSchema,
      OrganizationIdSchema,
      create(OrganizationIdSchema, { uuid: "globex" }),
    );

    expect(view).toBeUndefined();
  });

  it("read only inside the organization the client is for", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const globex = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { uuid: "globex" }))
      .onBehalfOf("access-desk");

    const view = await client.ServerRequests.readById(
      globex,
      OrganizationViewSchema,
      OrganizationIdSchema,
      create(OrganizationIdSchema, { uuid: "acme" }),
    );

    expect(view).toBeUndefined();
  });
});

describe("find should", () => {
  it("find the read models a query describes, and none when nothing matches", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const acme = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { uuid: "acme" }))
      .onBehalfOf("access-desk");
    const named = (name: string) => OrganizationViewQuery.create().name().is(name).build();

    const found = await client.ServerRequests.find(acme, OrganizationViewSchema, named("acme"));
    const none = await client.ServerRequests.find(acme, OrganizationViewSchema, named("globex"));

    expect(found.map((view) => view.id?.uuid)).toEqual(["acme"]);
    expect(none).toEqual([]);
  });
});
