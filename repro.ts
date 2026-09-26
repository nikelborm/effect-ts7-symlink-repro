#!/usr/bin/env bun

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { $ } from "bun";

// Scroll to the bottom to see the last steps an the actual error

mkdirSync("repro");
mkdirSync("repro/lib");
mkdirSync("repro/app");

const commonTsConfig = {
	compilerOptions: { composite: true, outDir: "./dist", rootDir: "./" },
	include: ["./index.ts"],
};

// App

mkdirSync("repro/app/node_modules");
symlinkSync("../../lib", "repro/app/node_modules/lib");
writeFileSync(
	"repro/app/tsconfig.json",
	JSON.stringify(
		{ ...commonTsConfig, references: [{ path: "../lib" }] },
		null,
		2,
	),
);
writeFileSync(
	"repro/app/index.ts",
	`import type { Duration } from "lib";
export declare const dur1: Duration
`,
);

// Lib

writeFileSync(
	"repro/lib/tsconfig.json",
	JSON.stringify(commonTsConfig, null, 2),
);
writeFileSync(
	"repro/lib/package.json",
	JSON.stringify(
		{
			name: "lib",
			version: "1.0.0",
			type: "module",
			exports: { ".": "./index.ts" },
		},
		null,
		2,
	),
);
writeFileSync(
	"repro/lib/index.ts",
	`declare const Something: unique symbol;
export interface Duration {
	readonly [Something]: "Duration";
}
export declare const dur2: Duration;
`,
);

// Owner

writeFileSync(
	"repro/check.ts",
	`import { dur1 } from "app";
import { dur2 } from "lib";

console.log(dur1 === dur2)
`,
);
writeFileSync(
	"repro/tsconfig.json",
	JSON.stringify(
		{
			include: ["check.ts"],
			references: [{ path: "./lib" }, { path: "./app" }],
			compilerOptions: {
				composite: true,
				noEmit: true,
				paths: { lib: ["./lib/index.ts"], app: ["./app/index.ts"] },
			},
		},
		null,
		2,
	),
);

// Doesn't fail as expected
await $`cd repro && ../node_modules/.bin/tsc -b`;

rmSync("repro/app/dist", { recursive: true });
rmSync("repro/lib/dist", { recursive: true });
rmSync("repro/tsconfig.tsbuildinfo", { recursive: true });

symlinkSync("./repro", "symlinked-repro");

// UNEXPECTED: Fails with: check.ts(4,13): error TS2367: This comparison appears
// to be unintentional because the types
// 'import("/home/nikel/effect-ts7-symlink-repro/repro/lib/index").Duration' and
// 'import("/home/nikel/effect-ts7-symlink-repro/symlinked-repro/lib/dist/index").Duration'
// have no overlap.
await $`cd symlinked-repro && ../node_modules/.bin/tsc -b`;
