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
import { Closing } from "../src/closing.js";

describe("Closing should", () => {
  it("close each in the order given, waiting for one before the next", async () => {
    const closed: string[] = [];
    const later = {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        closed.push("later");
      },
    };
    const now = {
      close: () => {
        closed.push("now");
      },
    };

    await Closing.inOrder(later, now);

    expect(closed).toEqual(["later", "now"]);
  });

  it("close the rest when some fail, and report every failure", async () => {
    const closed: string[] = [];
    const failing = (name: string) => ({
      close: () => Promise.reject(new Error(`${name} did not close`)),
    });

    const closing = Closing.inOrder(
      failing("first"),
      {
        close: () => {
          closed.push("second");
        },
      },
      failing("third"),
    );

    await expect(closing).rejects.toThrow(AggregateError);
    const failure = (await closing.catch((error: unknown) => error)) as AggregateError;
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      "first did not close",
      "third did not close",
    ]);
    expect(closed).toEqual(["second"]);
  });
});
