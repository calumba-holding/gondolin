/**
 * Run a Python script in Gondolin with uv and a persistent shared uv cache.
 *
 * This example:
 * - mounts the current host directory at `/workspace`
 * - rewrites path-like CLI args (e.g. `./script.py`, `hello.py`) to `/workspace/...`
 * - mounts `~/.cache/gondolin-uv` at `/var/cache/uv`
 * - sets `UV_CACHE_DIR=/var/cache/uv`
 * - runs `uv run ...` in `/workspace`
 *
 * Run with:
 *   cd host
 *   pnpm exec tsx examples/uv.ts script.py [args...]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RealFSProvider } from "../src/vfs";
import { VM } from "../src/vm";

const GUEST_WORKSPACE = "/workspace";

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function createDebugLogger(enabled: boolean) {
  const start = Date.now();
  return (message: string) => {
    if (!enabled) return;
    const elapsed = Date.now() - start;
    process.stderr.write(`[uv-example +${elapsed}ms] ${message}\n`);
  };
}

function printUsage() {
  console.log("Usage: pnpm exec tsx examples/uv.ts <script.py|module args...>");
  console.log();
  console.log("Examples:");
  console.log("  pnpm exec tsx examples/uv.ts hello.py");
  console.log("  pnpm exec tsx examples/uv.ts --with requests scripts/fetch.py");
}

function toGuestWorkspacePath(workspaceHostPath: string, hostPath: string): string | null {
  const rel = path.relative(workspaceHostPath, hostPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return path.posix.join(GUEST_WORKSPACE, rel.split(path.sep).join(path.posix.sep));
}

function looksLikePathArg(arg: string): boolean {
  if (path.isAbsolute(arg)) return true;
  if (arg.startsWith(".")) return true;
  if (arg.includes("/") || arg.includes("\\")) return true;
  return arg.endsWith(".py");
}

function rewritePathArgsForGuest(args: string[], workspaceHostPath: string): string[] {
  return args.map((arg) => {
    if (!looksLikePathArg(arg)) return arg;

    const hostPath = path.isAbsolute(arg) ? arg : path.resolve(workspaceHostPath, arg);
    if (!fs.existsSync(hostPath)) return arg;

    const guestPath = toGuestWorkspacePath(workspaceHostPath, hostPath);
    return guestPath ?? arg;
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return args.length === 0 ? 1 : 0;
  }

  const workspaceHostPath = process.cwd();
  const guestArgs = rewritePathArgsForGuest(args, workspaceHostPath);

  const uvCacheHostPath = path.join(os.homedir(), ".cache", "gondolin-uv");
  fs.mkdirSync(uvCacheHostPath, { recursive: true });

  const vm = await VM.create({
    vfs: {
      mounts: {
        [GUEST_WORKSPACE]: new RealFSProvider(workspaceHostPath),
        "/var/cache/uv": new RealFSProvider(uvCacheHostPath),
      },
    },
    env: {
      UV_CACHE_DIR: "/var/cache/uv",
    },
  });

  try {
    const proc = vm.exec(["/usr/bin/uv", "run", ...guestArgs], {
      cwd: GUEST_WORKSPACE,
      stdout: "inherit",
      stderr: "inherit",
      stdin: process.stdin,
    });

    const result = await proc;
    if (result.signal !== undefined) {
      process.stderr.write(`uv exited via signal ${result.signal}\n`);
    }
    return result.exitCode;
  } finally {
    await vm.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
