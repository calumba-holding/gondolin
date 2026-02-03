import { VM, ExecStream } from "./vm";

const WS_URL = process.env.WS_URL;
const TOKEN = process.env.ELWING_TOKEN ?? process.env.SANDBOX_WS_TOKEN;
const MAX_CHUNK = 32 * 1024;

let shuttingDown = false;
let exitCode = 1;

function buildEnv() {
  const env: string[] = [];
  if (process.env.TERM) env.push(`TERM=${process.env.TERM}`);
  return env;
}

function wireStdin(exec: ExecStream) {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  process.stdin.on("data", (chunk: Buffer) => {
    if (shuttingDown) return;
    for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
      const slice = chunk.subarray(offset, offset + MAX_CHUNK);
      void exec.sendStdin(slice);
    }
  });

  process.stdin.on("end", () => {
    if (shuttingDown) return;
    void exec.endStdin();
  });
}

function cleanup() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

async function shutdown(vm: VM) {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanup();
  await vm.stop();
  process.exit(exitCode);
}

async function main() {
  const vm = new VM({ url: WS_URL ?? undefined, token: TOKEN ?? undefined });

  try {
    const exec = await vm.execStream(["bash", "-i"], {
      env: buildEnv(),
      stdin: true,
      pty: true,
      buffer: false,
    });

    exec.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    exec.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    wireStdin(exec);

    const result = await exec.result;
    exitCode = result.exitCode ?? 1;
    if (result.signal !== undefined) {
      process.stderr.write(`process exited due to signal ${result.signal}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    exitCode = 1;
  } finally {
    await shutdown(vm);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
