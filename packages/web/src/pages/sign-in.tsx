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

import { useRequest } from "@spine-event-engine/client-react";
import { useState, type ReactElement } from "react";
import { Navigate } from "react-router";
import { Authentication, type Provider } from "../api/authentication.js";
import { Session } from "../session/session.js";

/** The Access Desk sign-in page. */
export const SignIn = {
  /**
   * Renders sign-in options for the available identity providers.
   *
   * Shows loading and error states, and redirects signed-in users to `/`.
    */
  Page: (): ReactElement => {
    const { state } = Session.useSession();
    const providers = useRequest(() => Authentication.providers(), []);
    const [problem, setProblem] = useState<string>();
    if (state.kind === "signedIn") {
      return <Navigate to="/" replace />;
    }
    const signIn = (provider: Provider) => {
      setProblem(undefined);
      void Authentication.signIn(provider.key).then((started) => {
        if (!started) {
          setProblem(`Signing in through ${provider.label} cannot start now. Try again.`);
        }
      });
    };
    const shown = problem ?? (state.kind === "signedOut" ? state.problem : undefined);
    const offered = providers.status === "success" ? providers.value : undefined;
    return (
      <section>
        <h1>Sign in</h1>
        {providers.status === "idle" || providers.status === "loading" ? (
          <p>Asking the Access Desk API…</p>
        ) : offered === undefined ? (
          <p role="alert">The Access Desk API does not answer.</p>
        ) : (
          <p>
            {offered.map((provider) => (
              <button
                key={provider.key}
                type="button"
                onClick={() => {
                  signIn(provider);
                }}
              >
                Sign in with {provider.label}
              </button>
            ))}
          </p>
        )}
        {shown !== undefined && <p role="alert">{shown}</p>}
      </section>
    );
  },
};
