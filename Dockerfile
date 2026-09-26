# syntax=docker/dockerfile:1
# =============================================================================
#  TypeScript 7 (`tsc -b`) breaks when the program's `$PWD` is a symlinked
#  spelling of the real cwd.
# =============================================================================
#
#  Reported scenario, reduced:
#
#    1. a monorepo is checked out in a REAL directory
#    2. a symlink points at (a parent of) that directory
#    3. the shell `cd`s into the tree through the symlink, so `$PWD` is the
#       logical spelling while the process' realpath is the real one
#    4. `tsc -b tsconfig.json` then type-checks one and the same file under two
#       identities: the logical spelling (`.../link/lib/dist/Duration`) and the
#       realpath-canonicalised one (`.../real/lib/src/Duration`)
#
#  Result: bogus errors through the symlinked cwd, clean through the real path,
#  clean again when `PWD` is scrubbed from the environment.
#
#  See ./repro.ts for the assertions and ./repro for the fixture.
# =============================================================================

FROM node:26.10.0-bookworm-slim

# Pinned so the repro cannot drift.  This is the stock npm build of the native
# TypeScript 7 compiler; nothing here depends on Effect or on any package
# manager workspace layout.
ARG TS_VERSION=7.0.2
RUN npm install --global --no-fund --no-audit typescript@"$TS_VERSION"

# The repro is a Bun script; borrow the interpreter from the official image
# (that image installs bun at /usr/local/bin/bun).
COPY --from=oven/bun:1.4.2-debian /usr/local/bin/bun /usr/local/bin/bun

COPY --chmod=0755 repro.ts /usr/local/bin/repro.ts
COPY repro /usr/local/bin/repro

# `tsc` is on PATH, so repro.ts reuses it instead of installing its own copy.
ENV TSC=/usr/local/bin/tsc

ENTRYPOINT ["bun", "/usr/local/bin/repro.ts"]
