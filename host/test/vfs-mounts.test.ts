import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "../src/vfs";
import {
  MountRouterProvider,
  listMountPaths,
  normalizeMountMap,
  normalizeMountPath,
} from "../src/vfs/mounts";

const isENOENT = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return error.code === "ENOENT" || error.code === "ERRNO_2" || error.errno === 2;
};

const isEXDEV = (err: unknown) => {
  const error = err as NodeJS.ErrnoException;
  return error.code === "EXDEV" || error.code === "ERRNO_18" || error.errno === 18;
};

test("normalizeMountPath validates and normalizes", () => {
  assert.throws(() => normalizeMountPath(""), /non-empty string/);
  assert.throws(() => normalizeMountPath("relative"), /must be absolute/);
  assert.throws(() => normalizeMountPath("/bad\0path"), /null bytes/);
  assert.equal(normalizeMountPath("/data/"), "/data");
});

test("normalizeMountMap rejects invalid providers and duplicates", () => {
  const provider = new MemoryProvider();
  assert.throws(() => normalizeMountMap({ "/data": {} as any }), /invalid/);
  assert.throws(
    () => normalizeMountMap({ "/data": provider, "/data/": provider }),
    /duplicate mount path/
  );
});

test("listMountPaths sorts normalized entries", () => {
  const provider = new MemoryProvider();
  const paths = listMountPaths({ "/b": provider, "/a/": provider });
  assert.deepEqual(paths, ["/a", "/b"]);
});

test("MountRouterProvider merges virtual children", async () => {
  const rootProvider = new MemoryProvider();
  const rootHandle = await rootProvider.open("/root.txt", "w+");
  await rootHandle.writeFile("root");
  await rootHandle.close();

  const appProvider = new MemoryProvider();
  const appHandle = await appProvider.open("/info.txt", "w+");
  await appHandle.writeFile("info");
  await appHandle.close();

  const router = new MountRouterProvider({ "/": rootProvider, "/app": appProvider });

  const rootEntries = await router.readdir("/");
  assert.ok(rootEntries.includes("root.txt"));
  assert.ok(rootEntries.includes("app"));

  const appStats = await router.stat("/app");
  assert.ok(appStats.isDirectory());

  const appEntries = await router.readdir("/app");
  assert.ok(appEntries.includes("info.txt"));

  await assert.rejects(
    () => router.rename("/root.txt", "/app/other.txt"),
    isEXDEV
  );
});

test("MountRouterProvider exposes virtual root without base mount", async () => {
  const dataProvider = new MemoryProvider();
  const router = new MountRouterProvider({ "/data": dataProvider });

  const rootEntries = await router.readdir("/");
  assert.deepEqual(rootEntries, ["data"]);

  const rootStats = await router.stat("/");
  assert.ok(rootStats.isDirectory());

  await assert.rejects(() => router.open("/missing.txt", "r"), isENOENT);
});
