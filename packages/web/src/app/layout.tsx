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
import { isRouteErrorResponse, Link, Outlet, useRouteError } from "react-router";
import { Session } from "../session/session.js";

/** The frame every page of the application shows in. */
export const Layout = {
  /** Shows the application's name, who is signed in, and the page itself. */
  Shell: (): ReactElement => {
    const { state, signOut } = Session.useSession();
    return (
      <>
        <header className="header">
          <Link to="/" className="title">
            Access Desk
          </Link>
          {state.kind === "signedIn" && (
            <span>
              {state.info.person.name}{" "}
              <button
                type="button"
                onClick={() => {
                  void signOut();
                }}
              >
                Sign out
              </button>
            </span>
          )}
        </header>
        <main>{state.kind === "starting" ? <p>Signing in…</p> : <Outlet />}</main>
      </>
    );
  },

  /** Tells that a page failed to show, in place of the page. */
  Failure: (): ReactElement => {
    const error = useRouteError();
    return (
      <main>
        <h1>Something went wrong</h1>
        <p role="alert">
          {isRouteErrorResponse(error)
            ? `${String(error.status)} ${error.statusText}`
            : "The page failed to show. Reload it to try again."}
        </p>
        <Link to="/">Go to the start</Link>
      </main>
    );
  },
};
