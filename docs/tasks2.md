# quick_viewer 洗練化タスク（Codex レビュー結果）

Codex による通常レビュー + 攻撃者視点レビュー（セッション `019d9f4b-9f4b-7c60-8d3f-5d84093d428e`）で検出された全指摘を、優先度順にまとめたもの。

- **P0**: セキュリティ / データ破壊。配布前に必ず修正。
- **P1**: コア機能の完成度・性能・ユーザー保護。Must。
- **P2**: UX / 品質 / DX。Should。
- **P3**: ブランディング・運用改善。Nice-to-have。

---

## P0 — セキュリティ・データ破壊（必須）

### セキュリティ

- [x] **PDF sidecar の symlink 攻撃で任意ファイル上書き**
  - `src-tauri/src/pdf_commands.rs:303`, `src/components/pdf/PdfViewer.tsx:107`
  - 攻撃者が `victim.pdf.annotations.json -> ~/Documents/notes.md` の symlink を仕込んだPDFを配布 → ユーザーが注釈を追加するとリンク先が上書きされる（ユーザー権限内の任意ファイル clobber）。
  - 修正: sidecar を元ファイル横に置く設計をやめ、app data 配下へハッシュキーで保存。`O_NOFOLLOW` + temp file → `fsync` → `rename` のアトミック書込。

- [x] **Markdown 未サニタイズ HTML + Rust 任意パス読込の複合 XSS**
  - `src-tauri/src/markdown_commands.rs:129`, `src/components/markdown/RenderedView.tsx:192`, `:30`, `src-tauri/src/lib.rs:128`, `src-tauri/src/pdf_commands.rs:294`
  - Rust が HTML を無加工で生成 → React が `dangerouslySetInnerHTML` で注入。Mermaid は `securityLevel: "loose"`。IPC はパス許可リストなし。XSS 入ると即ローカルファイル読取り。
  - 修正: HTML サニタイズ（ammonia / sanitize-html）、Mermaid `strict`、IPC 引数のパス許可リスト化。

- [x] **`save_app_data` / `load_app_data` のパストラバーサル**
  - `src-tauri/src/persistence_commands.rs:4`
  - `key` を無検証で `dir.join(format!("{key}.json"))` に渡す。`../` で app data 外へ抜けられる。
  - 修正: `key` を enum 化、または `^[a-zA-Z0-9_]+$` の正規表現制限。

- [x] **特殊ファイル（FIFO / symlink / `/dev/zero`）で OOM・UI フリーズ**
  - `src-tauri/src/lib.rs:49`, `src-tauri/src/csv_commands.rs:178`, `src-tauri/src/pdf_commands.rs:294`, `src/App.tsx:231`
  - `mkfifo /tmp/hang.csv` や `ln -s /dev/zero /tmp/oom.pdf` をドロップ → `fs::read()` / `read_to_string()` がブロックか OOM でプロセス落ち。
  - 修正: `symlink_metadata()` で通常ファイル以外を拒否、symlink 解決後の種別チェック、サイズ上限、タイムアウト付きストリーム読込。

- [x] **PDF 目次の循環参照で無限ループ / スタック枯渇**
  - `src-tauri/src/pdf_commands.rs:58`
  - ブックマーク辞書の `First` / `Next` が自己参照する PDF で `collect_outline_items()` が無限再帰。
  - 修正: object id の visited set、最大深度制限。

- [x] **XLSX zip bomb / `row - 1` underflow / セル参照未検証**
  - `src-tauri/src/xlsx_commands.rs:216`, `:316`, `:505`
  - `xl/styles.xml` を極小圧縮 → 展開時メモリ爆発。`A0` 参照で `row_str.parse::<u32>()? - 1` が underflow。
  - 修正: zip entry 展開後サイズ制限、XML ストリーミング、`row >= 1` バリデーション。

### データ破壊・損失

- [x] **保存系が全て非原子的 `fs::write()` 一発**
  - `src-tauri/src/markdown_commands.rs:143`, `src-tauri/src/persistence_commands.rs:4`, `src-tauri/src/pdf_commands.rs:303`
  - ディスクフル / 強制終了でゼロバイト化・部分 JSON 発生。Markdown 本文・設定・recent files・annotation が破損。
  - 修正: temp file → `fsync` → `rename`。必要ならバックアップ世代を保持。

- [x] **保存失敗が silent fail、「保存したつもり」状態**
  - `src/stores/settingsStore.ts:116`, `src/stores/recentFilesStore.ts:57`, `src/components/csv/ActiveFiltersBar.tsx:34`, `src/components/xlsx/XlsxViewer.tsx:257`
  - read-only ディレクトリ / 満杯ディスク / 権限エラーで UI は成功表示、実は未保存。
  - 修正: 保存 API を `Result` で最後まで伝播、成功トースト前に `stat` / 再読込で検証。

---

## P1 — コア機能・性能・ユーザー保護（Must）

### Markdown

- [ ] **分割表示のリアルタイムプレビューが機能していない**
  - `src/components/markdown/MarkdownViewer.tsx:68`, `:180`, `src/components/markdown/RenderedView.tsx:192`
  - 編集中は `editContent` を更新するだけで、プレビューは保存済み `tab.data.html` を見続ける。
  - 修正: `editContent` をソースにデバウンス付き再レンダリング、ToC も同時更新。

- [ ] **未保存 Markdown を閉じても確認ダイアログなしで破棄**
  - `src/components/markdown/MarkdownViewer.tsx:72`, `src/App.tsx:171`, `src/components/Tab.tsx:97`, `src/stores/tabStore.ts:32`
  - 未保存フラグは立てているが close は `removeTab()` 直行。
  - 修正: 確認ダイアログ、ドラフト退避、`beforeunload` 相当の保護。

### PDF

- [ ] **continuous モードが「Lazy」と称して全ページ即描画**
  - `src/components/pdf/PdfViewer.tsx:20`, `:517`
  - `LazyPdfCanvas` は常に `PdfCanvas` を描く。1000ページで CPU/メモリ即死。
  - 修正: `IntersectionObserver` で本当に遅延描画、一定距離外はアンマウント、bitmap cache、同時レンダ数制限。

- [ ] **1000 ページ級 PDF でサムネイル高速スクロール発火**
  - `src/lib/pdfLib.ts:14`, `src/components/pdf/ThumbnailSidebar.tsx:35`
  - 本文を `read_pdf_bytes → base64 → atob → Uint8Array` で丸ごと複製。サムネは可視化ごとに新規実行。
  - 修正: asset/stream 読込、page bitmap cache、throttle/cancel、同時レンダ数制限。

- [ ] **特定 PDF を「二度と開けないファイル」にできる（巨大 sidecar）**
  - `src/components/pdf/PdfViewer.tsx:80`, `src-tauri/src/pdf_commands.rs:309`
  - 対象 PDF の隣に巨大 `.annotations.json` を置くと open のたびに `Promise.all()` で読みに行き恒久的に重い。共有フォルダの PDF が実質ブリック。
  - 修正: sidecar を app data 隔離、破損/巨大 sidecar を無視して削除提案。

### XLSX

- [ ] **「大規模シート対応」と謳うが全セルを Rust で丸読込・フロントで全走査**
  - `src-tauri/src/xlsx_commands.rs:572`, `src/components/xlsx/XlsxViewer.tsx:93`
  - 100 万行 / 100MB 級で OOM・長時間フリーズ確定。
  - 修正: sheet metadata / viewport chunk 分離、CSV と同じサーバー側ソート/フィルタ、行列両方の遅延ロード。

### CSV

- [ ] **1GB CSV がフィルタ/エクスポートのたびに全読込・全件再パース**
  - `src-tauri/src/csv_commands.rs:173`, `:272`, `:328`, `src/components/csv/CsvViewer.tsx:129`
  - `read_csv` / `filter_csv` / `export_csv` が毎回 `fs::read()` から起動。メモリ二重三重消費。
  - 修正: ストリーミング、インデックス、サーバー側 chunk filter。

- [ ] **CSV の BOM と区切り推定が壊れる**
  - `src-tauri/src/csv_commands.rs:43`, `:52`, `:189`
  - `\xEF\xBB\xBFname` が見えないヘッダになる。quoted comma を無視した sniffing で `;` 区切り誤判定。
  - 修正: BOM 除去、RFC 4180 準拠の delimiter sniffing、encoding/delimiter を手動指定できる UI。

### ファイル監視・並行性

- [ ] **自分の保存を自分で「外部変更」として検知して再読込ダイアログ暴発**
  - `src-tauri/src/file_watcher_commands.rs:21`, `src-tauri/src/markdown_commands.rs:143`, `src/App.tsx:65`
  - `Cmd+S` 連打で発火。ユーザーが自分の保存と外部変更を区別不能、誤って stale に戻す。
  - 修正: self-write suppression、mtime/generation token 比較、保存直後 watcher 無視。

- [ ] **タブ close 中の遅延レスポンスでゾンビ state 復活**
  - `src/components/pdf/PdfViewer.tsx:74`, `src/components/xlsx/XlsxViewer.tsx:58`, `src/components/csv/CsvViewer.tsx:30`
  - 重いファイルを開いてすぐ `Cmd+W` → `setPdfInfo()` / `setSheetData()` / `setData()` がアンマウント後に走る。
  - 修正: `AbortController` / cancelled flag で late response 破棄。

### 設定・起動

- [ ] **`window_state.json` 未検証で「起動してるのに見えない」状態を作れる**
  - `src/App.tsx:84`
  - `x=-30000, y=-30000, width=1, height=1` を仕込めばウィンドウが画面外。ユーザーから見ると起動不能。
  - 修正: ディスプレイ境界に clamp、`Shift` 起動などのセーフモードで state 無視。

### リリース

- [ ] **コード署名 / 公証が未設定、`xattr -cr` 回避策前提の配布**
  - `src-tauri/tauri.conf.json:33`, `README.md:20`, `docs/tasks.md:216`
  - `signingIdentity` が `null` のまま。タスク表には「コード署名設定済み」と虚偽記載あり。
  - 修正: Developer ID 署名と notarization を CI に組み込み、未署名回避策の案内を削除。

---

## P2 — UX / 品質 / DX（Should）

### UX / アクセシビリティ

- [x] **`Cmd+Tab` タブ切替は macOS で OS に奪われる**
  - `README.md:65`, `docs/requirements.md:222`, `src/App.tsx:175`, `src/hooks/useShortcuts.ts:50`
  - 修正: `Ctrl+Tab` / `Cmd+Option+Arrow` に変更、ドキュメント文言も合わせる。

- [x] **モーダル / メニューが `role="dialog"` / `aria-modal` / フォーカストラップなし**
  - `src/components/SettingsDialog.tsx:68`, `src/components/FileChangedDialog.tsx:10`, `src/components/ContextMenu.tsx:17`
  - 要求書の「全操作をキーボードで完結」(`docs/requirements.md:208`) 未達。
  - 修正: `react-aria` 導入、または自前でフォーカス初期化・Tab 循環・Esc・矢印移動を実装。

- [x] **フォント設定が UI にあるのに実際の描画に反映されない（死んだ設定）**
  - `src/components/SettingsDialog.tsx:134`, `src/stores/settingsStore.ts:84`, `src/App.tsx:151`
  - 修正: `document.documentElement.style.fontFamily` か CSS 変数へ反映、Markdown/表/エディタ全てで効くように。

- [x] **PDF「見開き 2 ページ」設定が UI にあるのに未実装**
  - `src/components/SettingsDialog.tsx:173`, `src/stores/settingsStore.ts:13`, `src/types/index.ts:81`, `src/components/pdf/PdfViewer.tsx:401`
  - 表示モード型が `single | continuous` の 2 択のみ。
  - 修正: 設定を削除するか、2-up レイアウトを実装する。

### 競合 / 並行性

- [x] **同ファイルを複数タブで開くと最初の 1 タブしか監視通知を受けない**
  - `src/hooks/useFileWatcher.ts:41`
  - `find()` で先頭タブだけに reload を送る → stale タブが最新を上書きで消失。
  - 修正: `filePath -> Set<tabId>` で全タブ通知。

- [x] **XLSX シート高速切替で非同期レスポンス順序逆転（Sheet3 表示中に中身 Sheet2）**
  - `src/components/xlsx/XlsxViewer.tsx:75`
  - `read_xlsx_sheet()` に request id なし。
  - 修正: tab 毎の request sequence、古い応答は破棄。

### 外部変更 / リロード

- [x] **Markdown だけ外部変更のリロードが壊れている**
  - `src/components/ViewerArea.tsx:22`, `src/App.tsx:273`, `src/components/markdown/MarkdownViewer.tsx:25`
  - `reloadCount` で再マウントしても既存データを見て早期 return。
  - 修正: `reloadCount` を依存に含める、またはストアを明示クリア。

### エラーハンドリング

- [x] **PDF 注釈保存失敗が `console.error` で握りつぶされる**
  - `src-tauri/src/pdf_commands.rs:303`, `src/components/pdf/PdfViewer.tsx:107`
  - 読取専用ディレクトリ上の PDF では「保存できたように見えて消える」。
  - 修正: app data 配下へ保存先を移動、失敗時はトースト表示。

- [x] **CSV フィルタ失敗 / CSV・XLSX エクスポート失敗が無表示 or `console.error` のみ**
  - `src/components/csv/CsvViewer.tsx:127`, `src/components/csv/ActiveFiltersBar.tsx:44`, `src/components/xlsx/XlsxViewer.tsx:257`
  - 修正: `showError()` に統一、リトライ可否を含むエラー UX を揃える。

### メモリ / リソース

- [x] **タブを閉じても CSV/XLSX の重いストア状態が残る**
  - `src/App.tsx:173`, `src/components/TabBar.tsx:88`, `src/stores/csvStore.ts:179`, `src/stores/xlsxStore.ts:139`
  - `tabStore.removeTab()` しか呼ばない。未使用の各ストア `removeTab()` が残存。
  - 修正: ビューアンマウント時に必ず後始末。

- [x] **巨大 JSON を `JSON.parse()` 直打ち（300MB で OOM）**
  - `src/components/pdf/PdfViewer.tsx:83`, `src/stores/recentFilesStore.ts:45`, `src/stores/settingsStore.ts:104`
  - 修正: ファイルサイズ上限、schema validation、streaming parser。

- [x] **Mermaid / Shiki / KaTeX の CPU 爆弾でメインスレッド固まる**
  - `src/components/markdown/RenderedView.tsx:55`
  - 500 個の Mermaid ブロック、数十 MB の code fence、数万個の `$...$` で発火。
  - 修正: ブロック数・文字数の上限を設定（MERMAID_MAX_BLOCKS=20, CODE_MAX_CHARS=500k, MATH_MAX_CHARS=200k）。

- [x] **`recent_files.json` / `settings.json` が妥当 JSON なら中身を無検証で飲む**
  - `src/stores/recentFilesStore.ts:45`, `src/stores/settingsStore.ts:104`
  - 100 万件 recent files で起動後メモリ爆発。
  - 修正: schema 検証、件数・文字列長・数値範囲に hard cap。

### リリース / CI

- [x] **リリース自動化が危険（lint/test なしで bump/push）**
  - `Taskfile.yml:39`, `scripts/bump-version.mjs:42`
  - changelog 確認のあと即 bump/commit/tag。ワークツリーの汚れ確認もない。
  - 修正: `git diff --quiet`, `npm run lint`, `npm run test -- --run`, `cargo test`, `npm run tauri build` を通してから tag。

- [x] **CI 向け実行単位が不足、テストが smoke のみ**
  - `package.json:6`, `src/components/pdf/__tests__/PdfViewer.test.tsx:19`
  - `typecheck` / `test:run` / `ci` スクリプトなし。PdfViewer テストは loading/error しか見ていない。
  - 修正: 上記スクリプト追加、Markdown ライブプレビュー / 未保存クローズ / 外部変更リロード / IPC バリデーションの回帰テスト追加。

- [ ] **自動更新が未実装（updater plugin / 設定なし）**
  - `package.json:17`, `src-tauri/Cargo.toml:20`, `src-tauri/tauri.conf.json:1`
  - 修正: Tauri updater 導入、署名済み feed 配布。最低でも「新バージョンあり」通知。

---

## P3 — ブランディング・運用（Nice-to-have）

- [ ] **ブランディング / 配布メタデータがテンプレートのまま**
  - `index.html:5` (`vite.svg`, `Tauri + React + Typescript`)
  - `package.json:2` (`tauri-app`)
  - `src-tauri/Cargo.toml:2` (`A Tauri App`)
  - `README.md:18` (release URL が `yourname`)
  - 修正: アプリ名・アイコン・説明・URL を quick_viewer 固有に差し替え。

---

## 備考

- Codex レビューセッション: `019d9f4b-9f4b-7c60-8d3f-5d84093d428e`
- `/codex` で会話継続可能（PoC 再現手順の詳細化など）
- 数値は `tokens used: 1,928,150`（2 ラウンド合計）
- `.github/` は今回のレビュー対象外。CI ワークフロー本体の健全性は別途確認が必要。
