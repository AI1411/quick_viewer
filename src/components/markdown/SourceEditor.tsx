import React from "react";

interface SourceEditorProps {
  content: string;
  onChange: (content: string) => void;
  containerRef?: React.RefObject<HTMLTextAreaElement | null>;
  onScroll?: (e: React.UIEvent<HTMLTextAreaElement>) => void;
}

export function SourceEditor({
  content,
  onChange,
  containerRef,
  onScroll,
}: SourceEditorProps) {
  return (
    <textarea
      ref={containerRef}
      value={content}
      onChange={(e) => onChange(e.target.value)}
      onScroll={onScroll}
      spellCheck={false}
      className="w-full h-full p-4 font-mono text-sm resize-none outline-none"
      style={{
        backgroundColor: "var(--viewer-bg)",
        color: "var(--text-primary)",
      }}
    />
  );
}
