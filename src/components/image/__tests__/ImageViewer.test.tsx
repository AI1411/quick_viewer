import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ImageConvertOptions, ImageEstimate } from "../../../types";

const FORMATS = [
  { id: "jpeg", label: "JPEG", extensions: ["jpg", "jpeg"], mime: "image/jpeg", lossy: true, alpha: false, keeps_metadata: true },
  { id: "webp", label: "WebP", extensions: ["webp"], mime: "image/webp", lossy: true, alpha: true, keeps_metadata: false },
];
const INFO = { width: 4032, height: 3024, format: "HEIC", frame_count: 1, has_alpha: false, has_gps: true, file_size: 2_000_000 };

type EstimateArgs = { path: string; options: ImageConvertOptions; withPreview: boolean };
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let estimate: (args: EstimateArgs) => Promise<ImageEstimate>;
let info: () => Promise<typeof INFO>;

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "list_image_formats") return Promise.resolve(FORMATS);
    if (cmd === "read_image_info") return info();
    if (cmd === "read_image_preview") return Promise.resolve("data:image/jpeg;base64,SOURCE");
    if (cmd === "estimate_image") return estimate(args as EstimateArgs);
    if (cmd === "convert_image") {
      return Promise.resolve({ output_path: args.outputPath, size: 540_000, width: 4032, height: 3024, quality: 80 });
    }
    return Promise.resolve(undefined);
  }),
}));

import { save } from "@tauri-apps/plugin-dialog";
import { ImageViewer } from "../ImageViewer";
import { useImageStore } from "../../../stores/imageStore";
import { useToastStore } from "../../../stores/toastStore";
import { DEFAULT_IMAGE_OPTIONS } from "../../../lib/imageCommands";

const result = (over: Partial<ImageEstimate> = {}): ImageEstimate => ({
  size: 540_000, width: 4032, height: 3024, quality: 80, preview: null, ...over,
});
const estimates = () => calls.filter((c) => c.cmd === "estimate_image").map((c) => c.args as EstimateArgs);
const settle = (ms = 450) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  calls.length = 0;
  estimate = () => Promise.resolve(result());
  info = () => Promise.resolve(INFO);
  useImageStore.setState({ optionsByTab: {}, lastOptions: DEFAULT_IMAGE_OPTIONS, batchPaths: null });
  useToastStore.setState({ toasts: [] });
  vi.mocked(save).mockReset();
});

describe("ImageViewer", () => {
  it("画像の情報と、今の設定で変換した場合のサイズを表示する", async () => {
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    expect(await screen.findByText(/HEIC · 4032×3024 · 1\.91 MB/)).toBeTruthy();
    await settle();

    expect(estimates()).toEqual([{ path: "/pics/IMG_1.HEIC", options: DEFAULT_IMAGE_OPTIONS, withPreview: false }]);
    expect(screen.getByRole("status").textContent).toContain("変換後: 527 KB（-73%）");
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe("data:image/jpeg;base64,SOURCE");
  });

  it("変換は同時に 1 件だけ走らせ、終わってから最新の設定で 1 回だけやり直す", async () => {
    const pending: Array<{ options: ImageConvertOptions; resolve: (r: ImageEstimate) => void }> = [];
    estimate = ({ options }) => new Promise((resolve) => { pending.push({ options, resolve }); });
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    await screen.findByLabelText("形式");
    await settle();

    // 最初の変換が終わらないうちに設定を 2 回変える
    fireEvent.change(screen.getByLabelText("形式"), { target: { value: "webp" } });
    await settle();
    fireEvent.change(screen.getByLabelText("品質"), { target: { value: "50" } });
    await settle();
    expect(pending.length).toBe(1);

    // 古い設定の結果は表示せず、最新の設定 (WebP・品質 50) で 1 回だけやり直す
    await act(async () => { pending[0].resolve(result({ size: 900_000 })); });
    expect(screen.getByRole("status").textContent).not.toContain("879 KB");
    expect(pending.length).toBe(2);
    expect(pending[1].options).toMatchObject({ format: "webp", quality: 50 });

    await act(async () => { pending[1].resolve(result({ size: 100_000, quality: 50 })); });
    expect(screen.getByRole("status").textContent).toContain("変換後: 98 KB");
    expect(useImageStore.getState().optionsByTab.t1).toMatchObject({ format: "webp", quality: 50 });
  });

  it("「変換後」に切り替えると変換結果そのものを表示する", async () => {
    estimate = ({ withPreview }) =>
      Promise.resolve(result({ preview: withPreview ? "data:image/jpeg;base64,CONVERTED" : null }));
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    fireEvent.click(await screen.findByText("変換後"));
    await settle();

    expect(estimates().some((e) => e.withPreview)).toBe(true);
    await waitFor(() =>
      expect((screen.getByRole("img") as HTMLImageElement).src).toBe("data:image/jpeg;base64,CONVERTED")
    );
  });

  it("保存先は元と同じ場所・拡張子違いを初期値にし、選んだパスへ今の設定で保存する", async () => {
    vi.mocked(save).mockResolvedValue("/out/photo.jpg");
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    fireEvent.click(await screen.findByText("保存..."));

    await waitFor(() => expect(calls.some((c) => c.cmd === "convert_image")).toBe(true));
    expect(vi.mocked(save).mock.calls[0][0]).toMatchObject({
      defaultPath: "/pics/IMG_1.jpg",
      filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }],
    });
    expect(calls.find((c) => c.cmd === "convert_image")?.args).toEqual({
      path: "/pics/IMG_1.HEIC",
      outputPath: "/out/photo.jpg",
      options: DEFAULT_IMAGE_OPTIONS,
    });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message).join()).toContain("保存しました: photo.jpg")
    );
  });

  it("保存ダイアログをキャンセルしたら何も書き出さない", async () => {
    vi.mocked(save).mockResolvedValue(null);
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    fireEvent.click(await screen.findByText("保存..."));
    await settle(50);
    expect(calls.some((c) => c.cmd === "convert_image")).toBe(false);
  });

  it("目標サイズに収まらなかったときは知らせる", async () => {
    useImageStore.setState({ lastOptions: { ...DEFAULT_IMAGE_OPTIONS, target_bytes: 100_000 } });
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    await screen.findByLabelText("形式");
    await settle();
    expect(screen.getByText(/目標サイズには収まりませんでした/)).toBeTruthy();
  });

  it("設定を変えて計算し直している間は、前の結果をもとにした警告を出さない", async () => {
    useImageStore.setState({ lastOptions: { ...DEFAULT_IMAGE_OPTIONS, target_bytes: 100_000 } });
    let n = 0;
    estimate = () => (n++ === 0 ? Promise.resolve(result()) : new Promise(() => {}));
    render(<ImageViewer tabId="t1" filePath="/pics/IMG_1.HEIC" />);
    await screen.findByLabelText("形式");
    await settle();
    expect(screen.getByText(/目標サイズには収まりませんでした/)).toBeTruthy();

    // 目標を変えた。前の結果 (527KB) は古い目標で出したものなので、新しい結果が出るまで判定しない
    fireEvent.change(screen.getByLabelText("目標サイズ (KB)"), { target: { value: "200" } });
    expect(screen.queryByText(/目標サイズには収まりませんでした/)).toBeNull();
  });

  it("読み込めない画像はエラーを表示する", async () => {
    info = () => Promise.reject("画像として読み込めません: /pics/broken.jpg");
    render(<ImageViewer tabId="t1" filePath="/pics/broken.jpg" />);
    expect(await screen.findByText(/画像として読み込めません/)).toBeTruthy();
  });
});
