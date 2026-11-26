import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ImageBatchItem, ImageBatchProgress } from "../../../types";

const FORMATS = [
  { id: "jpeg", label: "JPEG", extensions: ["jpg", "jpeg"], mime: "image/jpeg", lossy: true, alpha: false, keeps_metadata: true },
  { id: "webp", label: "WebP", extensions: ["webp"], mime: "image/webp", lossy: true, alpha: true, keeps_metadata: false },
];
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let finishBatch: (results: ImageBatchItem[]) => void = () => {};
let onProgress: ((event: { payload: ImageBatchProgress }) => void) | null = null;
const unlisten = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, handler: (event: { payload: ImageBatchProgress }) => void) => {
    onProgress = handler;
    return Promise.resolve(unlisten);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "list_image_formats") return Promise.resolve(FORMATS);
    if (cmd === "convert_images") return new Promise((resolve) => { finishBatch = resolve; });
    return Promise.resolve(undefined);
  }),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BatchConvertDialog } from "../BatchConvertDialog";
import { useImageStore } from "../../../stores/imageStore";
import { DEFAULT_IMAGE_OPTIONS } from "../../../lib/imageCommands";

const ok = (name: string, before: number, after: number): ImageBatchItem => ({
  source: `/pics/${name}.heic`, source_size: before, output_path: `/pics/${name}.webp`, size: after, error: null,
});

beforeEach(() => {
  calls.length = 0;
  onProgress = null;
  unlisten.mockClear();
  vi.mocked(open).mockReset();
  useImageStore.setState({
    optionsByTab: {},
    lastOptions: { ...DEFAULT_IMAGE_OPTIONS, format: "webp", quality: 60 },
    batchPaths: ["/pics/a.heic", "/pics/b.heic", "/pics/c.heic"],
  });
});

describe("BatchConvertDialog", () => {
  it("最後に使った設定と元のフォルダを初期値にして、全ファイルを変換する", async () => {
    render(<BatchConvertDialog />);
    expect(screen.getByText("3 個の画像")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("形式") as HTMLSelectElement).value).toBe("webp"));

    fireEvent.click(screen.getByText("変換を開始"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "convert_images")).toBe(true));
    expect(calls.find((c) => c.cmd === "convert_images")?.args).toEqual({
      paths: ["/pics/a.heic", "/pics/b.heic", "/pics/c.heic"],
      outputDir: "/pics",
      options: { ...DEFAULT_IMAGE_OPTIONS, format: "webp", quality: 60 },
    });
  });

  it("進み具合を表示し、終わったら件数・合計サイズ・失敗の理由を表示する", async () => {
    render(<BatchConvertDialog />);
    await waitFor(() => expect((screen.getByText("変換を開始") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("変換を開始"));
    await waitFor(() => expect(onProgress).not.toBeNull());

    act(() => onProgress?.({ payload: { done: 2, total: 3, item: ok("a", 1, 1) } }));
    expect(screen.getByText(/変換中\.\.\. 2 \/ 3/)).toBeTruthy();

    await act(async () => {
      finishBatch([
        ok("a", 2_000_000, 500_000),
        { source: "/pics/b.heic", source_size: 10, output_path: null, size: null, error: "画像として読み込めません" },
        ok("c", 2_000_000, 500_000),
      ]);
    });
    expect(screen.getByText(/2 件を変換しました（1 件は失敗）/)).toBeTruthy();
    expect(screen.getByText(/合計 3\.81 MB → 977 KB（-75%）/)).toBeTruthy();
    expect(screen.getByText(/b\.heic: 画像として読み込めません/)).toBeTruthy();
    expect(unlisten).toHaveBeenCalled();

    fireEvent.click(screen.getByText("保存先を Finder で表示"));
    expect(revealItemInDir).toHaveBeenCalledWith("/pics/a.webp");
  });

  it("保存先のフォルダを変更できる", async () => {
    vi.mocked(open).mockResolvedValue("/exports");
    render(<BatchConvertDialog />);
    fireEvent.click(screen.getByText("変更..."));
    expect(await screen.findByText("/exports")).toBeTruthy();
    expect(vi.mocked(open).mock.calls[0][0]).toMatchObject({ directory: true });

    await waitFor(() => expect((screen.getByText("変換を開始") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("変換を開始"));
    await waitFor(() => expect(calls.find((c) => c.cmd === "convert_images")?.args.outputDir).toBe("/exports"));
  });

  it("閉じるとストアの一括変換の対象が空になる", () => {
    render(<BatchConvertDialog />);
    fireEvent.click(screen.getByText("閉じる"));
    expect(useImageStore.getState().batchPaths).toBeNull();
  });
});
