// `Duration` here comes from `lib/src/Duration.ts` (via the `paths` alias).
import { make, type Duration } from "lib"
// `millis` comes from `app`, whose own `import ... from "lib"` is resolved by
// module resolution and redirected to the referenced project's `dist/` output.
import { millis } from "app"

const d: Duration = make(1)
export const n = millis(d)
