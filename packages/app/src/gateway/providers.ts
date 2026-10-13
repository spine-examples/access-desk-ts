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

import { create } from "@bufbuild/protobuf";
import { EmailAddressSchema } from "@spine-event-engine/proto";
import { ExternalIdentityIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import {
  createGitHubProvider,
  createGoogleProvider,
  type ExternalIdentity,
  type OidcVerifiedIdentityProvider,
} from "@spine-event-engine/auth";
import { IdentityProvider } from "@access-desk/identity-model/generated/accessdesk/identity/values_pb.js";
import type { VerifiedPerson } from "./access-desk.js";

/**
 * An outside identity provider, such as GitHub or Google, and how the gateway
 * reaches it.
 */
export interface SignInProvider {
  /** Which provider this is. */
  readonly kind: IdentityProvider;
  /** What to call the provider on a sign-in page. */
  readonly label: string;
  /** The provider's page where the person confirms the sign-in. */
  readonly authorizationEndpoint: string;
  /** The client identifier the provider gave Access Desk. */
  readonly clientId: string;
  /** The permissions Access Desk asks the provider for. */
  readonly scopes: readonly string[];
  /** Exchanges the provider's answer for the confirmed account. */
  readonly provider: OidcVerifiedIdentityProvider;
}

/** Calls an identity provider, and logs the provider's reason when it refuses. */
function watched(label: string) {
  return async (address: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(address, init);
    if (!response.ok) {
      let reason = "";
      try {
        const body: unknown = await response.clone().json();
        if (typeof body === "object" && body !== null) {
          const { error, error_description: description } = body as Record<string, unknown>;
          reason = [error, description].filter((part) => typeof part === "string").join(": ");
        }
      } catch {
        // The answer was not JSON, so the status has to do.
      }
      console.warn(
        `${label} answered ${response.status.toString()} at ${new URL(address).pathname}` +
          (reason === "" ? "." : `: ${reason}.`),
      );
    }
    return response;
  };
}

/** How Access Desk is registered with an identity provider as an OAuth application. */
export interface OAuthApplication {
  /** The client identifier the provider gave the application. */
  readonly clientId: string;
  /** The client secret the provider gave the application. */
  readonly clientSecret: string;
}

/** The identity providers people sign in through. */
export const SignInProvider = {
  /**
   * GitHub as an identity provider.
   *
   * Access Desk reads the person's profile and their primary email address, and
   * keeps no GitHub token. An account without a verified primary address cannot
   * sign in.
   *
   * @param application How Access Desk is registered with GitHub.
   * @returns The provider.
   */
  gitHub(application: OAuthApplication): SignInProvider {
    const settings = { ...application, includeVerifiedPrimaryEmail: true };
    const { authorizationEndpoint, recommendedScopes, provider } = createGitHubProvider(settings);
    return {
      kind: IdentityProvider.GITHUB,
      label: "GitHub",
      authorizationEndpoint,
      clientId: application.clientId,
      // The sign-in flow requires `openid`. GitHub knows no such scope and
      // leaves it out of what it grants.
      scopes: [...new Set(["openid", ...recommendedScopes, "user:email"])],
      provider: {
        issuer: provider.issuer,
        async exchangeAuthorizationCode(input) {
          const profile: { login: string | undefined; name: string | undefined } = {
            login: undefined,
            name: undefined,
          };
          // The name comes from the profile GitHub already returns, or the login
          // when there is no name.
          const exchange = createGitHubProvider({
            ...settings,
            fetch: async (address, init) => {
              const response = await watched("GitHub")(address, init);
              if (new URL(address).pathname === "/user" && response.ok) {
                const user: unknown = await response.clone().json();
                if (typeof user === "object" && user !== null) {
                  const { login, name } = user as Record<string, unknown>;
                  profile.login = typeof login === "string" ? login : undefined;
                  profile.name = typeof name === "string" && name.trim() !== "" ? name : undefined;
                }
              }
              return response;
            },
          });
          const identity = await exchange.provider.exchangeAuthorizationCode(input);
          const email = identity?.claims?.email;
          if (identity === undefined || email === undefined) {
            console.warn(
              "GitHub did not confirm an account with one verified primary email address.",
            );
            return undefined;
          }
          return ConfirmedIdentity.of(
            identity.issuer,
            identity.subject,
            email,
            profile.name ?? profile.login,
          );
        },
      },
    };
  },

  /**
   * Google as an identity provider.
   *
   * Access Desk reads the person's name and email address. An account whose
   * address Google has not verified cannot sign in.
   *
   * Setting it up fetches Google's sign-in addresses once.
   *
   * @param application How Access Desk is registered with Google.
   * @returns The provider, or `undefined` when Google could not be reached.
   */
  async google(application: OAuthApplication): Promise<SignInProvider | undefined> {
    // The provider sends no client secret unless told how. Google expects it
    // with the code exchange.
    const google = await createGoogleProvider({
      ...application,
      clientAuthentication: "client_secret_post",
      fetch: watched("Google"),
    });
    if (google === undefined) {
      return undefined;
    }
    return {
      kind: IdentityProvider.GOOGLE,
      label: "Google",
      authorizationEndpoint: google.authorizationEndpoint,
      clientId: application.clientId,
      scopes: google.recommendedScopes,
      provider: {
        issuer: google.provider.issuer,
        async exchangeAuthorizationCode(input) {
          const identity = await google.provider.exchangeAuthorizationCode(input);
          if (identity === undefined) {
            console.warn(
              "Google did not confirm the account. Its answer to the sign-in code was refused or failed the checks.",
            );
            return undefined;
          }
          const { email, email_verified: verified, name } = identity.claims ?? {};
          if (email === undefined || verified !== "true") {
            console.warn(
              email === undefined
                ? "Google confirmed the account but gave no email address for it."
                : "Google confirmed the account, but its email address is not verified.",
            );
            return undefined;
          }
          return ConfirmedIdentity.of(identity.issuer, identity.subject, email, name);
        },
      },
    };
  },
};

/** An account an identity provider has confirmed. */
export const ConfirmedIdentity = {
  /**
   * A confirmed account with its verified email address and name.
   *
   * @param issuer The identity provider that vouches for the account.
   * @param subject The account's permanent identifier with the provider.
   * @param email The email address the provider has verified for the account.
   * @param name The display name, when the provider gives one.
   * @returns The account, as the sign-in flow carries it.
   */
  of(issuer: string, subject: string, email: string, name: string | undefined): ExternalIdentity {
    return { issuer, subject, claims: { email, name: name ?? email } };
  },

  /**
   * The verified person behind a confirmed identity.
   *
   * @param provider The provider that confirmed it.
   * @param identity The identity the provider confirmed.
   * @returns The person, or `undefined` when the identity has no verified email address.
   */
  personIn(provider: IdentityProvider, identity: ExternalIdentity): VerifiedPerson | undefined {
    const { email, name } = identity.claims ?? {};
    return email === undefined
      ? undefined
      : {
          id: create(ExternalIdentityIdSchema, { provider, subject: identity.subject }),
          email: create(EmailAddressSchema, { value: email }),
          name: name ?? email,
        };
  },
};
