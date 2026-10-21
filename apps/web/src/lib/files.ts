import { useQuery } from "@tanstack/react-query";
import type { FileRef } from "@nibblets/protocol";
import type { ServerConnection } from "./connection.ts";

/** Mock mode keeps files in memory as object URLs. */
const mockFiles = new Map<string, { url: string; ref: FileRef }>();

export function registerMockFile(blob: Blob, name: string, mime: string): FileRef {
  const ref: FileRef = { fileId: `file_mock_${mockFiles.size + 1}`, name, mime, size: blob.size };
  mockFiles.set(ref.fileId, { url: URL.createObjectURL(blob), ref });
  return ref;
}

export function mockFileUrl(fileId: string): string {
  return mockFiles.get(fileId)?.url ?? "";
}

/** A signed link for a stored file, refreshed well before it expires. */
export function useFileUrl(connection: ServerConnection, fileId: string, enabled = true) {
  return useQuery({
    queryKey: ["file-url", connection.id, fileId],
    queryFn: () => connection.fileUrl(fileId),
    enabled,
    staleTime: 45 * 60_000,
    refetchInterval: 45 * 60_000,
  });
}

export function isImage(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mime);
}

/** Opens in a browser tab rather than downloading. */
export function opensInBrowser(mime: string): boolean {
  return isImage(mime) || mime === "application/pdf" || mime.startsWith("text/");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function mockFileRef(fileId: string): FileRef | null {
  return mockFiles.get(fileId)?.ref ?? null;
}
