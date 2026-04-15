import { useState, useRef } from "react";
import type {
  Annotation,
  HighlightAnnotation,
  NoteAnnotation,
  AnnotationColor,
} from "../../types";

const HIGHLIGHT_COLORS_CSS: Record<AnnotationColor, string> = {
  yellow: "rgba(255, 235, 59, 0.45)",
  green: "rgba(76, 175, 80, 0.4)",
  blue: "rgba(33, 150, 243, 0.4)",
  pink: "rgba(233, 30, 99, 0.35)",
};

interface NoteEditorState {
  screenX: number;
  screenY: number;
  normalX: number;
  normalY: number;
}

interface AnnotationLayerProps {
  pageIndex: number;
  scale: number;
  annotations: Annotation[];
  annotationMode: "none" | "highlight" | "note";
  selectedAnnotationId: string | null;
  onAnnotationDelete: (pageIndex: number, id: string) => void;
  onNoteCreate: (annotation: NoteAnnotation) => void;
  onAnnotationSelect: (id: string | null) => void;
}

export function AnnotationLayer({
  pageIndex,
  scale,
  annotations,
  annotationMode,
  selectedAnnotationId,
  onAnnotationDelete,
  onNoteCreate,
  onAnnotationSelect,
}: AnnotationLayerProps) {
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [noteContent, setNoteContent] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  function handleLayerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (annotationMode !== "note") return;
    if ((e.target as HTMLElement).closest(".annotation-item")) return;

    const rect = layerRef.current!.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    setNoteEditor({
      screenX,
      screenY,
      normalX: screenX / scale,
      normalY: screenY / scale,
    });
    setNoteContent("");
  }

  function handleNoteConfirm() {
    if (!noteEditor || !noteContent.trim()) {
      setNoteEditor(null);
      return;
    }
    const ann: NoteAnnotation = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "note",
      pageIndex,
      x: noteEditor.normalX,
      y: noteEditor.normalY,
      content: noteContent.trim(),
      createdAt: new Date().toISOString(),
    };
    onNoteCreate(ann);
    setNoteEditor(null);
    setNoteContent("");
  }

  function handleNoteCancel() {
    setNoteEditor(null);
    setNoteContent("");
  }

  const highlights = annotations.filter(
    (a): a is HighlightAnnotation => a.type === "highlight"
  );
  const notes = annotations.filter(
    (a): a is NoteAnnotation => a.type === "note"
  );

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ pointerEvents: annotationMode === "note" ? "auto" : "none" }}
      onClick={handleLayerClick}
    >
      {/* ハイライト */}
      {highlights.map((ann) => (
        <div key={ann.id} className="annotation-item absolute inset-0">
          {ann.rects.map((rect, i) => (
            <div
              key={i}
              className="absolute"
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
                backgroundColor: HIGHLIGHT_COLORS_CSS[ann.color],
                outline:
                  selectedAnnotationId === ann.id
                    ? "2px solid rgba(59, 130, 246, 0.8)"
                    : "none",
                cursor: "pointer",
                pointerEvents: "auto",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onAnnotationSelect(
                  selectedAnnotationId === ann.id ? null : ann.id
                );
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAnnotationDelete(pageIndex, ann.id);
              }}
              title={`"${ann.selectedText}" — 右クリックで削除`}
            />
          ))}
        </div>
      ))}

      {/* メモ注釈 */}
      {notes.map((ann) => (
        <div
          key={ann.id}
          className="annotation-item absolute"
          style={{
            left: ann.x * scale - 12,
            top: ann.y * scale - 12,
            pointerEvents: "auto",
          }}
        >
          <button
            className="w-6 h-6 rounded-full flex items-center justify-center text-xs shadow-md"
            style={{
              backgroundColor:
                selectedAnnotationId === ann.id ? "#2563eb" : "#f59e0b",
              color: "white",
              border:
                selectedAnnotationId === ann.id
                  ? "2px solid #1d4ed8"
                  : "2px solid #d97706",
              cursor: "pointer",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setActiveNoteId(activeNoteId === ann.id ? null : ann.id);
              onAnnotationSelect(ann.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onAnnotationDelete(pageIndex, ann.id);
            }}
            title="メモ — 右クリックで削除"
          >
            📌
          </button>

          {activeNoteId === ann.id && (
            <div
              className="absolute z-50 p-2 rounded shadow-lg text-xs"
              style={{
                top: 28,
                left: 0,
                minWidth: 160,
                maxWidth: 240,
                backgroundColor: "#fffde7",
                border: "1px solid #f59e0b",
                color: "#333",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                pointerEvents: "auto",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {ann.content}
            </div>
          )}
        </div>
      ))}

      {/* メモ作成エディタ */}
      {noteEditor && (
        <div
          className="absolute z-50 shadow-xl rounded p-2 flex flex-col gap-1"
          style={{
            left: Math.min(
              noteEditor.screenX,
              (layerRef.current?.clientWidth ?? 400) - 210
            ),
            top: noteEditor.screenY + 8,
            width: 200,
            backgroundColor: "#fffde7",
            border: "1px solid #f59e0b",
            pointerEvents: "auto",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <textarea
            autoFocus
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            placeholder="メモを入力... (Cmd+Enter で追加)"
            rows={3}
            className="w-full text-xs p-1 rounded resize-none"
            style={{
              border: "1px solid #e5e7eb",
              backgroundColor: "#fff",
              color: "#333",
              outline: "none",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) handleNoteConfirm();
              if (e.key === "Escape") handleNoteCancel();
            }}
          />
          <div className="flex gap-1 justify-end">
            <button
              className="text-xs px-2 py-0.5 rounded"
              style={{ backgroundColor: "#e5e7eb", color: "#374151" }}
              onClick={handleNoteCancel}
            >
              キャンセル
            </button>
            <button
              className="text-xs px-2 py-0.5 rounded"
              style={{ backgroundColor: "#f59e0b", color: "#fff" }}
              onClick={handleNoteConfirm}
            >
              追加
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
