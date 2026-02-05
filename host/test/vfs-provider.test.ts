import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider, SandboxVfsProvider } from "../src/vfs";

test("SandboxVfsProvider hooks wrap handle operations", async () => {
  const provider = new MemoryProvider();
  const events: string[] = [];

  const vfs = new SandboxVfsProvider(provider, {
    before: (ctx) => events.push(`before:${ctx.op}`),
    after: (ctx) => events.push(`after:${ctx.op}`),
  });

  const handle = await vfs.open("/file.txt", "w+");
  await handle.writeFile("hello");
  await handle.close();

  assert.deepEqual(events, [
    "before:open",
    "after:open",
    "before:writeFile",
    "after:writeFile",
    "before:release",
    "after:release",
  ]);
});

test("SandboxVfsProvider sync operations reject async hooks", () => {
  const provider = new MemoryProvider();
  const vfs = new SandboxVfsProvider(provider, {
    before: async () => {
      // async hook should not be used in sync API
    },
  });

  assert.throws(
    () => vfs.openSync("/file.txt", "w"),
    /async hook used in sync operation/
  );
});
