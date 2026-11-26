// アップデータ (tauri-plugin-updater) が読む latest.json を作る。
// アプリは更新の有無を確認して通知するだけで、ダウンロードやインストールはしないため
// 署名は空にしている (インストールするなら署名鍵で .sig を作り、ここに入れる)。
//
// 使い方: node scripts/update-manifest.mjs <version> <owner/repo> <tag> > latest.json

export function buildManifest({ version, repository, tag, pubDate = new Date().toISOString() }) {
  const asset = `QuickView_${version}_aarch64.dmg`;
  return {
    version,
    notes: `https://github.com/${repository}/releases/tag/${tag}`,
    pub_date: pubDate.replace(/\.\d{3}Z$/, "Z"),
    platforms: {
      "darwin-aarch64": {
        url: `https://github.com/${repository}/releases/download/${tag}/${asset}`,
        signature: "",
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, repository, tag] = process.argv.slice(2);
  if (!version || !repository || !tag) {
    console.error("usage: node scripts/update-manifest.mjs <version> <owner/repo> <tag>");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(buildManifest({ version, repository, tag }), null, 2) + "\n");
}
