// `app` itself does the same `import ... from "lib"`
import { dur1 } from "app";

// `Duration` here comes from `lib/src/Duration.ts` (via the `paths` alias).
import { dur2 } from "lib";

// error TS2367: This comparison appears to be unintentional
// because the types 'import("/tmp/ts7-symlink-repro/real/lib/index").Duration'
// and 'import("/tmp/ts7-symlink-repro/link/lib/index").Duration' have no
// overlap.
console.log(dur1 === dur2)
