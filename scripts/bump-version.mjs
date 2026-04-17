import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const type = process.argv[2];
if (!["patch", "minor", "major"].includes(type)) {
  console.error("Usage: npm run version:bump -- [patch|minor|major]");
  process.exit(1);
}

// package.json のバージョンをパース
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);

const newVersion =
  type === "major" ? `${maj + 1}.0.0` :
  type === "minor" ? `${maj}.${min + 1}.0` :
                     `${maj}.${min}.${pat + 1}`;

// package.json 更新
pkg.version = newVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log(`✔ package.json → ${newVersion}`);

// src-tauri/Cargo.toml 更新（最初の version = "..." 行のみ変更）
const cargo = readFileSync("src-tauri/Cargo.toml", "utf-8");
const updatedCargo = cargo.replace(
  /^version = "[\d.]+"/m,
  `version = "${newVersion}"`
);
writeFileSync("src-tauri/Cargo.toml", updatedCargo);
console.log(`✔ src-tauri/Cargo.toml → ${newVersion}`);

// src-tauri/tauri.conf.json 更新
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf-8"));
conf.version = newVersion;
writeFileSync(
  "src-tauri/tauri.conf.json",
  JSON.stringify(conf, null, 2) + "\n"
);
console.log(`✔ src-tauri/tauri.conf.json → ${newVersion}`);

// git commit + tag
execSync(
  `git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json`
);
execSync(`git commit -m "chore: bump version to ${newVersion}"`);
execSync(`git tag v${newVersion}`);

console.log(`\n✔ Committed and tagged v${newVersion}`);
console.log(`  Next: git push && git push --tags`);
