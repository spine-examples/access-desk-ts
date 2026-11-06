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

import { createBrowserRouter } from "react-router";
import { Home } from "../pages/home.js";
import { NotFound } from "../pages/not-found.js";
import { SignIn } from "../pages/sign-in.js";
import { Session } from "../session/session.js";
import { Layout } from "./layout.js";

/** The pages of the application, and the paths they are at. */
export const AppRouter = {
  /**
   * Builds the router of the pages.
   *
   * - `/` sends a person where they belong: to sign in, or to their
   *   organization.
   * - `/sign-in` signs a person in.
   * - `/organization` shows the organization a signed-in person works in. Its
   *   code is loaded only when it is first opened.
   */
  create(): ReturnType<typeof createBrowserRouter> {
    return createBrowserRouter([
      {
        path: "/",
        Component: Layout.Shell,
        ErrorBoundary: Layout.Failure,
        children: [
          { index: true, Component: Home.Page },
          { path: "sign-in", Component: SignIn.Page },
          {
            Component: Session.Required,
            children: [
              {
                path: "organization",
                lazy: async () => ({
                  Component: (await import("../pages/organization.js")).Organization.Page,
                }),
              },
            ],
          },
          { path: "*", Component: NotFound.Page },
        ],
      },
    ]);
  },
};
