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

import type { ReactElement } from "react";
import { Link } from "react-router";

/** The fallback page for URLs that match no application route. */
export const NotFound = {
  /** Renders a page-not-found message and a link to the home page. */
  Page: (): ReactElement => {
    return (
      <section>
        <h1>No such page</h1>
        <Link to="/">Go to the start</Link>
      </section>
    );
  },
};
