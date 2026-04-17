import { create } from "zustand";

export interface SearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
}

export interface CellMatch {
  row: number;
  col: number;
}

interface SearchStore {
  isOpen: boolean;
  query: string;
  options: SearchOptions;
  matchCount: number;
  currentMatchIndex: number;
  cellMatches: CellMatch[];
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setOptions: (options: SearchOptions) => void;
  setMatchCount: (count: number) => void;
  setCellMatches: (matches: CellMatch[]) => void;
  nextMatch: () => void;
  prevMatch: () => void;
  close: () => void;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  isOpen: false,
  query: "",
  options: { useRegex: false, caseSensitive: false },
  matchCount: 0,
  currentMatchIndex: 0,
  cellMatches: [],

  setOpen: (open) => set({ isOpen: open }),
  setQuery: (query) => set({ query, currentMatchIndex: 0 }),
  setOptions: (options) => set({ options, currentMatchIndex: 0 }),
  setMatchCount: (matchCount) => set({ matchCount, currentMatchIndex: 0 }),
  setCellMatches: (cellMatches) =>
    set({ cellMatches, matchCount: cellMatches.length, currentMatchIndex: 0 }),
  nextMatch: () => {
    const { matchCount, currentMatchIndex } = get();
    if (matchCount === 0) return;
    set({ currentMatchIndex: (currentMatchIndex + 1) % matchCount });
  },
  prevMatch: () => {
    const { matchCount, currentMatchIndex } = get();
    if (matchCount === 0) return;
    set({ currentMatchIndex: (currentMatchIndex - 1 + matchCount) % matchCount });
  },
  close: () =>
    set({ isOpen: false, query: "", cellMatches: [], matchCount: 0, currentMatchIndex: 0 }),
}));
