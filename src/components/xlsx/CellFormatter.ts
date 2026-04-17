import type React from "react";
import type { XlsxCell } from "../../types";

export function getCellStyle(cell: XlsxCell): React.CSSProperties {
  if (cell.cell_type === "number" || cell.cell_type === "integer") {
    return { textAlign: "right" };
  }
  return {};
}

export function getCellStyleByType(
  cellType: XlsxCell["cell_type"]
): React.CSSProperties {
  if (cellType === "number" || cellType === "integer") {
    return { textAlign: "right" };
  }
  return {};
}
