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
import { SpineClientProvider } from "@spine-event-engine/client-react";
import { Client, type ClientRequest } from "@spine-event-engine/client-web";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { OrganizationIdSchema } from "@access-desk/identity-model/generated/accessdesk/identity/identifiers_pb.js";
import { OrganizationViewQuery } from "@access-desk/resources-model/generated/accessdesk/resources/organization/organization_query.js";
import { Config } from "../config.js";

/** Connects React components to the Access Desk API using the Spine browser client. */
export const SpineClient = {
  /**
   * Provides the signed-in user's Spine request scope to descendant components.
   *
   * Scopes requests to the user's organization and authenticates them with the
   * session token. Replaces and closes the client when the user, organization,
   * or token changes, and closes it on unmount.
   */
  Scope: ({
    token,
    person,
    organization,
    children,
  }: {
    readonly token: string;
    readonly person: string;
    readonly organization: string;
    readonly children: ReactNode;
  }): ReactElement => {
    const [request, setRequest] = useState<ClientRequest>();
    useEffect(() => {
      const client = SpineClient.open(token, organization);
      setRequest(client.onBehalfOf(person));
      return () => {
        setRequest(undefined);
        void client.close();
      };
    }, [token, person, organization]);
    return request === undefined ? (
      <p>Connecting…</p>
    ) : (
      <SpineClientProvider request={request}>{children}</SpineClientProvider>
    );
  },

  /**
   * Creates a Spine browser client for the organization using the session token.
   *
   * The caller must close the client when it is no longer needed.
   */
  open(token: string, organization: string): Client {
    return Client.forGrpcWeb(Config.apiUrl, {
      tenant: organization,
      onRequestMetadata: () => ({ authorization: `Bearer ${token}` }),
    });
  },

  /** Builds a query for an organization's view, including its members and resources. */
  organization(
    organization: string,
  ): ReturnType<ReturnType<typeof OrganizationViewQuery.create>["build"]> {
    return OrganizationViewQuery.create()
      .byId(create(OrganizationIdSchema, { uuid: organization }))
      .build();
  },
};
