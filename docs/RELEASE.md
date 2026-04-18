# リリース手順

QuickView のリリースは「タグ push → GitHub Actions がビルドと Release 作成」で完結します。ローカル側の作業は go-task ラッパー（`Taskfile.yml`）経由で行うのが推奨です。

## 前提

初回のみ [go-task](https://taskfile.dev/) をインストール:

```bash
brew install go-task/tap/go-task
```

## 全体フロー

```
[ローカル]
  1. changelog プレビュー     (何が含まれるか確認)
  2. バージョン bump           (package.json / Cargo.toml / tauri.conf.json を更新、commit + tag)
  3. origin へ push            (commit と tag を両方)

[GitHub Actions: release.yml がタグ push で起動]
  4. git-cliff で changelog 自動生成
  5. tauri-action が macOS (aarch64) ビルド
  6. GitHub Release を作成し .dmg / .app.tar.gz をアップロード
```

## ワンショット（推奨）

```bash
task release:patch   # 0.1.2 -> 0.1.3
task release:minor   # 0.1.2 -> 0.2.0
task release:major   # 0.1.2 -> 1.0.0
```

内部的に `changelog` → `bump:<level>` → `push` を連続実行します。bump の出力（更新されるファイルと作成される tag 名）を見て問題なければそのまま push まで走ります。

## 段階実行（慎重に進める場合）

```bash
task changelog       # 次のリリースに入る変更点をプレビュー
task bump:patch      # バージョン更新 + commit + tag 作成（ローカルのみ、まだ push しない）
task push            # commit と tag を origin に push（ここで CI 起動）
```

`bump:<level>` 後にローカルで最終確認したい場合はこちらのフロー。`task push` を実行するまで CI は起動しません。

## CI が行うこと（release.yml）

タグが push されると以下が自動で走ります:

1. `actions/checkout` でリポジトリ全履歴を取得（`fetch-depth: 0`、タグ間の差分計算に必要）
2. `orhun/git-cliff-action` が `cliff.toml` を使って前回タグ〜新タグのチェンジログを生成
3. `tauri-apps/tauri-action` が macOS (aarch64) ビルドを実行し、
4. GitHub Release を作成、Release body に以下を出力:
   - 自動生成チェンジログ（新機能 / バグ修正 / パフォーマンス）
   - インストール手順（DMG のダウンロード方法）
5. `.dmg` と `.app.tar.gz` をリリースアセットとして添付

## バージョン規則

- `v0.1.x`: patch — バグ修正のみ
- `v0.x.0`: minor — 新機能追加（後方互換あり）
- `vx.0.0`: major — 破壊的変更あり
- タグ名は必ず `v` プレフィックス付き（CI の `tags: 'v*'` マッチに必要）

## チェンジログに載る / 載らないコミット

`cliff.toml` の `commit_parsers` が判定。

| commit type | 扱い |
|---|---|
| `feat:` | ### 新機能 |
| `fix:` | ### バグ修正 |
| `perf:` | ### パフォーマンス |
| `chore:` / `docs:` / `test:` / `ci:` / `style:` / `refactor:` | 除外 |

scope は `**scope:**` の形で先頭に表示されます（例: `**csv:** Support flexible column counts to avoid parse errors`）。

## エンドユーザ向けの既知の問題

### 「QuickView が壊れているため開けません」

macOS Gatekeeper が未署名アプリ + quarantine 属性を組み合わせて「damaged」判定するため。Apple Developer Program での正式署名／公証を行なっていないので回避策の案内が必要。

```bash
xattr -cr /Applications/QuickView.app
```

Release body と README に同じ案内を記載済み。将来 $99/年の Developer ID を取得して `.github/workflows/release.yml` の `env:` に Apple 関連 secret を戻せば根本解決できる（`3e33cc0` のコミットコメント参照）。

## トラブルシュート

### タグを間違えて作った

まだ push していない場合:

```bash
git tag -d vX.Y.Z              # ローカルタグ削除
git reset --hard HEAD~1        # bump コミットも取り消したい場合
```

push 済みの場合（Release も作成済みなら、GitHub の Release ページから手動で削除が必要）:

```bash
git push origin :refs/tags/vX.Y.Z   # リモートタグ削除
git tag -d vX.Y.Z                   # ローカルも削除
```

### CI が失敗した

`.github/workflows/release.yml` の Actions ログを確認。よくある原因:

- 署名 secret（`APPLE_CERTIFICATE` など）が設定されていない → 署名なしで build は継続する
- Rust コンパイルエラー → 先にローカルで `npm run tauri build` が通るか確認
- changelog が空 → 前回タグ以降に `feat:` / `fix:` コミットが無い（`chore:` 等は除外される）

### リリース body のチェンジログが変

ローカルで同じ出力を再現するには:

```bash
task changelog
# または
npx git-cliff --unreleased --config cliff.toml
```

テンプレートやグループ分けを変更するときは `cliff.toml` を編集してから改めて `task changelog` で確認。

## 関連ファイル

- `Taskfile.yml` — ローカルの release ラッパー
- `scripts/bump-version.mjs` — バージョンを 3 ファイルに同期、commit + tag
- `cliff.toml` — git-cliff のコミット分類ルールとテンプレート
- `.github/workflows/release.yml` — タグ push で起動する CI
- `src-tauri/tauri.conf.json` — `bundle.icon` 参照の設定
