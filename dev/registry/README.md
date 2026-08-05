# OpenLAPP local beta registry

This Verdaccio instance is for private beta package testing on one machine. It
binds only to `127.0.0.1:4873`, stores data in the Docker volume
`openlapp-verdaccio-storage`, accepts only `@openlapp/*`, and never proxies a
missing package to npmjs.

The repository and both distributable package manifests use the same internal
`0.x` version. These builds do not create Git tags or GitHub Releases. The LAPP
protocol remains v1 with `schemaVersion: "1.0"`; package and protocol versions
are independent.

## First run

```powershell
pnpm registry:up
pnpm registry:init
pnpm registry:publish
pnpm registry:smoke
```

`registry:init` creates the single Verdaccio user with a random password and
stores only its token in the current user's local application-data directory.
On Windows the token file receives a current-user-only ACL; the token is never
printed. Publishing performs the normal build and tarball smoke test before
uploading the SDK under the `beta` dist-tag.

The Registry endpoint is <http://127.0.0.1:4873>. Package metadata and
tarballs require authentication; the smoke command verifies both authenticated
installation and anonymous-access denial.

## Commands

```powershell
pnpm registry:up       # start and wait for a healthy Registry
pnpm registry:init     # create or validate the local authentication token
pnpm registry:publish  # publish the current internal version
pnpm registry:smoke    # install the exact version into a clean consumer
pnpm registry:logs     # follow container logs
pnpm registry:down     # stop; preserve packages and authentication
pnpm registry:reset -- --confirm=openlapp-verdaccio-storage
                              # destructive: delete packages, user, and signing state
```

Do not expose this Compose service beyond loopback. Its credentials and HTTP
transport are intentionally scoped to one machine. A normal `registry:down`
preserves the named volume; `registry:reset` permanently deletes it.

To test from another local project without changing the global npm registry,
point that process at the protected npm configuration created by
`registry:init`:

```powershell
$env:NPM_CONFIG_USERCONFIG = Join-Path $env:LOCALAPPDATA "OpenLAPP\local-registry\npmrc"
pnpm add @openlapp/lapp@0.1.2
```

That file contains the following registry split plus the local token; do not
copy the token into a project or commit it:

```ini
registry=https://registry.npmjs.org/
@openlapp:registry=http://127.0.0.1:4873/
```

The next changed beta must use a new immutable internal version such as
`0.1.2`; never overwrite an existing version. The first public release later
uses `1.0.0` on npmjs.
