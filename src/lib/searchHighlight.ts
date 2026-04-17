import type { SearchOptions } from "../stores/searchStore";

export function buildRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  try {
    const flags = options.caseSensitive ? "g" : "gi";
    const pattern = options.useRegex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function highlightTextNodes(
  root: HTMLElement,
  query: string,
  options: SearchOptions
): HTMLElement[] {
  const regex = buildRegex(query, options);
  if (!regex) return [];

  const marks: HTMLElement[] = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const tag = (node.parentElement?.tagName ?? "").toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex)
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));

      const mark = document.createElement("mark");
      mark.setAttribute("data-search-match", "true");
      mark.textContent = match[0];
      fragment.appendChild(mark);
      marks.push(mark);

      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) regex.lastIndex++;
    }

    if (lastIndex < text.length)
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));

    parent.replaceChild(fragment, textNode);
  }

  return marks;
}

export function clearSearchMarks(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll("mark[data-search-match]"));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  root.normalize();
}

export function applyMarkStyles(marks: HTMLElement[], currentIndex: number): void {
  marks.forEach((m, i) => {
    m.style.backgroundColor = i === currentIndex ? "#f59e0b" : "#fef08a";
    m.style.color = "#000000";
    m.style.borderRadius = "2px";
  });
}
