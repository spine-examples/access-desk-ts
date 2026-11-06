#
# Copyright 2026 CodeMatters, Lda.
#
# Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
# except in compliance with the License. You may obtain a copy of the License at
#
# https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software distributed under
# the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
# either express or implied. See the License for the specific language governing permissions
# and limitations under the License.
#

#
# Builds the images of Access Desk, from the repository root:
#
#   application  Node with every package built. `compose.yaml` runs the
#                application server or the gateway from it.
#   web          nginx with the built page. It fills in its settings from the
#                container's environment as it starts.
#   envoy        Envoy with its configuration, rendered as the image is built
#                for the page's address and the application's port.
#
# `workspace` and `envoy-configuration` only build what the images take.
#

# Every package, installed and built. The manifests come first, so the
# dependencies are installed again only when they change.
FROM node:24-bookworm-slim AS workspace
WORKDIR /workspace
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/identity/model/package.json packages/identity/model/
COPY packages/identity/server/package.json packages/identity/server/
COPY packages/resources/model/package.json packages/resources/model/
COPY packages/resources/server/package.json packages/resources/server/
COPY packages/app/package.json packages/app/
COPY packages/web/package.json packages/web/
COPY packages/testing/package.json packages/testing/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r run build

# The application server and the gateway, run by Node as an unprivileged user.
FROM workspace AS application
WORKDIR /workspace/packages/app
USER node
ENTRYPOINT ["node"]
CMD ["dist/src/server/main.js"]

# The built page, served by nginx with the templates in `web/templates/`.
FROM nginx:1.30.6-alpine AS web
COPY --from=workspace /workspace/packages/web/dist /srv/web
COPY deploy/web/templates /etc/nginx/templates

# Envoy's configuration, rendered by `envoy/render.mjs` from the settings the
# image is built with.
FROM node:24-bookworm-slim AS envoy-configuration
WORKDIR /envoy
COPY deploy/envoy .
ARG ACCESS_DESK_WEB_HOST
ARG ACCESS_DESK_WEB_PORT
ARG ACCESS_DESK_API_PORT
ARG ACCESS_DESK_GATEWAY_PORT
RUN node render.mjs > envoy.yaml

# Envoy, pinned to an exact image, with that configuration.
FROM envoyproxy/envoy:v1.38.3@sha256:5f7c43e1147412fdb3af578c651c67478a3df818eae89d2261e707e06c209cdb AS envoy
COPY --from=envoy-configuration /envoy/envoy.yaml /etc/envoy/envoy.yaml
