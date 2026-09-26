#!/usr/bin/env bash
# =============================================================================
#  TypeScript 7 (`tsc -b`) + a cwd that is spelled through a symlink
#                          ->  bogus "two identities for one module" errors
# =============================================================================
#
#  Minimal reproduction, distilled from a full Effect monorepo build
#  (Effect-TS/effect @ 3788b63b, `tsc -b tsconfig.json` in a pnpm workspace).
#
#  What this script does, in order:
#
#    1. copies the tiny fixture in ./repro to a REAL directory:
#         $WORK/real                     (default /tmp/ts7-symlink-repro/real)
#    2. creates the symlink
#         $WORK/link  ->  $WORK/real
#    3. `tsc -b tsconfig.json` from the SYMLINKED path
#    4. `tsc -b tsconfig.json` from the REAL path            (control)
#    5. `tsc -b tsconfig.json` from the SYMLINKED path with `PWD` scrubbed
#
#  Same directory, same node_modules, same compiler binary, same user.
#  The ONLY difference is the spelling of the cwd.
#
#  Expected:
#    3. one TS2741 error: the same file is reached under two different path
#       spellings (`$WORK/link/lib/dist/Duration` and
#       `$WORK/real/lib/src/Duration`) and therefore gets two module
#       identities, so the branded `Duration` types no longer match;
#    4. clean;
#    5. clean.
#
#  Step 5 shows the input the compiler actually trusts: the process' `$PWD`
#  (the logical spelling a shell sets when you `cd` through a symlink), which
#  is mixed with otherwise realpath-canonicalised paths.  `cd -P`, `pwd -P`,
#  `PWD=$(pwd -P)` and `env -u PWD` all avoid it.
#
#  Compilers: reproduces on `typescript@7.0.2` (npm `latest`) and on
#  `typescript@7.1.0-dev.20260926.1` (npm `next`).
#
#  Distilled from, and regression tested by hand against, the whole Effect work
#  tree (Effect-TS/effect, fork branch 8af27308a0 on top of 3788b63b) with
#  `tsc -b tsconfig.json`: 5954 errors through the symlinked cwd, 12
#  pre-existing errors via the real path (those come from the branch itself,
#  not from this bug).  Same defect, ~40 lines instead of ~100000.
#
#  Exit status: 0 = bug reproduced, 1 = not reproduced, 2 = setup failure.
#
#  Overrides: TSC, WORK, TOOLCHAIN, SKIP_INSTALL=1
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/repro"

WORK="${WORK:-${TMPDIR:-/tmp}/ts7-symlink-repro}"
TOOLCHAIN="${TOOLCHAIN:-$WORK/toolchain}"
REAL="$WORK/real"
LINK="$WORK/link"
OUT="$WORK/logs"
TS_VERSION="${TS_VERSION:-7.0.2}"
TSC="${TSC:-}"

log()  { printf '%s\n' "$*"; }
rule() { printf '%s\n' "---------------------------------------------------------------------------"; }

# --------------------------------------------------------------------------- #
# 0. the compiler
# --------------------------------------------------------------------------- #
find_tsc() {
  for candidate in "$TSC" "$TOOLCHAIN/node_modules/.bin/tsc" "$PAYLOAD/node_modules/.bin/tsc"; do
    [ -n "${candidate:-}" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

if ! TSC="$(find_tsc)"; then
  if [ "${SKIP_INSTALL:-0}" = "1" ]; then
    log "FATAL: no tsc found and SKIP_INSTALL=1"; exit 2
  fi
  mkdir -p "$TOOLCHAIN"
  [ -f "$TOOLCHAIN/package.json" ] || printf '{ "name": "toolchain", "private": true }\n' > "$TOOLCHAIN/package.json"
  if command -v pnpm >/dev/null 2>&1; then
    log "installing typescript@$TS_VERSION with pnpm into $TOOLCHAIN"
    pnpm --dir "$TOOLCHAIN" add --silent typescript@"$TS_VERSION" || { log "FATAL: install failed"; exit 2; }
  elif command -v npm >/dev/null 2>&1; then
    log "installing typescript@$TS_VERSION with npm into $TOOLCHAIN"
    npm install --prefix "$TOOLCHAIN" --no-fund --no-audit --silent typescript@"$TS_VERSION" || { log "FATAL: install failed"; exit 2; }
  else
    log "FATAL: neither pnpm nor npm available"; exit 2
  fi
  TSC="$TOOLCHAIN/node_modules/.bin/tsc"
  [ -x "$TSC" ] || { log "FATAL: $TSC not executable"; exit 2; }
fi

rule; log "environment"; rule
log "host        : $(uname -srm)"
log "user        : $(id -un) ($(id -u))"
log "node        : $(command -v node) $(node --version 2>&1)"
log "compiler    : $TSC ($("$TSC" --version 2>&1))"
log "fixture     : $PAYLOAD"
log "real path   : $REAL"
log "symlink     : $LINK -> $REAL"

# --------------------------------------------------------------------------- #
# 1. the work tree at its real location
# --------------------------------------------------------------------------- #
rule; log "step 1: work tree"; rule
rm -rf "$REAL" "$LINK" "$OUT" 2>/dev/null || true
mkdir -p "$REAL" "$OUT" || exit 2
for entry in tsconfig.json check.ts lib app; do
  cp -a "$PAYLOAD/$entry" "$REAL/" || { log "FATAL: cannot copy $entry"; exit 2; }
done
mkdir -p "$REAL/node_modules"
ln -s ../lib "$REAL/node_modules/lib"
log "$(cd "$REAL" && find . -path ./node_modules -prune -o -print | sort | sed 's|^\.|  .|')"

# --------------------------------------------------------------------------- #
# 2. the symlink
# --------------------------------------------------------------------------- #
rule; log "step 2: symlink"; rule
ln -s "$REAL" "$LINK" || exit 2
log "created: $LINK -> $REAL"

# --------------------------------------------------------------------------- #
# 3./4./5. compile, three ways
# --------------------------------------------------------------------------- #
clean_build_state() {
  find "$REAL" -name node_modules -prune -o -name '*.tsbuildinfo' -type f -print0 \
    | xargs -0 -r rm -f
  find "$REAL" -name node_modules -prune -o -name dist -type d -print0 \
    | xargs -0 -r rm -rf
}

build() {
  local label="$1"
  local cwd="$2"
  shift 2
  local log_file="$OUT/$label.log"
  clean_build_state
  ( cd "$cwd" && env "$@" "$TSC" -b tsconfig.json ) >"$log_file" 2>&1
  local rc=$?
  local errors
  errors="$(grep -c 'error TS' "$log_file" 2>/dev/null || true)"
  log "cwd(logical)  = $cwd"
  log "cwd(realpath) = $(cd "$cwd" && pwd -P)"
  printf '### [%-8s] exit=%s errors=%s\n' "$label" "$rc" "$errors"
  printf '%s\n' "$errors" > "$OUT/$label.errors"
}

rule; log "step 3: tsc -b through the SYMLINKED path"; rule
build "symlinked" "$LINK"

rule; log "step 4: tsc -b through the REAL path (control)"; rule
build "real" "$REAL"

rule; log "step 5: tsc -b through the SYMLINKED path, with PWD scrubbed"; rule
build "pwd-scrubbed" "$LINK" -u PWD

# --------------------------------------------------------------------------- #
# verdict
# --------------------------------------------------------------------------- #
SYM_ERRORS="$(cat "$OUT/symlinked.errors")"
REAL_ERRORS="$(cat "$OUT/real.errors")"
PWD_ERRORS="$(cat "$OUT/pwd-scrubbed.errors")"

rule; log "verdict"; rule
printf 'cwd through symlink               : %s errors\n' "$SYM_ERRORS"
printf 'cwd real path                     : %s errors\n' "$REAL_ERRORS"
printf 'cwd through symlink, PWD scrubbed : %s errors\n' "$PWD_ERRORS"

log ""
log "evidence -- the compiler names the SAME module twice, once per spelling:"
grep -m1 -E 'is missing in type|is not assignable to type' "$OUT/symlinked.log" 2>/dev/null | head -1 \
  || log "  <no dual-identity diagnostic found>"

log ""
log "evidence -- path-spelling counts in the failing log:"
printf '  symlinked (%s): %s lines\n' "$LINK" "$(grep -c -F "$LINK" "$OUT/symlinked.log" 2>/dev/null)"
printf '  real      (%s): %s lines\n' "$REAL" "$(grep -c -F "$REAL" "$OUT/symlinked.log" 2>/dev/null)"

log ""
if [ "${SYM_ERRORS:-0}" -ge 1 ] && [ "${REAL_ERRORS:-99}" -eq 0 ] && [ "${PWD_ERRORS:-99}" -eq 0 ]; then
  log "REPRODUCED (symlinked=$SYM_ERRORS real=$REAL_ERRORS pwd-scrubbed=$PWD_ERRORS)."
  log "Logs in $OUT/"
  exit 0
fi
log "NOT REPRODUCED (symlinked=$SYM_ERRORS real=$REAL_ERRORS pwd-scrubbed=$PWD_ERRORS)."
log "Logs in $OUT/"
exit 1
