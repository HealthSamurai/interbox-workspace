export function segments(msg: string): string[] {
  return msg.split("\r").filter((s) => s.length > 0);
}
function fieldIndex(segId: string, n: number): number {
  return segId === "MSH" ? n - 1 : n;
}
export function getField(msg: string, segId: string, n: number): string {
  const seg = segments(msg).find((s) => s.startsWith(segId + "|"));
  if (!seg) return "";
  return seg.split("|")[fieldIndex(segId, n)] ?? "";
}
export function setField(msg: string, segId: string, n: number, value: string): string {
  return segments(msg)
    .map((seg) => {
      if (!seg.startsWith(segId + "|")) return seg;
      const parts = seg.split("|");
      const i = fieldIndex(segId, n);
      while (parts.length <= i) parts.push("");
      parts[i] = value;
      return parts.join("|");
    })
    .join("\r");
}
export function getComponent(field: string, c: number): string {
  return field.split("^")[c - 1] ?? "";
}
