/*
 * Copyright 2026, TeamDev. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Redistribution and use in source and/or binary forms, with or without
 * modification, must retain the above copyright notice and the following
 * disclaimer.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { create } from "@bufbuild/protobuf";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import { SignalMetadata } from "@spine-event-engine/server";
import { UserIdSchema } from "@spine-event-engine/proto";
import {
  QueryIdSchema,
  QuerySchema,
  TargetSchema,
  type Query,
} from "@spine-event-engine/proto/client";
import { BlackBox, type BlackBoxScope } from "@spine-event-engine/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CreateOrganizationSchema } from "@access-desk/resources-model/generated/access_desk/resources/commands_pb.js";
import {
  OrganizationViewSchema,
  type OrganizationView,
} from "@access-desk/resources-model/generated/access_desk/resources/organization_pb.js";

type ResourcesModule = typeof import("../dist/src/index.js");
let createResourcesContext: ResourcesModule["createResourcesContext"];

const signalMetadata = new SignalMetadata();
const ownedBlackBoxes = new Set<BlackBox>();

const organizationId = "acme";
const actor = "resources-user";

beforeAll(async () => {
  ({ createResourcesContext } = await import("../dist/src/index.js"));
}, 30_000);

afterEach(async () => {
  await Promise.all([...ownedBlackBoxes].map((box) => box.close()));
  ownedBlackBoxes.clear();
});

async function resourcesBlackBox(): Promise<BlackBox> {
  const box = await BlackBox.from(await createResourcesContext());
  ownedBlackBoxes.add(box);
  return box;
}

function organizationViewQuery(): Query {
  return create(QuerySchema, {
    id: create(QueryIdSchema, { value: "query-organization-view" }),
    target: create(TargetSchema, {
      type: TypeUrls.derive(OrganizationViewSchema),
      criterion: { case: "includeAll", value: true },
    }),
    context: signalMetadata.actorContext({
      actor: create(UserIdSchema, { value: actor }),
    }),
  });
}

async function readOrganizationViews(
  scope: BlackBoxScope,
  query: Query,
): Promise<readonly OrganizationView[]> {
  const response = await scope.send(query);
  return response.message.map(({ state }) => {
    const view =
      state === undefined ? undefined : AnyMessages.unpack(state, OrganizationViewSchema);
    if (view === undefined) {
      throw new Error("Expected an OrganizationView query state.");
    }
    return view;
  });
}

describe("Resources walking skeleton", () => {
  it("creates an organization and exposes it through the OrganizationView query", async () => {
    const box = await resourcesBlackBox();
    const scope = box.onBehalfOf(actor);

    const ack = await scope.post(
      CreateOrganizationSchema,
      create(CreateOrganizationSchema, { id: { value: organizationId }, name: "Acme" }),
    );
    expect(ack.kind).toBe("ok");

    const rows = await box.eventually(
      () => readOrganizationViews(scope, organizationViewQuery()),
      (candidate) => candidate.length === 1,
    );
    expect(rows[0]).toEqual(
      create(OrganizationViewSchema, { id: { value: organizationId }, name: "Acme" }),
    );
  });
});
