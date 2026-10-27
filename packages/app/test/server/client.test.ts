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

function organizationId(uuid: string) {
  return create(OrganizationIdSchema, { uuid });
}

/**
 * Describes creating an organization, which shows in its view under its name.
 *
 * @param organization The organization, whose name is its identifier.
 * @param name The name the organization is created under.
 */
function creationShown(organization: string, name: string = organization) {
  return {
    command: CreateOrganizationSchema,
    message: create(CreateOrganizationSchema, { id: { uuid: organization }, name }),
    view: OrganizationViewSchema,
    idSchema: OrganizationIdSchema,
    id: organizationId(organization),
    shows: (view: { readonly name: string }) => (view.name === "" ? undefined : view.name),
  };
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
      const shown = await client.ServerRequests.postAndAwaitView(
        connection
          .in(create(OrganizationIdSchema, { uuid: organization }))
          .onBehalfOf("access-desk"),
        creationShown(organization),
      );
      expect(shown).toBe(organization);
    }

    expect((await organizationView(server, organizationId("acme")))?.name).toBe("acme");
    expect((await organizationView(server, organizationId("globex")))?.name).toBe("globex");
  });

  it("connect again after it was closed", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);
    const acme = connection.in(create(OrganizationIdSchema, { uuid: "acme" }));
    await client.ServerRequests.postAndAwaitView(
      acme.onBehalfOf("access-desk"),
      creationShown("acme"),
    );

    await connection.close();

    expect(connection.in(create(OrganizationIdSchema, { uuid: "acme" }))).not.toBe(acme);
    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(create(OrganizationIdSchema, { uuid: "globex" })).onBehalfOf("access-desk"),
      creationShown("globex"),
    );
    expect(shown).toBe("globex");
  });
});

describe("postAndAwaitView should", () => {
  it("give the command and return what the read model shows once an update shows it", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(organizationId("acme")).onBehalfOf("access-desk"),
      creationShown("acme"),
    );

    expect(shown).toBe("acme");
  });

  it("return nothing when an earlier command made the effect already", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const connection = connectionTo(() => server.url);

    // An organization is created once, so creating it again changes nothing
    // its view would be updated for.
    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(organizationId("acme")).onBehalfOf("access-desk"),
      creationShown("acme"),
      300,
    );

    expect(shown).toBeUndefined();
  });

  it("return nothing when the read model does not show the effect in time", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(organizationId("acme")).onBehalfOf("access-desk"),
      { ...creationShown("acme"), shows: (): string | undefined => undefined },
      300,
    );

    expect(shown).toBeUndefined();
    expect((await organizationView(server, organizationId("acme")))?.name).toBe("acme");
  });

  it("return nothing when the command is refused", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    // An organization needs a name.
    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(organizationId("acme")).onBehalfOf("access-desk"),
      creationShown("acme", ""),
      300,
    );

    expect(shown).toBeUndefined();
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
