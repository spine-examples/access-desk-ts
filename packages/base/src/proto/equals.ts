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
