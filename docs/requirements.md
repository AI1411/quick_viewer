# QuickView — 要件定義書

## 1. プロダクト概要

### 1.1 コンセプト

QuickView は、CSV/TSV・PDF・Markdown・Excel（xlsx）の 4 形式に特化した軽量デスクトップファイルビューアである。ブラウザ風タブ UI で複数ファイルを同時に開き、形式ごとに最適化された閲覧・簡易編集機能を提供する。

### 1.2 プロダクトビジョン

- **高速起動・高速描画**: ファイルを開いてから表示まで 500ms 以内を目標とする
- **4 形式に集中**: 対応形式を絞り、各形式で最高の閲覧体験を実現する
- **軽量**: Tauri 2 の小さなバイナリサイズと低メモリ消費を活かす
- **macOS ファースト**: macOS を主要ターゲットとし、将来的に Windows/Linux も視野に入れる

### 1.3 技術スタック

| レイヤー | 技術 |
|---------|------|
| フレームワーク | Tauri 2 |
| フロントエンド | React 19 + TypeScript |
| ビルドツール | Vite |
| スタイリング | Tailwind CSS 4 |
| バックエンド（Rust） | tauri-plugin-fs, pdf-extract / lopdf, calamine (xlsx), pulldown-cmark (Markdown) |
| テーブル仮想化 | TanStack Virtual |
| 状態管理 | Zustand |
| テスト | Vitest (フロント) + Rust テスト |

---

## 2. ターゲットユーザー

| ペルソナ | 説明 |
|---------|------|
| 開発者 | CSV/JSON/Markdown を日常的に扱い、素早く内容確認したい |
| データ分析者 | 大規模 CSV/Excel を高速にプレビュー・フィルタしたい |
| ビジネスユーザー | PDF/Excel を手軽に閲覧し、検索・注釈を付けたい |

---

## 3. 機能要件

### 3.1 共通機能（全形式共通）

#### 3.1.1 タブ管理

| 機能 | 説明 |
|------|------|
| タブ追加 | ファイルを開くとタブが追加される |
| タブ切り替え | クリックまたはキーボードショートカット（Cmd+1〜9）で切り替え |
| タブ閉じる | ×ボタンまたは Cmd+W で閉じる |
| タブ並び替え | ドラッグ＆ドロップで順序変更 |
| タブ右クリックメニュー | 閉じる / 他をすべて閉じる / 右側をすべて閉じる |
| ファイルパス表示 | タブホバーでフルパスをツールチップ表示 |
| 変更インジケータ | 未保存変更がある場合、タブにドットマーク表示 |

#### 3.1.2 ファイル操作

| 機能 | 説明 |
|------|------|
| ファイルを開く | メニュー / Cmd+O / ドラッグ＆ドロップ |
| 最近開いたファイル | 直近 20 件を記録、メニューからアクセス |
| ファイル監視 | 外部変更を検知し、リロード確認ダイアログ表示 |
| エンコーディング自動検出 | UTF-8 / Shift_JIS / EUC-JP を自動判定（手動切り替えも可能） |

#### 3.1.3 検索

| 機能 | 説明 |
|------|------|
| テキスト検索 | Cmd+F で検索バー表示、ハイライト表示 |
| 正規表現検索 | 正規表現モード切り替え |
| 大文字小文字区別 | トグルスイッチ |
| 検索結果ナビゲーション | ↑↓ または Enter/Shift+Enter で前後移動 |

#### 3.1.4 テーマ・外観

| 機能 | 説明 |
|------|------|
| ダークモード / ライトモード | システム設定に追従、手動切り替え可能 |
| フォントサイズ変更 | Cmd+Plus / Cmd+Minus でズーム |
| サイドバー | ファイルツリーまたはアウトライン表示（トグル可能） |

---

### 3.2 CSV/TSV ビューア

FastCsv の設計資産を最大限活用し、QuickView に統合する。

#### 3.2.1 閲覧機能

| 機能 | 説明 |
|------|------|
| 仮想スクロール | TanStack Virtual による 100 万行超対応 |
| 列固定 | 左側 N 列を固定（ピン留め） |
| 列リサイズ | ドラッグで列幅調整 |
| 列ソート | ヘッダクリックで昇順/降順ソート |
| 行番号表示 | 左端に行番号列 |
| ステータスバー | 行数・列数・選択範囲の統計（合計/平均/件数） |

#### 3.2.2 簡易編集機能

| 機能 | 説明 |
|------|------|
| 列フィルタ | 各列ヘッダのフィルタアイコンから条件指定 |
| フィルタ条件 | 完全一致 / 部分一致 / 前方一致 / 正規表現 / 数値比較 |
| 複合フィルタ | 複数列に AND 条件でフィルタ適用 |
| フィルタ結果エクスポート | フィルタ適用状態で CSV 保存 |
| 区切り文字設定 | カンマ / タブ / セミコロン / パイプ / カスタム |

---

### 3.3 PDF ビューア

#### 3.3.1 閲覧機能

| 機能 | 説明 |
|------|------|
| ページレンダリング | PDF.js（WebView 内）でページ描画 |
| ページナビゲーション | スクロール / ページ番号入力 / サムネイル一覧 |
| ズーム | ピンチ / Cmd+Plus/Minus / フィット幅 / フィットページ |
| 見開き表示 | 1ページ / 2ページ見開き / 連続スクロール |
| アウトライン | 目次（ブックマーク）をサイドバーに表示 |
| 回転 | ページ単位で 90° 回転 |

#### 3.3.2 簡易編集機能

| 機能 | 説明 |
|------|------|
| テキスト選択・コピー | テキストレイヤーからの選択・コピー |
| ハイライト注釈 | テキスト範囲をハイライト（黄/緑/青/ピンク） |
| メモ注釈 | 任意の位置にスティッキーノート追加 |
| 注釈の保存 | 注釈を PDF 内に保存（アプリ独自形式での保存も検討） |

---

### 3.4 Markdown ビューア

#### 3.4.1 閲覧機能

| 機能 | 説明 |
|------|------|
| リアルタイムレンダリング | Markdown → HTML のプレビュー表示 |
| シンタックスハイライト | コードブロックの言語別ハイライト（Shiki） |
| GFM 対応 | テーブル / タスクリスト / 脚注 / Strikethrough |
| 数式レンダリング | KaTeX による LaTeX 数式対応 |
| Mermaid | Mermaid ダイアグラムのインライン表示 |
| 目次生成 | 見出しからアウトラインを自動生成、サイドバーに表示 |
| 画像表示 | ローカル画像の相対パス解決と表示 |

#### 3.4.2 簡易編集機能

| 機能 | 説明 |
|------|------|
| ソース/プレビュー切り替え | 生の Markdown ソースとレンダリング結果のトグル |
| スプリットビュー | 左右分割で編集＋プレビュー |
| 簡易テキスト編集 | ソースモードでの直接編集・保存 |

---

### 3.5 Excel（xlsx）ビューア

#### 3.5.1 閲覧機能

| 機能 | 説明 |
|------|------|
| シート切り替え | 下部タブでシート一覧表示・切り替え |
| 仮想スクロール | 大規模シート対応（TanStack Virtual） |
| セル書式表示 | 数値フォーマット / 日付フォーマット の反映 |
| 列リサイズ | ドラッグで列幅調整 |
| フリーズペイン | Excel 設定のフリーズペイン（固定行/列）を反映 |
| ステータスバー | 選択範囲の合計/平均/件数 |

#### 3.5.2 簡易編集機能

| 機能 | 説明 |
|------|------|
| 列フィルタ | CSV と同等のフィルタ機能 |
| 列ソート | ヘッダクリックで昇順/降順 |
| CSV エクスポート | 現在のシートを CSV として書き出し |

---

## 4. 非機能要件

### 4.1 パフォーマンス

| 指標 | 目標値 |
|------|--------|
| アプリ起動時間 | 1 秒以内 |
| ファイル表示（10MB CSV） | 500ms 以内 |
| ファイル表示（50 ページ PDF） | 1 秒以内（初回ページ） |
| メモリ使用量（アイドル） | 100MB 以下 |
| メモリ使用量（100MB CSV 表示時） | 300MB 以下 |
| スクロール FPS | 60fps |

### 4.2 セキュリティ

| 項目 | 対応 |
|------|------|
| Tauri CSP | 厳格な Content Security Policy 設定 |
| ファイルアクセス | tauri-plugin-fs の scope 制限 |
| IPC バリデーション | Rust 側で全入力を検証 |

### 4.3 アクセシビリティ

| 項目 | 対応 |
|------|------|
| キーボードナビゲーション | 全操作をキーボードで完結可能 |
| スクリーンリーダー | ARIA ラベル・ロール適切に設定 |
| ハイコントラスト | ダークモード・ライトモードで十分なコントラスト比 |

---

## 5. キーボードショートカット

| ショートカット | アクション |
|--------------|----------|
| Cmd+O | ファイルを開く |
| Cmd+W | タブを閉じる |
| Cmd+Shift+T | 閉じたタブを再度開く |
| Cmd+1〜9 | タブ切り替え |
| Cmd+Tab | 次のタブへ |
| Cmd+Shift+Tab | 前のタブへ |
| Cmd+F | 検索 |
| Cmd+G | 次の検索結果 |
| Cmd+Shift+G | 前の検索結果 |
| Cmd+Plus | ズームイン |
| Cmd+Minus | ズームアウト |
| Cmd+0 | ズームリセット |
| Cmd+S | 変更を保存 |
| Cmd+Shift+S | 名前を付けて保存 |
| Cmd+, | 設定を開く |
| Cmd+B | サイドバー表示/非表示 |
| Space (PDF) | 次のページ |
| Shift+Space (PDF) | 前のページ |

---

## 6. アーキテクチャ

### 6.1 全体構成

```
┌─────────────────────────────────────────────┐
│                  Tauri 2                     │
│                                             │
│  ┌──────────────────┐  ┌──────────────────┐ │
│  │   React/TS UI    │  │   Rust Backend   │ │
│  │                  │  │                  │ │
│  │  ┌────────────┐  │  │  ┌────────────┐  │ │
│  │  │ Tab Manager│  │  │  │ File I/O   │  │ │
│  │  ├────────────┤  │  │  ├────────────┤  │ │
│  │  │ CSV Viewer │  │  │  │ CSV Parser │  │ │
│  │  │ (TanStack) │◄─┼──┼─►│ (csv crate)│  │ │
│  │  ├────────────┤  │  │  ├────────────┤  │ │
│  │  │ PDF Viewer │  │  │  │ PDF Reader │  │ │
│  │  │ (PDF.js)   │◄─┼──┼─►│ (lopdf)    │  │ │
│  │  ├────────────┤  │  │  ├────────────┤  │ │
│  │  │ MD Viewer  │  │  │  │ MD Parser  │  │ │
│  │  │ (rehype)   │◄─┼──┼─►│ (pulldown) │  │ │
│  │  ├────────────┤  │  │  ├────────────┤  │ │
│  │  │ XLSX View  │  │  │  │ XLSX Reader│  │ │
│  │  │ (TanStack) │◄─┼──┼─►│ (calamine) │  │ │
│  │  └────────────┘  │  │  └────────────┘  │ │
│  │                  │  │                  │ │
│  │  ┌────────────┐  │  │  ┌────────────┐  │ │
│  │  │ Zustand    │  │  │  │ File Watch │  │ │
│  │  │ Store      │  │  │  │ (notify)   │  │ │
│  │  └────────────┘  │  │  └────────────┘  │ │
│  └──────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────┘
```

### 6.2 Rust バックエンド（Tauri コマンド）

| コマンド | 説明 | 入力 | 出力 |
|---------|------|------|------|
| `open_file` | ファイルを開いて形式判定 | file_path | FileInfo (type, size, encoding) |
| `read_csv` | CSV をパースして返す | file_path, options | CsvData (headers, rows, total_rows) |
| `read_csv_chunk` | CSV の部分読み込み | file_path, offset, limit | CsvChunk (rows) |
| `filter_csv` | CSV フィルタ実行 | file_path, filters | FilteredCsvData |
| `export_csv` | フィルタ結果を CSV 保存 | data, output_path | Result |
| `read_pdf_info` | PDF メタデータ取得 | file_path | PdfInfo (pages, outline, metadata) |
| `read_pdf_page` | PDF ページをレンダリング | file_path, page_num, dpi | base64 image |
| `read_markdown` | Markdown をパースして HTML 変換 | file_path | MarkdownData (html, toc, frontmatter) |
| `save_markdown` | Markdown ソースを保存 | file_path, content | Result |
| `read_xlsx` | Excel ブックを読み込む | file_path | XlsxData (sheets, active_sheet) |
| `read_xlsx_sheet` | 特定シートのデータ取得 | file_path, sheet_name | SheetData (headers, rows) |
| `watch_file` | ファイル変更監視開始 | file_path | — (イベント通知) |
| `unwatch_file` | ファイル変更監視停止 | file_path | — |
| `detect_encoding` | エンコーディング検出 | file_path | Encoding |

### 6.3 フロントエンド コンポーネント構成

```
App
├── TitleBar（カスタムタイトルバー）
├── TabBar
│   ├── Tab（ファイルごと）
│   └── NewTabButton
├── Toolbar（形式ごとの操作ボタン）
├── Sidebar（トグル可能）
│   ├── FileOutline（MD/PDF の目次）
│   └── SheetList（xlsx のシート一覧）
├── ViewerArea
│   ├── CsvViewer
│   │   ├── FilterBar
│   │   ├── VirtualTable
│   │   └── StatusBar
│   ├── PdfViewer
│   │   ├── PdfCanvas
│   │   ├── PageNavigator
│   │   └── AnnotationLayer
│   ├── MarkdownViewer
│   │   ├── RenderedView
│   │   ├── SourceEditor
│   │   └── SplitView
│   └── XlsxViewer
│       ├── SheetTabs
│       ├── VirtualTable
│       └── StatusBar
├── SearchBar（Cmd+F で表示）
└── SettingsDialog
```

---

## 7. データフロー

### 7.1 ファイルオープンフロー

```
ユーザー操作（D&D / メニュー / Cmd+O）
  ↓
Rust: open_file(path)
  ↓ 拡張子 + マジックバイト判定
FileInfo { type: "csv" | "pdf" | "md" | "xlsx", size, encoding }
  ↓
React: タブ追加 → 対応 Viewer コンポーネントをレンダリング
  ↓
Rust: read_csv / read_pdf_info / read_markdown / read_xlsx
  ↓
React: データ表示
```

### 7.2 CSV 大規模ファイルフロー

```
read_csv(path, { preview: true, limit: 1000 })
  ↓ 先頭 1000 行 + メタデータ（総行数, 列情報）
初期表示
  ↓ スクロールイベント
read_csv_chunk(path, offset, limit: 500)
  ↓ チャンク返却
仮想スクロール更新
```

---

## 8. Rust Crate 選定

| 用途 | Crate | 選定理由 |
|------|-------|---------|
| CSV パース | `csv` | Rust 標準的。高速、ストリーミング対応 |
| エンコーディング検出 | `chardetng` | Firefox 由来。日本語エンコーディングに強い |
| エンコーディング変換 | `encoding_rs` | chardetng と連携。Shift_JIS/EUC-JP 対応 |
| PDF 読み取り | `pdf-extract` + `lopdf` | テキスト抽出 + 低レベル操作 |
| PDF レンダリング | PDF.js（フロント側） | WebView 内でネイティブレンダリング |
| Markdown パース | `pulldown-cmark` | GFM 対応。高速 |
| Excel 読み取り | `calamine` | xlsx/xls/ods 対応。読み取り専用で高速 |
| ファイル監視 | `notify` | クロスプラットフォーム対応 |
| シリアライズ | `serde` + `serde_json` | Tauri IPC の標準 |
| 日付パース | `chrono` | Excel 日付シリアル値の変換 |

---

## 9. 設定（Preferences）

アプリ設定は JSON ファイルとしてローカルに保存する。

```json
{
  "theme": "system",
  "fontSize": 14,
  "fontFamily": "SF Mono, Menlo, monospace",
  "csv": {
    "defaultDelimiter": ",",
    "showRowNumbers": true,
    "maxPreviewRows": 10000
  },
  "pdf": {
    "defaultView": "single",
    "defaultZoom": "fit-width"
  },
  "markdown": {
    "defaultView": "preview",
    "codeTheme": "github-dark"
  },
  "recentFiles": [],
  "windowState": {
    "width": 1200,
    "height": 800,
    "x": null,
    "y": null,
    "maximized": false
  }
}
```

---

## 10. 実装フェーズ

### Phase 1: 基盤構築（2 週間）

- [ ] Tauri 2 プロジェクトセットアップ
- [ ] React + Vite + Tailwind 設定
- [ ] タブ管理 UI（Zustand ストア）
- [ ] ファイルオープンダイアログ + ドラッグ＆ドロップ
- [ ] ファイル形式判定（Rust）
- [ ] テーマ切り替え（ダーク/ライト）
- [ ] キーボードショートカット基盤

### Phase 2: CSV/TSV ビューア（2 週間）

- [ ] CSV パーサー（Rust、csv crate）
- [ ] エンコーディング自動検出（chardetng）
- [ ] TanStack Virtual テーブル
- [ ] 列ソート・リサイズ
- [ ] 列フィルタ UI + Rust 側フィルタロジック
- [ ] ステータスバー（行数・選択統計）
- [ ] チャンク読み込み（大規模ファイル対応）
- [ ] フィルタ結果エクスポート

### Phase 3: PDF ビューア（2 週間）

- [ ] PDF.js 統合（WebView 内）
- [ ] ページナビゲーション + サムネイル
- [ ] ズーム制御
- [ ] テキスト選択・コピー
- [ ] アウトライン（目次）サイドバー
- [ ] ハイライト注釈
- [ ] メモ注釈
- [ ] 見開き表示モード

### Phase 4: Markdown ビューア（1.5 週間）

- [ ] pulldown-cmark でパース → HTML 変換
- [ ] プレビューレンダリング（rehype / remark 系）
- [ ] シンタックスハイライト（Shiki）
- [ ] 目次自動生成
- [ ] ソース/プレビュー切り替え + スプリットビュー
- [ ] KaTeX 数式レンダリング
- [ ] Mermaid ダイアグラム
- [ ] ソース編集 + 保存

### Phase 5: Excel ビューア（1.5 週間）

- [ ] calamine でブック読み込み
- [ ] シート切り替え UI
- [ ] TanStack Virtual テーブル（CSV ビューアのコンポーネント共有）
- [ ] セル書式反映（数値・日付フォーマット）
- [ ] 列ソート・フィルタ
- [ ] CSV エクスポート
- [ ] フリーズペイン対応

### Phase 6: 横断機能 + 仕上げ（1 週間）

- [ ] 全文検索（Cmd+F）
- [ ] ファイル監視（notify）
- [ ] 最近開いたファイル
- [ ] 設定画面 UI
- [ ] ウィンドウ状態保存・復元
- [ ] パフォーマンスチューニング
- [ ] エラーハンドリング統一
- [ ] macOS コード署名 + DMG ビルド

**合計見積もり: 約 10 週間（1 人開発）**

---

## 11. ディレクトリ構成（案）

```
quickview/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── csv.rs
│   │   │   ├── pdf.rs
│   │   │   ├── markdown.rs
│   │   │   └── xlsx.rs
│   │   ├── parsers/
│   │   │   ├── mod.rs
│   │   │   ├── csv_parser.rs
│   │   │   ├── pdf_parser.rs
│   │   │   ├── md_parser.rs
│   │   │   └── xlsx_parser.rs
│   │   ├── watcher.rs
│   │   ├── encoding.rs
│   │   └── config.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   │   ├── layout/
│   │   │   ├── TitleBar.tsx
│   │   │   ├── TabBar.tsx
│   │   │   ├── Tab.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Toolbar.tsx
│   │   │   └── SearchBar.tsx
│   │   ├── viewers/
│   │   │   ├── CsvViewer.tsx
│   │   │   ├── PdfViewer.tsx
│   │   │   ├── MarkdownViewer.tsx
│   │   │   └── XlsxViewer.tsx
│   │   ├── csv/
│   │   │   ├── VirtualTable.tsx
│   │   │   ├── FilterBar.tsx
│   │   │   ├── ColumnHeader.tsx
│   │   │   └── StatusBar.tsx
│   │   ├── pdf/
│   │   │   ├── PdfCanvas.tsx
│   │   │   ├── PageNavigator.tsx
│   │   │   ├── ThumbnailSidebar.tsx
│   │   │   └── AnnotationLayer.tsx
│   │   ├── markdown/
│   │   │   ├── RenderedView.tsx
│   │   │   ├── SourceEditor.tsx
│   │   │   └── SplitView.tsx
│   │   ├── xlsx/
│   │   │   ├── SheetTabs.tsx
│   │   │   └── CellFormatter.tsx
│   │   └── common/
│   │       ├── SettingsDialog.tsx
│   │       └── EmptyState.tsx
│   ├── stores/
│   │   ├── tabStore.ts
│   │   ├── settingsStore.ts
│   │   └── searchStore.ts
│   ├── hooks/
│   │   ├── useFileOpen.ts
│   │   ├── useShortcuts.ts
│   │   ├── useTheme.ts
│   │   └── useFileWatcher.ts
│   ├── lib/
│   │   ├── tauri-commands.ts
│   │   ├── file-types.ts
│   │   └── constants.ts
│   └── types/
│       ├── csv.ts
│       ├── pdf.ts
│       ├── markdown.ts
│       └── xlsx.ts
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.ts
```

---

## 12. 将来的な拡張候補（スコープ外）

以下は現バージョンのスコープ外だが、アーキテクチャ設計時に拡張性を考慮する。

- プラグインシステム（形式追加を外部モジュールで対応）
- ファイル比較（diff）ビュー
- クリップボードからの貼り付け表示
- コマンドパレット（Cmd+Shift+P）
- 印刷対応