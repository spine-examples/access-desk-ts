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

import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import {
  AccessGrantIdSchema,
  AccessRequestIdSchema,
  InvokerIdSchema,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";
import { GrantIssuanceSchema } from "@access-desk/resources-model/generated/accessdesk/resources/access/grant/grant_issuance_pb.js";
import { SchedulingSchema } from "@access-desk/resources-model/generated/accessdesk/resources/scheduling/scheduling_pb.js";
import { invokerOf, relatedInvoker } from "../dist/src/invoker-id.js";

const grant = create(AccessGrantIdSchema, { uuid: "grant-one" });
const invoker = invokerOf(AccessGrantIdSchema, grant, GrantIssuanceSchema);

describe("invokerOf should", () => {
  it("name the entity by its packed identifier and the type of its state", () => {
    expect(invoker).toEqual(
      create(InvokerIdSchema, {
        id: AnyMessages.pack(AccessGrantIdSchema, grant),
        type: TypeUrls.derive(GrantIssuanceSchema),
      }),
    );
  });
});

describe("relatedInvoker should", () => {
  it("return the identifier of an invoker of the expected kind", () => {
    expect(relatedInvoker(invoker, GrantIssuanceSchema, AccessGrantIdSchema)).toEqual([grant]);
  });

  describe("return nothing for an invoker", () => {
    it("that is unknown", () => {
      expect(relatedInvoker(undefined, GrantIssuanceSchema, AccessGrantIdSchema)).toEqual([]);
    });

    it("of another kind", () => {
      expect(relatedInvoker(invoker, SchedulingSchema, AccessGrantIdSchema)).toEqual([]);
    });

    it("whose identifier is of another kind", () => {
      const other = create(InvokerIdSchema, {
        type: TypeUrls.derive(GrantIssuanceSchema),
        id: AnyMessages.pack(
          AccessRequestIdSchema,
          create(AccessRequestIdSchema, { uuid: "grant-one" }),
        ),
      });
      expect(relatedInvoker(other, GrantIssuanceSchema, AccessGrantIdSchema)).toEqual([]);
    });

    it("whose identifier does not read back", () => {
      const garbled = create(InvokerIdSchema, {
        type: TypeUrls.derive(GrantIssuanceSchema),
        id: create(AnySchema, {
          typeUrl: TypeUrls.derive(AccessGrantIdSchema),
          value: new Uint8Array([0xff]),
        }),
      });
      expect(relatedInvoker(garbled, GrantIssuanceSchema, AccessGrantIdSchema)).toEqual([]);
    });
  });
});
