import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConvertOptionsForm } from "../ConvertOptionsForm";
import { DEFAULT_IMAGE_OPTIONS } from "../../../lib/imageCommands";
import type { ImageConvertOptions, ImageFormatSpec } from "../../../types";

const spec = (id: ImageFormatSpec["id"], over: Partial<ImageFormatSpec> = {}): ImageFormatSpec => ({
  id,
  label: id.toUpperCase(),
  extensions: [id],
  mime: `image/${id}`,
  lossy: true,
  alpha: true,
  keeps_metadata: true,
  ...over,
});

const FORMATS = [
  spec("jpeg", { alpha: false }),
  spec("png", { lossy: false }),
  spec("webp", { keeps_metadata: false }),
];

function setup(value: Partial<ImageConvertOptions> = {}, props: { gps?: boolean; alpha?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <ConvertOptionsForm
      formats={FORMATS}
      value={{ ...DEFAULT_IMAGE_OPTIONS, ...value }}
      onChange={onChange}
      sourceHasGps={props.gps}
      sourceHasAlpha={props.alpha}
    />
  );
  return onChange;
}

describe("ConvertOptionsForm", () => {
  it("非可逆形式では品質を変えられる", () => {
    const onChange = setup({ format: "jpeg", quality: 80 });
    fireEvent.change(screen.getByLabelText("品質"), { target: { value: "55" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ quality: 55 }));
  });

  it("可逆形式では品質の指定を出さない", () => {
    setup({ format: "png" });
    expect(screen.queryByLabelText("品質")).toBeNull();
    expect(screen.getByText(/画質を落とさずに保存/)).toBeTruthy();
  });

  it("目標サイズに切り替えると 500 KB が初期値になり、KB で編集できる", () => {
    const onChange = setup();
    fireEvent.click(screen.getByLabelText("目標サイズで指定"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target_bytes: 500 * 1024 }));
  });

  it("目標サイズの入力はバイトに直して渡す", () => {
    const onChange = setup({ target_bytes: 500 * 1024 });
    fireEvent.change(screen.getByLabelText("目標サイズ (KB)"), { target: { value: "200" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target_bytes: 200 * 1024 }));
    fireEvent.click(screen.getByLabelText("品質で指定"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ target_bytes: null }));
  });

  it("リサイズの種類を選ぶと既定値が入り、数値を変えられる", () => {
    const onChange = setup();
    fireEvent.change(screen.getByLabelText("リサイズ"), { target: { value: "long_edge" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ resize: { kind: "long_edge", pixels: 1920 } })
    );
  });

  it("割合は 1〜100 に収める", () => {
    const onChange = setup({ resize: { kind: "percent", percent: 50 } });
    fireEvent.change(screen.getByLabelText("割合 (%)"), { target: { value: "250" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ resize: { kind: "percent", percent: 100 } })
    );
  });

  it("メタデータを保存できない形式では選択肢の代わりに説明を出す", () => {
    setup({ format: "webp" });
    expect(screen.queryByLabelText("メタデータ")).toBeNull();
    expect(screen.getByText(/WEBP ではメタデータは保存されません/)).toBeTruthy();
  });

  it("位置情報のある画像でメタデータを保持する設定のときだけ注意を出す", () => {
    setup({ format: "jpeg", metadata: "keep" }, { gps: true });
    expect(screen.getByText(/位置情報が含まれています/)).toBeTruthy();
  });

  it("位置情報を削除する設定なら注意は出さない", () => {
    setup({ format: "jpeg", metadata: "strip_location" }, { gps: true });
    expect(screen.queryByText(/位置情報が含まれています/)).toBeNull();
  });

  it("透過のある画像を透過を持てない形式にするときは白背景になると知らせる", () => {
    setup({ format: "jpeg" }, { alpha: true });
    expect(screen.getByText(/白背景になります/)).toBeTruthy();
  });
});

describe("ConvertOptionsForm を同じ画面に 2 つ出したとき", () => {
  it("片方の圧縮方法を切り替えても、もう片方の選択表示は変わらない", () => {
    // ビューアのパネルを開いたまま一括変換ダイアログを開くと 2 つ並ぶ
    render(
      <>
        <div data-testid="viewer">
          <ConvertOptionsForm formats={FORMATS} value={DEFAULT_IMAGE_OPTIONS} onChange={() => {}} />
        </div>
        <div data-testid="dialog">
          <ConvertOptionsForm formats={FORMATS} value={DEFAULT_IMAGE_OPTIONS} onChange={() => {}} />
        </div>
      </>
    );
    const radio = (testId: string, label: string) =>
      Array.from(screen.getByTestId(testId).querySelectorAll("label"))
        .find((l) => l.textContent === label)!
        .querySelector("input") as HTMLInputElement;

    fireEvent.click(radio("dialog", "目標サイズで指定"));
    expect(radio("viewer", "品質で指定").checked).toBe(true);
  });
});
