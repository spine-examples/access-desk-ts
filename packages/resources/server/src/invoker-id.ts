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

import { create, type Message, type MessageShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { AnyMessages, TypeUrls } from "@spine-event-engine/core";
import {
  InvokerIdSchema,
  type InvokerId,
} from "@access-desk/resources-model/generated/accessdesk/resources/identifiers_pb.js";

/**
 * The entity that starts a flow, as the address its outcome returns to.
 *
 * @param idSchema The kind of the entity's identifier.
 * @param id The entity's identifier.
 * @param stateSchema The kind of the entity's state, which names the entity kind.
 * @returns The entity as an invoker.
 */
export function invokerOf<IdSchema extends GenMessage<Message>>(
  idSchema: IdSchema,
  id: MessageShape<IdSchema>,
  stateSchema: GenMessage<Message>,
): InvokerId {
  return create(InvokerIdSchema, {
    id: AnyMessages.pack(idSchema, id),
    type: TypeUrls.derive(stateSchema),
  });
}

/**
 * The entity an outcome returns to, when it is of the expected kind.
 *
 * An invoker of another kind, or one whose identifier does not read back as
 * the expected kind, is not related and routes nowhere.
 *
 * @param invoker The entity that started the flow, when known.
 * @param stateSchema The kind of the expected entity's state.
 * @param idSchema The kind of the expected entity's identifier.
 * @returns The related entity's identifier, or none.
 */
export function relatedInvoker<IdSchema extends GenMessage<Message>>(
  invoker: InvokerId | undefined,
  stateSchema: GenMessage<Message>,
  idSchema: IdSchema,
): MessageShape<IdSchema>[] {
  if (invoker?.type !== TypeUrls.derive(stateSchema) || invoker.id === undefined) {
    return [];
  }
  const id = AnyMessages.unpack(invoker.id, idSchema);
  return id === undefined ? [] : [id];
}
