import { expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fixture = `${root}test/fixtures/storage-psp`;
const runner = [
  process.env.PPSSPP_HEADLESS,
  `${homedir()}/ppsspp-src/build/PPSSPPHeadless`,
  Bun.which("PPSSPPHeadless"),
  Bun.which("PPSSPPSDL"),
].find((candidate) => candidate && existsSync(candidate));
const eboot = `${root}native/target/mipsel-sony-psp/debug/EBOOT.PBP`;

function configuredMemoryStick(): string {
  if (process.env.PPSSPP_MEMSTICK) return process.env.PPSSPP_MEMSTICK;
  const configs = [
    `${homedir()}/.config/ppsspp/PSP/SYSTEM/ppsspp.ini`,
    `${homedir()}/.ppsspp/PSP/SYSTEM/ppsspp.ini`,
  ];
  for (const config of configs) {
    if (!existsSync(config)) continue;
    const text = readFileSync(config, "utf8");
    const explicit = text.match(/^MemStickDirectory\s*=\s*(.+?)\s*$/m)?.[1];
    if (explicit) return explicit;
    const current = text.match(/^CurrentDirectory\s*=\s*(.+?)\s*$/m)?.[1];
    const root = current?.match(/^(.*)\/PSP\/GAME(?:\/.*)?$/)?.[1];
    if (root) return root;
  }
  return `${homedir()}/.ppsspp`;
}

const storeDir = `${configuredMemoryStick()}/PSP/SAVEDATA/POCKETJS`;
const stem = `${storeDir}/dev.pocket-stack.e2e.psp.storage.storage`;

function boots(path = stem): string | undefined {
  const document = JSON.parse(readFileSync(path, "utf8")) as { d: [string, string][] };
  return document.d.find(([key]) => key === "boots")?.[1];
}

async function boot(): Promise<void> {
  if (!runner) throw new Error("PPSSPPHeadless/PPSSPPSDL not found");
  rmSync(`${configuredMemoryStick()}/dc_cap`, { recursive: true, force: true });
  const headless = basename(runner).includes("Headless");
  const result = Bun.spawnSync([
    runner,
    "--graphics=software",
    ...(headless ? ["--timeout=45"] : ["--escape-exit"]),
    eboot,
  ], { cwd: "/tmp", stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(0);
}

const pspTest = runner ? test : test.skip;

pspTest("PSP storage survives restart and recovers without replacing its valid backup", async () => {
  rmSync(stem, { force: true });
  rmSync(`${stem}.bak`, { force: true });
  rmSync(`${stem}.tmp`, { force: true });
  mkdirSync(storeDir, { recursive: true });

  await $`bun ${root}scripts/pocket.ts build --target psp --manifest ${fixture}/pocket.json --project-root ${fixture} --outdir ${root}dist/storage-e2e -- --capture`
    .cwd(root)
    .env({ ...process.env, POCKETJS_CAP_START: "0", POCKETJS_CAP_N: "1" })
    .quiet();

  await boot();
  expect(boots()).toBe("1");

  await boot();
  expect(boots()).toBe("2");
  expect(boots(`${stem}.bak`)).toBe("1");

  writeFileSync(stem, "corrupt primary");
  await boot();
  expect(boots()).toBe("2");
  expect(boots(`${stem}.bak`)).toBe("1");

  writeFileSync(`${stem}.tmp`, JSON.stringify({ v: 1, c: 0, d: [["boots", "999"]] }));
  await boot();
  expect(boots()).toBe("3");
}, 180_000);
