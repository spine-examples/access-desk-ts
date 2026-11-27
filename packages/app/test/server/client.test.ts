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
import { AnyPacker } from "@spine-event-engine/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/commands_pb.js";
import { OrganizationCreatedSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/events_pb.js";
import { OrganizationAlreadyExistsSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/rejections_pb.js";
import { OrganizationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationViewSchema } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_pb.js";
import { OrganizationViewQuery } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_query.js";

import { creation, creationShown, firstGiven, organizationId } from "./given/client.js";
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

describe("ServerConnection should", () => {
  it("give the same client for an organization each time, and another for another", () => {
    const connection = connectionTo(() => "http://127.0.0.1:1");
    const acme = create(OrganizationIdSchema, { value: "acme" });
    const sameAcme = create(OrganizationIdSchema, { value: "acme" });
    const globex = create(OrganizationIdSchema, { value: "globex" });

    expect(connection.in(acme)).toBe(connection.in(sameAcme));
    expect(connection.in(globex)).not.toBe(connection.in(acme));
    expect(connection.in()).toBe(connection.in());
    expect(connection.in()).not.toBe(connection.in(acme));
    expect(() => connection.in(create(OrganizationIdSchema, { value: "" }))).toThrow(
      "An organization identifier must not be empty.",
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

    connection.in(create(OrganizationIdSchema, { value: "acme" }));
    connection.in(create(OrganizationIdSchema, { value: "globex" }));
    connection.in();

    expect(asked).toBe(1);
  });

  it("reach every organization of a server through the one connection", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    for (const organization of ["acme", "globex"]) {
      const shown = await client.ServerRequests.postAndAwaitView(
        connection
          .in(create(OrganizationIdSchema, { value: organization }))
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
    const acme = connection.in(create(OrganizationIdSchema, { value: "acme" }));
    await client.ServerRequests.postAndAwaitView(
      acme.onBehalfOf("access-desk"),
      creationShown("acme"),
    );

    await connection.close();

    expect(connection.in(create(OrganizationIdSchema, { value: "acme" }))).not.toBe(acme);
    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(create(OrganizationIdSchema, { value: "globex" })).onBehalfOf("access-desk"),
      creationShown("globex"),
    );
    expect(shown).toBe("globex");
  });
});

describe("ServerConnection, once its server stopped, should", () => {
  it("end, and tell that the server did not cancel the subscriptions", async () => {
    const stopped = await givenServer();
    let address = stopped.url;
    const connection = connectionTo(() => address);
    const request = connection.in(organizationId("acme")).onBehalfOf("access-desk");
    await client.ServerRequests.subscribeTo(
      request,
      OrganizationViewSchema,
      OrganizationIdSchema,
      organizationId("acme"),
      () => undefined,
    );
    await stopped.stop();

    await expect(connection.close()).rejects.toThrow();

    // The connection reaches the next server it is given.
    const server = await hosted();
    address = server.url;
    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(organizationId("globex")).onBehalfOf("access-desk"),
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

  it("return nothing when the server does not take the command", async () => {
    const server = await hosted();
    const connection = connectionTo(() => server.url);

    const shown = await client.ServerRequests.postAndAwaitView(
      connection.in(organizationId("acme")).onBehalfOf("access-desk"),
      creationShown("acme", ""),
      300,
    );

    expect(shown).toBeUndefined();
  });
});

describe("subscribeTo should", () => {
  it("give the state of the entity once it changes", async () => {
    const server = await hosted();
    const request = connectionTo(() => server.url)
      .in(organizationId("acme"))
      .onBehalfOf("access-desk");
    const name = firstGiven<string>(10_000);
    const subscription = await client.ServerRequests.subscribeTo(
      request,
      OrganizationViewSchema,
      OrganizationIdSchema,
      organizationId("acme"),
      (view) => {
        name.observe(view.name);
      },
    );

    await request.post(CreateOrganizationSchema, creation("acme"));

    expect(await name.value).toBe("acme");
    await subscription.cancel();
  });

  it("give nothing of what the entity held before the subscription", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const request = connectionTo(() => server.url)
      .in(organizationId("acme"))
      .onBehalfOf("access-desk");
    const name = firstGiven<string>(300);

    const subscription = await client.ServerRequests.subscribeTo(
      request,
      OrganizationViewSchema,
      OrganizationIdSchema,
      organizationId("acme"),
      (view) => {
        name.observe(view.name);
      },
    );

    expect(await name.value).toBeUndefined();
    await subscription.cancel();
  });
});

describe("postAndSubscribe should", () => {
  it("give the event the command's handler emits", async () => {
    const server = await hosted();
    const request = connectionTo(() => server.url)
      .in(organizationId("acme"))
      .onBehalfOf("access-desk");
    const outcome = firstGiven<Any>(10_000);

    const subscription = await client.ServerRequests.postAndSubscribe(
      request,
      CreateOrganizationSchema,
      creation("acme"),
      [OrganizationCreatedSchema, OrganizationAlreadyExistsSchema],
      outcome.observe,
    );

    const event = await outcome.value;
    const created =
      event === undefined ? undefined : AnyPacker.tryUnpack(event, OrganizationCreatedSchema);
    expect(created?.id?.value).toBe("acme");
    await subscription?.cancel();
  });

  it("give the rejection the command's handler rejects the command with", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const request = connectionTo(() => server.url)
      .in(organizationId("acme"))
      .onBehalfOf("access-desk");
    const outcome = firstGiven<Any>(10_000);

    const subscription = await client.ServerRequests.postAndSubscribe(
      request,
      CreateOrganizationSchema,
      creation("acme"),
      [OrganizationCreatedSchema, OrganizationAlreadyExistsSchema],
      outcome.observe,
    );

    const rejection = await outcome.value;
    const exists =
      rejection === undefined
        ? undefined
        : AnyPacker.tryUnpack(rejection, OrganizationAlreadyExistsSchema);
    expect(exists?.id?.value).toBe("acme");
    await subscription?.cancel();
  });

  it("give no subscription when the server does not take the command", async () => {
    const server = await hosted();
    const request = connectionTo(() => server.url)
      .in(organizationId("acme"))
      .onBehalfOf("access-desk");

    const subscription = await client.ServerRequests.postAndSubscribe(
      request,
      CreateOrganizationSchema,
      creation("acme", ""),
      [OrganizationCreatedSchema, OrganizationAlreadyExistsSchema],
      () => undefined,
    );

    expect(subscription).toBeUndefined();
  });
});

describe("readById should", () => {
  it("read a read model of an organization by its identifier", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const acme = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { value: "acme" }))
      .onBehalfOf("access-desk");

    const view = await client.ServerRequests.readById(
      acme,
      OrganizationViewSchema,
      OrganizationIdSchema,
      create(OrganizationIdSchema, { value: "acme" }),
    );

    expect(view?.name).toBe("acme");
  });

  it("read nothing under an identifier nothing is kept under", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const acme = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { value: "acme" }))
      .onBehalfOf("access-desk");

    const view = await client.ServerRequests.readById(
      acme,
      OrganizationViewSchema,
      OrganizationIdSchema,
      create(OrganizationIdSchema, { value: "globex" }),
    );

    expect(view).toBeUndefined();
  });

  it("read only inside the organization the client is for", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const globex = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { value: "globex" }))
      .onBehalfOf("access-desk");

    const view = await client.ServerRequests.readById(
      globex,
      OrganizationViewSchema,
      OrganizationIdSchema,
      create(OrganizationIdSchema, { value: "acme" }),
    );

    expect(view).toBeUndefined();
  });
});

describe("find should", () => {
  it("find the read models a query describes, and none when nothing matches", async () => {
    const server = await hosted();
    await givenOrganization(server, organizationId("acme"));
    const acme = connectionTo(() => server.url)
      .in(create(OrganizationIdSchema, { value: "acme" }))
      .onBehalfOf("access-desk");
    const named = (name: string) => OrganizationViewQuery.create().name().is(name).build();

    const found = await client.ServerRequests.find(acme, OrganizationViewSchema, named("acme"));
    const none = await client.ServerRequests.find(acme, OrganizationViewSchema, named("globex"));

    expect(found.map((view) => view.id?.value)).toEqual(["acme"]);
    expect(none).toEqual([]);
  });
});
