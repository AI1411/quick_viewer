# QuickView

macOS向けの高速ファイルビューアアプリ。CSV/TSV、PDF、Markdown、Excel、画像ファイルをタブ形式で快適に閲覧できます。画像は形式の変換と圧縮もできます。

## 対応ファイル形式

| 形式 | 拡張子 | 主な機能 |
|------|--------|---------|
| CSV / TSV | `.csv` `.tsv` | 仮想スクロール・列ソート・フィルタ・全体検索・エクスポート・文字コードの自動判定（Shift_JIS など） |
| PDF | `.pdf` | ページナビゲーション・サムネイル・目次・全文検索・テキスト選択・ハイライト注釈 |
| Markdown | `.md` `.markdown` | プレビュー/ソース/分割表示・編集と保存・数式・Mermaidダイアグラム |
| Excel | `.xlsx` | シート切り替え・数値フォーマット・フリーズペイン・列ソート・フィルタ・CSV エクスポート |
| 画像 | `.heic` `.jpg` `.png` `.webp` `.avif` `.tiff` `.gif` `.bmp` ほか（RAW・PSD も表示可） | 表示・形式変換・圧縮・リサイズ・位置情報の削除・一括変換 |

### 表（CSV / TSV / Excel）

- 列見出しをクリックすると並べ替えます。数値の列は数値として並べます。`1,234`、`¥1,000`、`12%` のような表記も数値として扱います。
- 文字列は日本語の辞書順（五十音順、JIS の漢字の順）で並べます。ひらがなとカタカナ、全角と半角の英字は同じ位置に並びます。
- 空のセルは昇順でも降順でも末尾に置きます。
- `.tsv` は設定の区切り文字にかかわらず、常にタブ区切りとして読みます。

JIS 第1・第2水準に無い漢字（髙、﨑、𠮷 など）は、CSV と Excel で並び順が異なります。CSV はコード順、Excel は部首画数順です。

### Markdown の編集

ソース表示か分割表示で編集し、`Cmd+S` で保存します。保存時は読み込んだときの文字コード（UTF-8、Shift_JIS など）と BOM を保ちます。元の文字コードで表せない文字があるときは保存しません。

### 画像の変換・圧縮

画像を開くと右側に「変換・圧縮」パネルが出ます。設定を変えるたびに変換後のサイズを表示し、「変換後」に切り替えると仕上がりを確認できます。

- 書き出し形式: JPEG / PNG / HEIC / AVIF / WebP / TIFF / GIF / BMP（HEIC と AVIF は macOS が対応している場合）
- 圧縮: 品質（1〜100）で指定するか、目標サイズ（KB）を指定して収まる最高の品質を自動で選ぶ
- リサイズ: 長辺のピクセル数、または割合で指定（拡大はしない）
- メタデータ: 保持 / 位置情報だけ削除 / すべて削除
- 一括変換: 「複数の画像を一括変換...」から複数ファイルを同じ設定で変換。既存のファイルは上書きしない

元のファイルは変更しません。画像の読み書きは macOS 標準の ImageIO を使います（WebP の書き出しのみ libwebp）。

### 共通の動き

- 開いているファイルが外部で変更されると、再読み込みするか確認します。再読み込みしても、並べ替え、絞り込み、表示中のシート、ページ、スクロール位置を保ちます。
- タブを切り替えても、各タブの表示状態を保ちます。
- Finder から CSV、TSV、PDF、Markdown、Excel のファイルを開けます。
- 起動時に新しいバージョンを確認し、あれば通知から更新して再起動できます。
- ウィンドウの大きさと位置を次回の起動時に復元します。

## インストール

### 方法1: DMGからインストール（推奨）

1. [Releases](https://github.com/AI1411/quick_viewer/releases) から最新の `QuickView_x.x.x_aarch64.dmg` をダウンロード
2. DMGを開いてアプリを `/Applications` にドラッグ
3. 初回起動時に **「壊れているため開けません」と表示される場合**は、現在コード署名・公証が未実装のため macOS Gatekeeper がブロックします。ターミナルで以下を実行してください:

   ```bash
   xattr -cr /Applications/QuickView.app
   ```

   quarantine フラグが剥がれて起動できるようになります。

   > **注意:** 現在のリリースは Apple Developer ID 署名なし（未公証）です。将来のバージョンでコード署名・公証を追加予定です。

### 方法2: ソースからビルド

**必要環境:**
- macOS 13以降
- Rust 1.77以降 (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Node.js 20以降

```bash
# リポジトリをクローン
git clone https://github.com/AI1411/quick_viewer.git
cd quick_viewer

# 依存関係をインストール（ESLint のプラグインが peer 依存を満たさないため、オプションが必要）
npm install --legacy-peer-deps

# 開発サーバー起動
npm run tauri dev

# リリースビルド
npm run tauri build
```

## 使い方

### ファイルを開く

- **ドラッグ＆ドロップ**: ファイルをウィンドウにドロップ
- **キーボード**: `Cmd+O` でファイルダイアログ
- **最近開いたファイル**: タイトルバーの時計アイコンから

### キーボードショートカット

| ショートカット | 動作 |
|--------------|------|
| `Cmd+O` | ファイルを開く |
| `Cmd+S` | Markdown を保存 |
| `Cmd+W` | 現在のタブを閉じる |
| `Cmd+Q` | 終了 |
| `Cmd+1`〜`9` | タブ切り替え |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 次のタブ / 前のタブ |
| `Cmd+F` | 検索 |
| `Cmd+G` / `Cmd+Shift+G` | 次の一致 / 前の一致 |
| `Cmd+B` | サイドバー表示切り替え |
| `Cmd+,` | 設定 |
| `Cmd++` / `Cmd+-` | ズームイン / ズームアウト |
| `Cmd+0` | ズームリセット |

## 開発

```bash
# フロントエンド（lint・型チェック・テスト。CI と同じ）
npm run ci

# Rust（整形・clippy・テスト。CI と同じ）
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

`main` への push と PR で、GitHub Actions が上の検査を両方実行します。

## リリース

リリース手順は [docs/RELEASE.md](docs/RELEASE.md) を参照。ワンコマンドで changelog 確認 → バージョン bump → tag push までを行い、GitHub Actions が DMG ビルドと Release 作成を自動実行します。

## ライセンス

MIT
