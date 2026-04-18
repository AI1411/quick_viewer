import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const type = process.argv[2];
if (!["patch", "minor", "major"].includes(type)) {
  console.error("Usage: npm run version:bump -- [patch|minor|major]");
  process.exit(1);
}

// ワークツリーの汚れチェック
try {
  execSync("git diff --quiet && git diff --cached --quiet");
  console.log("✔ ワークツリーはクリーンです");
} catch {
  console.error("❌ 未コミットの変更があります。先にコミットしてください。");
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

// git add （バージョン更新ファイルをステージング）
execSync(
  `git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json`
);

// リリース前チェック
console.log("\n🔍 リリース前チェックを実行中...\n");

// lint チェック
try {
  execSync("npm run lint", { stdio: "inherit" });
  console.log("✔ lint OK");
} catch {
  console.error("❌ lint に失敗しました。リリースを中止します。");
  process.exit(1);
}

// TypeScript 型チェック
try {
  execSync("tsc --noEmit", { stdio: "inherit" });
  console.log("✔ typecheck OK");
} catch {
  console.error("❌ 型チェックに失敗しました。リリースを中止します。");
  process.exit(1);
}

// フロントエンドテスト
try {
  execSync("vitest --run", { stdio: "inherit" });
  console.log("✔ tests OK");
} catch {
  console.error("❌ フロントエンドテストに失敗しました。リリースを中止します。");
  process.exit(1);
}

// Rust テスト
try {
  execSync("cargo test --manifest-path src-tauri/Cargo.toml --quiet", { stdio: "inherit" });
  console.log("✔ cargo test OK");
} catch {
  console.error("❌ Rust テストに失敗しました。リリースを中止します。");
  process.exit(1);
}

console.log("\n✔ リリース前チェック完了\n");

// git commit + tag
execSync(`git commit -m "chore: bump version to ${newVersion}"`);
execSync(`git tag v${newVersion}`);

console.log(`✔ Committed and tagged v${newVersion}`);
console.log(`  Next: git push && git push --tags`);
