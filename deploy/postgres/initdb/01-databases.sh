#!/bin/sh
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
# Makes the databases the settings name, for local development, unless they
# are there already.
#
# The PostgreSQL server runs it when it first starts, and `pnpm run
# postgres:start` runs it on every start, so an organization added to
# ACCESS_DESK_ORGANIZATIONS gets its database. Spine creates the tables inside
# the databases. It does not create databases.
#
set -eu

# Makes one database, unless it is there already. PostgreSQL cuts a name
# longer than 63 characters short, so two databases could end up with one
# name; such a name is refused instead.
create() {
    if [ "${#1}" -gt 63 ]; then
        echo "The database name \"$1\" is longer than 63 characters." >&2
        exit 1
    fi
    psql -v ON_ERROR_STOP=1 --quiet --username "$POSTGRES_USER" --dbname postgres \
        --set=name="$1" <<'SQL'
SELECT format('CREATE DATABASE %I', :'name')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'name')\gexec
SQL
}

# The people, the accounts they sign in with, their email addresses, and
# their memberships. The application server keeps them for Identity.
create "$ACCESS_DESK_IDENTITY_DATABASE"

# Each organization, in a database of its own, as Resources keeps every
# organization apart.
for organization in $(echo "$ACCESS_DESK_ORGANIZATIONS" | tr ',' ' '); do
    create "$(echo "$ACCESS_DESK_ORGANIZATION_DATABASE" | sed "s/{organization}/$organization/g")"
done

# What people subscribed to in Resources, which belongs to no one
# organization.
create "$ACCESS_DESK_RESOURCES_DATABASE"

# The subscriptions people hold and the sessions they ended. The gateway
# keeps them.
create "$ACCESS_DESK_GATEWAY_DATABASE"

# The tests on PostgreSQL connect to the database their address names to make
# their throwaway databases, and delete them when they finish.
tests=${ACCESS_DESK_TEST_DATABASE_URL##*/}
create "${tests%%\?*}"
