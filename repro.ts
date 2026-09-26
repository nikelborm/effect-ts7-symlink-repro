#!/usr/bin/env bun
// =============================================================================
//  TypeScript 7 (`tsc -b`) + a cwd that is spelled through a symlink
//                          ->  bogus "two identities for one module" errors
// =============================================================================
//
//  Minimal reproduction, distilled from a full Effect monorepo build
//  (Effect-TS/effect @ 3788b63b, `tsc -b tsconfig.json` in a pnpm workspace).
//
//  What this script does, in order:
//
//    1. copies the tiny fixture in ./repro to a REAL directory:
//         $WORK/real                     (default /tmp/ts7-symlink-repro/real)
//    2. creates the symlink
//         $WORK/link  ->  $WORK/real
//    3. `tsc -b tsconfig.json` from the SYMLINKED path
//    4. `tsc -b tsconfig.json` from the REAL path            (control)
//    5. `tsc -b tsconfig.json` from the SYMLINKED path with `PWD` scrubbed
//
//  Same directory, same node_modules, same compiler binary, same user.
//  The ONLY difference is the spelling of the cwd.
//
//  Expected:
//    3. one TS2741 error: the same file is reached under two different path
//       spellings (`$WORK/link/lib/dist/Duration` and
//       `$WORK/real/lib/src/Duration`) and therefore gets two module
//       identities, so the branded `Duration` types no longer match;
//    4. clean;
//    5. clean.
//
//  Step 5 shows the input the compiler actually trusts: the process' `$PWD`
//  (the logical spelling a shell sets when you `cd` through a symlink), which
//  is mixed with otherwise realpath-canonicalised paths.  `cd -P`, `pwd -P`,
//  `PWD=$(pwd -P)` and `env -u PWD` all avoid it.
//
//  Compilers: reproduces on `typescript@7.0.2` (npm `latest`) and on
//  `typescript@7.1.0-dev.20260926.1` (npm `next`).
//
//  Distilled from, and regression tested by hand against, the whole Effect work
//  tree (Effect-TS/effect, fork branch 8af27308a0 on top of 3788b63b) with
//  `tsc -b tsconfig.json`: 5954 errors through the symlinked cwd, 12
//  pre-existing errors via the real path (those come from the branch itself,
//  not from this bug).  Same defect, ~40 lines instead of ~100000.
//
//  Exit status: 0 = bug reproduced, 1 = not reproduced, 2 = setup failure.
//
//  Run: `./repro.ts` (or `bun repro.ts`); verified on bun 1.4.2.
//
//  Overrides: TSC, WORK, TOOLCHAIN, TS_VERSION, SKIP_INSTALL=1
// =============================================================================

import { constants } from "node:fs";
import {
	access,
	cp,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { arch, platform, release, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { $ } from "bun";

// --------------------------------------------------------------------------- #
// configuration
// --------------------------------------------------------------------------- #

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "repro");

const WORK = process.env.WORK ?? join(tmpdir(), "ts7-symlink-repro");
const TOOLCHAIN = process.env.TOOLCHAIN ?? join(WORK, "toolchain");
const REAL = join(WORK, "real");
const LINK = join(WORK, "link");
const LOGS = join(WORK, "logs");

const TS_VERSION = process.env.TS_VERSION ?? "7.0.2";
const SKIP_INSTALL = process.env.SKIP_INSTALL === "1";

/** The fixture entries copied into the work tree. */
const FIXTURE_ENTRIES = ["tsconfig.json", "check.ts", "lib", "app"] as const;

const BANNER = "-".repeat(75);

type Label = "symlinked" | "real" | "pwd-scrubbed";

/**
 * One `tsc -b` run: the cwd to launch in, plus the `$PWD` the compiler sees.
 * `pwd` is the whole input to the bug -- `null` scrubs it, like `env -u PWD`.
 */
interface Run {
	readonly label: Label;
	readonly cwd: string;
	readonly pwd: string | null;
}

// --------------------------------------------------------------------------- #
// helpers
// --------------------------------------------------------------------------- #

/** `---` / title / `---`, the shape every step's output takes. */
function section(title: string): void {
	console.log(BANNER);
	console.log(title);
	console.log(BANNER);
}

async function canAccess(
	path: string,
	mode: number = constants.F_OK,
): Promise<boolean> {
	try {
		await access(path, mode);
		return true;
	} catch {
		return false;
	}
}

/** `grep -c` semantics: number of lines containing `needle`. */
function countLines(text: string, needle: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.includes(needle)) count++;
	}
	return count;
}

/** Every path below `root`, `find`-style and node_modules-free. */
async function listTree(root: string, prefix = "."): Promise<string[]> {
	const paths: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = `${prefix}/${entry.name}`;
		paths.push(path);
		if (entry.isDirectory())
			paths.push(...(await listTree(join(root, entry.name), path)));
	}
	return paths;
}

/** Deletes the build outputs `tsc -b` leaves behind, node_modules excluded. */
async function cleanBuildState(dir: string): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "dist") {
				await rm(path, { recursive: true, force: true });
			} else {
				await cleanBuildState(path);
			}
		} else if (entry.name.endsWith(".tsbuildinfo")) {
			await rm(path, { force: true });
		}
	}
}

// --------------------------------------------------------------------------- #
// 0. the compiler
// --------------------------------------------------------------------------- #

/** A toolchain's `tsc` shim, i.e. `<root>/node_modules/.bin/tsc`. */
function tscIn(root: string): string {
	return join(root, "node_modules", ".bin", "tsc");
}

async function findTsc(): Promise<string | null> {
	for (const candidate of [process.env.TSC, tscIn(TOOLCHAIN), tscIn(FIXTURE)]) {
		if (
			candidate !== undefined &&
			candidate !== "" &&
			(await canAccess(candidate, constants.X_OK))
		) {
			return candidate;
		}
	}
	return null;
}

async function installTsc(): Promise<string> {
	const manifest = join(TOOLCHAIN, "package.json");
	await mkdir(TOOLCHAIN, { recursive: true });
	if (!(await canAccess(manifest))) {
		await writeFile(
			manifest,
			`${JSON.stringify({ name: "toolchain", private: true }, null, 2)}\n`,
		);
	}

	const spec = `typescript@${TS_VERSION}`;
	const manager = (["pnpm", "npm", "bun"] as const).find(
		(name) => Bun.which(name) !== null,
	);
	if (manager === undefined) {
		throw new Error("neither pnpm, npm nor bun is available");
	}

	console.log(`installing ${spec} with ${manager} into ${TOOLCHAIN}`);
	const install =
		manager === "pnpm"
			? await $`pnpm add --silent ${spec}`.cwd(TOOLCHAIN).nothrow().quiet()
			: manager === "npm"
				? await $`npm install --no-fund --no-audit --silent ${spec}`
						.cwd(TOOLCHAIN)
						.nothrow()
						.quiet()
				: await $`bun add ${spec}`.cwd(TOOLCHAIN).nothrow().quiet();
	if (install.exitCode !== 0) {
		throw new Error(`${manager} install failed (exit ${install.exitCode})`);
	}

	const tsc = tscIn(TOOLCHAIN);
	if (!(await canAccess(tsc, constants.X_OK))) {
		throw new Error(`${tsc} is not executable`);
	}
	return tsc;
}

// --------------------------------------------------------------------------- #
// 1. the work tree at its real location
// --------------------------------------------------------------------------- #

async function prepareWorkTree(): Promise<void> {
	await rm(REAL, { recursive: true, force: true });
	await rm(LINK, { recursive: true, force: true });
	await rm(LOGS, { recursive: true, force: true });
	await mkdir(REAL, { recursive: true });
	await mkdir(LOGS, { recursive: true });

	for (const entry of FIXTURE_ENTRIES) {
		await cp(join(FIXTURE, entry), join(REAL, entry), {
			recursive: true,
			preserveTimestamps: true,
		});
	}

	await mkdir(join(REAL, "node_modules"), { recursive: true });
	await symlink("../lib", join(REAL, "node_modules", "lib"));

	console.log(
		[...(await listTree(REAL))]
			.sort()
			.map((path) => `  ${path}`)
			.join("\n"),
	);
}

// --------------------------------------------------------------------------- #
// 3./4./5. compile, three ways
// --------------------------------------------------------------------------- #

/** Runs `tsc -b` once and returns the number of `error TS` lines it printed. */
async function build({ label, cwd, pwd }: Run, tsc: string): Promise<number> {
	const logFile = join(LOGS, `${label}.log`);
	await cleanBuildState(REAL);

	// `env` instead of `.env()`: Bun's shell always forces the child's `PWD` to
	// the spelling of `.cwd()`, so a scrubbed `PWD` can only come from inside.
	const pwdArguments: string[] = pwd === null ? ["-u", "PWD"] : [`PWD=${pwd}`];
	const { exitCode } =
		await $`env ${pwdArguments} ${tsc} -b tsconfig.json &> ${logFile}`
			.cwd(cwd)
			.nothrow()
			.quiet();
	const errorCount = countLines(
		await readFile(logFile, "utf8").catch(() => ""),
		"error TS",
	);

	console.log(`cwd(logical)  = ${cwd}`);
	console.log(`cwd(realpath) = ${await realpath(cwd)}`);
	console.log(`### [${label.padEnd(8)}] exit=${exitCode} errors=${errorCount}`);
	await writeFile(join(LOGS, `${label}.errors`), `${errorCount}\n`);

	return errorCount;
}

// --------------------------------------------------------------------------- #
// the run
// --------------------------------------------------------------------------- #

async function main(): Promise<number> {
	const found = await findTsc();
	const tsc = found ?? (SKIP_INSTALL ? null : await installTsc());
	if (tsc === null) {
		throw new Error("no tsc found and SKIP_INSTALL=1");
	}

	const { username, uid } = userInfo();
	const node = Bun.which("node");
	const nodeInfo =
		node === null
			? "<not found>"
			: `${node} ${(await $`${node} --version`.nothrow().quiet()).stdout.toString().trim()}`;
	const tscVersion = (await $`${tsc} --version`.nothrow().quiet()).stdout
		.toString()
		.trim();

	section("environment");
	console.log(`host        : ${platform()} ${release()} ${arch()}`);
	console.log(`user        : ${username} (${uid})`);
	console.log(`node        : ${nodeInfo}`);
	console.log(`runtime     : bun ${Bun.version}`);
	console.log(`compiler    : ${tsc} (${tscVersion})`);
	console.log(`fixture     : ${FIXTURE}`);
	console.log(`real path   : ${REAL}`);
	console.log(`symlink     : ${LINK} -> ${REAL}`);

	section("step 1: work tree");
	await prepareWorkTree();

	section("step 2: symlink");
	await symlink(REAL, LINK);
	console.log(`created: ${LINK} -> ${REAL}`);

	section("step 3: tsc -b through the SYMLINKED path");
	const symlinkedErrors = await build(
		{ label: "symlinked", cwd: LINK, pwd: LINK },
		tsc,
	);

	section("step 4: tsc -b through the REAL path (control)");
	const realErrors = await build({ label: "real", cwd: REAL, pwd: REAL }, tsc);

	section("step 5: tsc -b through the SYMLINKED path, with PWD scrubbed");
	const scrubbedErrors = await build(
		{ label: "pwd-scrubbed", cwd: LINK, pwd: null },
		tsc,
	);

	const symlinkedLog = await readFile(
		join(LOGS, "symlinked.log"),
		"utf8",
	).catch(() => "");

	section("verdict");
	console.log(`cwd through symlink               : ${symlinkedErrors} errors`);
	console.log(`cwd real path                     : ${realErrors} errors`);
	console.log(`cwd through symlink, PWD scrubbed : ${scrubbedErrors} errors`);

	console.log();
	console.log(
		"evidence -- the compiler names the SAME module twice, once per spelling:",
	);
	const dualIdentity = symlinkedLog
		.split("\n")
		.find((line) => /is missing in type|is not assignable to type/.test(line));
	console.log(dualIdentity ?? "  <no dual-identity diagnostic found>");

	console.log();
	console.log("evidence -- path-spelling counts in the failing log:");
	console.log(`  symlinked (${LINK}): ${countLines(symlinkedLog, LINK)} lines`);
	console.log(`  real      (${REAL}): ${countLines(symlinkedLog, REAL)} lines`);

	console.log();
	if (symlinkedErrors >= 1 && realErrors === 0 && scrubbedErrors === 0) {
		console.log(
			`REPRODUCED (symlinked=${symlinkedErrors} real=${realErrors} pwd-scrubbed=${scrubbedErrors}).`,
		);
		console.log(`Logs in ${LOGS}/`);
		return 0;
	}
	console.log(
		`NOT REPRODUCED (symlinked=${symlinkedErrors} real=${realErrors} pwd-scrubbed=${scrubbedErrors}).`,
	);
	console.log(`Logs in ${LOGS}/`);
	return 1;
}

process.exitCode = await main().catch((error: unknown) => {
	console.log(
		`FATAL: ${error instanceof Error ? error.message : String(error)}`,
	);
	return 2;
});
