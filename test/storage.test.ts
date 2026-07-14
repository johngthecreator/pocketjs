import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { jsxPlugin, type PocketFramework } from "../compiler/jsx-plugin.ts";

async function freshStorage(
  snapshot: string | null = null,
  backup: string | null = null,
  commitResults: boolean[] = [],
) {
  const result = await Bun.build({
    entrypoints: [new URL("../src/storage.ts", import.meta.url).pathname],
    format: "esm",
    target: "bun",
  });
  expect(result.success).toBe(true);
  let saved = snapshot;
  const commits: string[] = [];
  const preserveFlags: boolean[] = [];
  (globalThis as Record<string, unknown>).__pocketStorage = {
    load: () => saved,
    loadBackup: () => backup,
    commit: (value: string, preserveBackup: boolean) => {
      commits.push(value);
      preserveFlags.push(preserveBackup);
      const ok = commitResults.shift() ?? true;
      if (ok) saved = value;
      return ok;
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "pocketjs-storage-"));
  const modulePath = join(dir, "storage.mjs");
  await Bun.write(modulePath, await result.outputs[0]!.text());
  const runtime = await import(`${pathToFileURL(modulePath).href}?${Math.random()}`) as {
    storage: import("../src/storage.ts").PocketStorage;
  };
  return { ...runtime, commits, preserveFlags, snapshot: () => saved, dispose: () => rm(dir, { recursive: true, force: true }) };
}

async function bundlePublicImport(framework: PocketFramework): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `pocketjs-storage-import-${framework}-`));
  const entry = join(dir, "main.ts");
  await Bun.write(entry, 'import { storage } from "@pocketjs/framework/storage"; export const value = storage.getItem("probe");\n');
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      target: "browser",
      plugins: [jsxPlugin(framework)],
    });
    expect(result.success).toBe(true);
    expect(await result.outputs[0]!.text()).toContain("storage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("portable storage", () => {
  test("buffers localStorage-style mutations and restores a flushed snapshot", async () => {
    const first = await freshStorage();
    first.storage.setItem("theme", "dark");
    first.storage.setItem("volume", "7");
    expect(first.storage.length).toBe(2);
    expect(first.commits).toEqual([]);
    expect(first.storage.flush()).toBe(true);
    const second = await freshStorage(first.snapshot());
    expect(second.storage.getItem("theme")).toBe("dark");
    expect(second.storage.key(1)).toBe("volume");
    await first.dispose();
    await second.dispose();
  });

  test("rejects corrupted snapshots and quota overflow without mutation", async () => {
    const runtime = await freshStorage("not json");
    expect(runtime.storage.length).toBe(0);
    runtime.storage.setItem("ok", "yes");
    expect(() => runtime.storage.setItem("large", "x".repeat(70_000))).toThrow("quota exceeded");
    expect(runtime.storage.getItem("ok")).toBe("yes");
    expect(runtime.storage.getItem("large")).toBeNull();
    await runtime.dispose();
  });

  test("keeps a failed flush dirty so the same mutation can be retried", async () => {
    const runtime = await freshStorage(null, null, [false, true]);
    runtime.storage.setItem("save", "pending");
    expect(runtime.storage.flush()).toBe(false);
    expect(runtime.storage.flush()).toBe(true);
    expect(runtime.commits).toHaveLength(2);
    await runtime.dispose();
  });

  test("recovers a valid previous snapshot when the primary document is corrupt", async () => {
    const valid = await freshStorage();
    valid.storage.setItem("checkpoint", "4");
    valid.storage.flush();
    const recovered = await freshStorage("broken", valid.snapshot());
    expect(recovered.storage.getItem("checkpoint")).toBe("4");
    recovered.storage.setItem("checkpoint", "5");
    expect(recovered.storage.flush()).toBe(true);
    expect(recovered.preserveFlags).toEqual([true]);
    await valid.dispose();
    await recovered.dispose();
  });

  test.each(["solid", "vue-vapor"] as const)("bundles the public import for %s", async (framework) => {
    await bundlePublicImport(framework);
  });
});
