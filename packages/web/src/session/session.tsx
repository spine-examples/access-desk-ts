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

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Navigate, Outlet } from "react-router";
import { Authentication, type SessionInfo } from "../api/authentication.js";

/** Identifies the session token in this tab's `sessionStorage`. */
const STORED = "access-desk.session";

/** An authenticated session validated by the Access Desk API. */
export interface SignedIn {
  /** Identifies an authenticated session. */
  readonly kind: "signedIn";
  /** The bearer token used for authenticated Access Desk API requests. */
  readonly token: string;
  /** The signed-in user's profile and optional organization membership. */
  readonly info: SessionInfo;
}

/**
 * Tracks session initialization and authentication for the browser tab.
 *
 * `starting` means session restoration is in progress. `signedOut` means no
 * validated session is available and may include a sign-in error to display.
 * `signedIn` holds the validated token and user information.
 */
export type SessionState =
  | { readonly kind: "starting" }
  | { readonly kind: "signedOut"; readonly problem?: string }
  | SignedIn;

/** The session state and actions exposed to React components. */
export interface SessionValue {
  /** The current initialization or authentication state. */
  readonly state: SessionState;
  /** Requests session revocation and clears the browser tab's session. */
  readonly signOut: () => Promise<void>;
}

/** Shares session state and the sign-out action with descendant components. */
const SessionContext = createContext<SessionValue | undefined>(undefined);

/** Provides session state, authentication hooks, and protected routes for React components. */
export const Session = {
  /**
   * Restores and provides the browser tab's session to descendant components.
   *
   * Completes a pending sign-in or restores the saved token, then validates it
   * with the Access Desk API. Keeps the validated token in `sessionStorage`
   * and clears it when validation fails or the user signs out.
   */
  Provider: ({ children }: { readonly children: ReactNode }): ReactElement => {
    const [state, setState] = useState<SessionState>({ kind: "starting" });

    /**
     * Validates a token and updates the stored token and React session state.
     *
     * @param token The token to validate, or `undefined` to clear the session.
     * @param problem The sign-in error to display if no valid session is available.
     */
    const adopt = useCallback(async (token: string | undefined, problem?: string) => {
      const info = token === undefined ? undefined : await Authentication.session(token);
      if (token === undefined || info === undefined) {
        sessionStorage.removeItem(STORED);
        setState(problem === undefined ? { kind: "signedOut" } : { kind: "signedOut", problem });
        return;
      }
      sessionStorage.setItem(STORED, token);
      setState({ kind: "signedIn", token, info });
    }, []);

    useEffect(() => {
      void (async () => {
        const signedIn = await Authentication.finishSignIn();
        await adopt(
          signedIn ?? sessionStorage.getItem(STORED) ?? undefined,
          signedIn === undefined ? "Signing in did not finish. Try again." : undefined,
        );
      })();
    }, [adopt]);

    /** Requests session revocation and clears the browser tab's session. */
    const signOut = useCallback(async () => {
      if (state.kind === "signedIn") {
        await Authentication.signOut(state.token);
      }
      await adopt(undefined);
    }, [state, adopt]);

    const value = useMemo(() => ({ state, signOut }), [state, signOut]);
    return <SessionContext value={value}>{children}</SessionContext>;
  },

  /**
   * Returns the current session state and sign-out action.
   */
  useSession(): SessionValue {
    const value = use(SessionContext);
    if (value === undefined) {
      throw new Error("A page reads the session outside `Session.Provider`.");
    }
    return value;
  },

  /**
   * Returns the validated session and sign-out action for authenticated components.
   */
  useSignedIn(): SignedIn & Pick<SessionValue, "signOut"> {
    const { state, signOut } = Session.useSession();
    if (state.kind !== "signedIn") {
      throw new Error("A page for signed-in people shows outside `Session.Required`.");
    }
    return { ...state, signOut };
  },

  /** Renders nested routes for signed-in users and redirects others to `/sign-in`. */
  Required: (): ReactElement => {
    const { state } = Session.useSession();
    return state.kind === "signedIn" ? <Outlet /> : <Navigate to="/sign-in" replace />;
  },
};
