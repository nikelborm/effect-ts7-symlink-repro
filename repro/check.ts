// `millis` comes from `app`, whose own `import ... from "lib"` is resolved by
// module resolution and redirected to the referenced project's `dist/` output.
import { dur1 } from "app";

// `Duration` here comes from `lib/src/Duration.ts` (via the `paths` alias).
import { dur2 } from "lib";

console.log(dur1 === dur2)
