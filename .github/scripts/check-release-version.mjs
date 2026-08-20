import { readFileSync } from "node:fs";

const tag = process.env.RELEASE_TAG;
if (!tag || !/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(tag)) {
  throw new Error(`RELEASE_TAG must be a version tag such as v0.1.3; got ${tag ?? "<empty>"}`);
}

const expected = tag.slice(1);
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8")
).version;
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const changelog = readFileSync("CHANGELOG.md", "utf8");

const versions = {
  "package.json": packageVersion,
  "src-tauri/tauri.conf.json": tauriVersion,
  "src-tauri/Cargo.toml": cargoVersion,
};
for (const [file, actual] of Object.entries(versions)) {
  if (actual !== expected) {
    throw new Error(`${file} version ${actual ?? "<missing>"} does not match ${tag}`);
  }
}
if (!changelog.includes(`## [${expected}]`)) {
  throw new Error(`CHANGELOG.md has no [${expected}] release section`);
}

console.log(`Release versions match ${tag}`);
