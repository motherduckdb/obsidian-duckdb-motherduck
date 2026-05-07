import { readFileSync, writeFileSync } from "node:fs";

// Run as the `version` lifecycle hook of `npm version`. The new version is
// already in package.json by this point; mirror it into manifest.json and
// extend versions.json so older Obsidian users keep getting the last plugin
// version that supported their app version. Both files end up staged for
// inclusion in the npm-version commit (see package.json scripts).

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  throw new Error("npm_package_version is not set; run via `npm version`.");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`bumped manifest.json + versions.json to ${targetVersion} (minAppVersion ${minAppVersion})`);
