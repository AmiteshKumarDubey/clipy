#!/usr/bin/env node
/**
 * Every package a plugin runs through npx is pinned to an exact version, and
 * all plugins pin the same @clipy/cli. The Claude plugin directory refuses
 * unpinned npx packages, and a skill pinned to an older CLI than the Record
 * button would behave differently in the same session.
 *
 * When a new @clipy/cli is released, bump every pin in plugins/ together.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "plugins");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(pluginsDir).filter((f) => /\.(md|tsx?|json|mjs|js)$/.test(f));
const versions = new Map();
const problems = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file);
  for (const m of text.matchAll(/npx(?:'|")?\s*,?\s*(?:'|")?(?:-y(?:'|")?\s*,?\s*(?:'|")?)?(@?[a-z0-9@/._-]+)/gi)) {
    const spec = m[1];
    const at = spec.lastIndexOf("@");
    const version = at > 0 ? spec.slice(at + 1) : "";
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      problems.push(`${rel}: npx ${spec} is not pinned to an exact version`);
      continue;
    }
    const name = spec.slice(0, at);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(`${version} (${rel})`);
  }
}

assert.deepEqual(problems, [], problems.join("\n"));
const cli = [...(versions.get("@clipy/cli") ?? [])];
const distinct = new Set(cli.map((v) => v.split(" ")[0]));
assert.ok(cli.length > 0, "expected the plugins to run @clipy/cli through npx");
assert.equal(distinct.size, 1, `plugins pin different @clipy/cli versions:\n${cli.join("\n")}`);
console.log(`plugin pins: ok (@clipy/cli@${[...distinct][0]} in ${cli.length} places)`);
