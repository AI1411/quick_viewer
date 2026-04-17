import React, { useRef } from "react";
import { SourceEditor } from "./SourceEditor";
import { RenderedView } from "./RenderedView";

interface SplitViewProps {
  content: string;
  html: string;
  filePath: string;
  onChange: (content: string) => void;
}

export function SplitView({ content, html, filePath, onChange }: SplitViewProps) {
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  const handleSourceScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const el = e.currentTarget;
    const ratio = el.scrollTop / (el.scrollHeight - el.clientHeight) || 0;
    if (previewRef.current) {
      const preview = previewRef.current;
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
    }
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  const handlePreviewScroll = () => {
    if (syncingRef.current || !previewRef.current) return;
    syncingRef.current = true;
    const preview = previewRef.current;
    const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight) || 0;
    if (sourceRef.current) {
      const source = sourceRef.current;
      source.scrollTop = ratio * (source.scrollHeight - source.clientHeight);
    }
    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <div
        className="w-1/2 h-full overflow-hidden border-r"
        style={{ borderColor: "var(--border-color)" }}
      >
        <SourceEditor
          content={content}
          onChange={onChange}
          containerRef={sourceRef}
          onScroll={handleSourceScroll}
        />
      </div>
      <div className="w-1/2 h-full overflow-hidden">
        <RenderedView
          html={html}
          filePath={filePath}
          containerRef={previewRef}
          onScroll={handlePreviewScroll}
        />
      </div>
    </div>
  );
}
