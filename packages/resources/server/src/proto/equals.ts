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

import { type DescMessage, type MessageShape, equals as messageEquals } from "@bufbuild/protobuf";

/**
 * Whether two Protobuf messages denote the same value.
 *
 * Compares the messages structurally, so callers never depend on a message's
 * internal field layout — most usefully for identifiers, where two identifiers
 * are equal when every field matches. An absent message equals nothing, not even
 * another absent message.
 *
 * @typeParam Desc The message schema type.
 * @param schema The message schema shared by both operands.
 * @param a The first message, or `undefined` when absent.
 * @param b The second message, or `undefined` when absent.
 * @returns True when both messages are present and structurally equal.
 */
export function equals<Desc extends DescMessage>(
  schema: Desc,
  a: MessageShape<Desc> | undefined,
  b: MessageShape<Desc> | undefined,
): boolean {
  return a !== undefined && b !== undefined && messageEquals(schema, a, b);
}
