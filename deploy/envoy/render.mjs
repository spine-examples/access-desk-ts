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

/**
 * Prints the configuration of Envoy, which takes the browser's calls to the
 * application.
 *
 * Envoy takes the browser's calls over HTTPS, at `ACCESS_DESK_API_PORT`, and:
 *
 * 1. answers only the page, at `ACCESS_DESK_WEB_HOST` and `_PORT`;
 * 2. passes each Spine method, as `spine-methods.json` lists them,
 *    and each of the gateway's own endpoints, for signing in and the
 *    session, as `gateway-endpoints.json` lists them, on to the gateway: each
 *    by its exact path, as a `POST`;
 * 3. refuses everything else, before it reaches the gateway.
 *
 * Each call has a limit on its size and on how long it takes, so a large or
 * slow call cannot hold the gateway. A subscription's stream is the one call
 * without a time limit: it stays open, while nothing changes, as long as the
 * page watches.
 *
 * Envoy decides nothing about who calls. The gateway signs people in and
 * judges each call.
 *
 * Run it from this directory, with `ACCESS_DESK_WEB_HOST`, `ACCESS_DESK_WEB_PORT`,
 * and `ACCESS_DESK_API_PORT` in the environment:
 *
 *   node render.mjs > envoy.yaml
 */
import process from "node:process";

import gatewayEndpoints from "./gateway-endpoints.json" with { type: "json" };
import spineMethods from "./spine-methods.json" with { type: "json" };

/** Where Envoy reaches the gateway, and where it finds its certificate. */
const CONTAINERS = {
  gateway: { address: "gateway", port: 8080 },
  certificate: "/certs/localhost.pem",
  key: "/certs/localhost-key.pem",
};

/** The largest Spine call Envoy passes on: 1 MiB. */
const SPINE_CALL_BYTES = 1_048_576;

/**
 * The largest call to one of the gateway's own endpoints Envoy passes on:
 * 16 KiB, as the gateway takes no more.
 */
const GATEWAY_ENDPOINT_BYTES = 16_384;

/**
 * How long a call may take: 30 seconds.
 */
const CALL_TIMEOUT_MS = 30_000;

/** The time limit of a call that has none. */
const NO_TIMEOUT_MS = 0;

/** The Spine method that streams a subscription's changes, for as long as the page watches. */
const SUBSCRIPTION_STREAM = "/spine.client.SubscriptionService/Activate";

const AccessDeskEnvoy = {
  /**
   * Renders the configuration.
   *
   * @param {NodeJS.ProcessEnv} environment Where the settings are read.
   * @returns {string} The configuration, as YAML.
   */
  render(environment) {
    const host = AccessDeskEnvoy.setting(environment, "ACCESS_DESK_WEB_HOST");
    const port = AccessDeskEnvoy.setting(environment, "ACCESS_DESK_WEB_PORT");
    const origin = new URL(`https://${host}:${port}`).origin;
    const listenPort = AccessDeskEnvoy.setting(environment, "ACCESS_DESK_API_PORT");
    const routes = [
      ...spineMethods.map((path) => ({
        path,
        timeoutMs: path === SUBSCRIPTION_STREAM ? NO_TIMEOUT_MS : CALL_TIMEOUT_MS,
        maxRequestBytes: SPINE_CALL_BYTES,
      })),
      ...gatewayEndpoints.map((path) => ({
        path: AccessDeskEnvoy.endpoint(path),
        timeoutMs: CALL_TIMEOUT_MS,
        maxRequestBytes: GATEWAY_ENDPOINT_BYTES,
      })),
    ];
    return `static_resources:
  listeners:
    - name: browser_gateway
      address:
        socket_address: { address: 0.0.0.0, port_value: ${listenPort} }
      filter_chains:
        - transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain: { filename: ${CONTAINERS.certificate} }
                    private_key: { filename: ${CONTAINERS.key} }
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: browser_gateway
                stream_idle_timeout: 30s
                request_timeout: 30s
                max_request_headers_kb: 16
                route_config:
                  name: gateway_only
                  virtual_hosts:
                    - name: gateway
                      domains: ["*"]
                      routes:
${routes.map((route) => AccessDeskEnvoy.routes(route)).join("\n")}
                      cors:
                        allow_origin_string_match:
                          - exact: ${origin}
                        allow_credentials: true
                        allow_methods: GET, POST, OPTIONS
                        allow_headers: content-type,x-grpc-web,grpc-timeout,connect-protocol-version,connect-timeout-ms,authorization,x-user-agent,x-spine-csrf
                        expose_headers: grpc-status,grpc-message
                        max_age: "86400"
                        forward_not_matching_preflights: false
                http_filters:
                  - name: envoy.filters.http.buffer
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.buffer.v3.Buffer
                      max_request_bytes: ${String(SPINE_CALL_BYTES)}
                  - name: envoy.filters.http.cors
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.Cors
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: gateway
      connect_timeout: 2s
      type: LOGICAL_DNS
      load_assignment:
        cluster_name: gateway
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: { address: ${CONTAINERS.gateway.address}, port_value: ${String(CONTAINERS.gateway.port)} }
`;
  },

  /**
   * Renders the routes of one gateway call.
   *
   * 1. The call itself, a `POST` to its exact path, goes to the gateway, with
   *    its own limit on its size and on how long it takes.
   * 2. The browser's question whether the page may make the call is answered
   *    by Envoy's CORS rules.
   * 3. Any other such question gets an empty answer, which allows nothing.
   *
   * @param {{ path: string, timeoutMs: number, maxRequestBytes: number }} route The call.
   * @returns {string} The routes, as YAML.
   */
  routes({ path, timeoutMs, maxRequestBytes }) {
    const timeout = `timeout: ${String(timeoutMs / 1000)}s`;
    const call = timeoutMs === NO_TIMEOUT_MS ? `${timeout}, idle_timeout: 0s` : timeout;
    const limit = `                          typed_per_filter_config:
                            envoy.filters.http.buffer:
                              "@type": type.googleapis.com/envoy.extensions.filters.http.buffer.v3.BufferPerRoute
                              buffer: { max_request_bytes: ${String(maxRequestBytes)} }`;
    return `                        - match: { path: ${path}, headers: [{ name: ":method", exact_match: POST }] }
                          route: { cluster: gateway, ${call} }
${limit}
                        - match: { path: ${path}, headers: [{ name: ":method", exact_match: OPTIONS }, { name: origin, present_match: true }, { name: access-control-request-method, exact_match: POST }] }
                          route: { cluster: gateway, ${timeout} }
${limit}
                        - match: { path: ${path}, headers: [{ name: ":method", exact_match: OPTIONS }] }
                          direct_response: { status: 204 }`;
  },

  /**
   * Checks a path of the gateway's own endpoint.
   *
   * An endpoint must not take the path of a Spine method, and must name one
   * exact path, so Envoy passes on nothing else.
   *
   * @param {string} path The endpoint's path.
   * @returns {string} The path.
   */
  endpoint(path) {
    if (spineMethods.includes(path)) {
      throw new Error(`The gateway's endpoint ${path} takes the path of a Spine method.`);
    }
    if (!/^\/(?!\/)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) {
      throw new Error(`The gateway's endpoint ${path} must name one exact path.`);
    }
    return path;
  },

  /**
   * Reads a required setting.
   *
   * @param {NodeJS.ProcessEnv} environment Where the settings are read.
   * @param {string} name The setting.
   * @returns {string} Its value.
   */
  setting(environment, name) {
    const value = environment[name];
    if (value === undefined || value === "") {
      throw new Error(`Set ${name} in .env.`);
    }
    return value;
  },
};

process.stdout.write(AccessDeskEnvoy.render(process.env));
