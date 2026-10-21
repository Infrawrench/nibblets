import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Music,
  X,
} from "lucide-react";
import type { FileRef, ThreadItemOf } from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { formatBytes, isImage, opensInBrowser, useFileUrl } from "../../lib/files.ts";
import { useServer } from "../../lib/servers.tsx";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/Button.tsx";

export function FileTypeIcon({ mime, className }: { mime: string; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  if (mime.startsWith("image/")) return <FileImage className={cls} />;
  if (mime.startsWith("video/")) return <FileVideo className={cls} />;
  if (mime.startsWith("audio/")) return <Music className={cls} />;
  if (/csv|spreadsheet|excel/.test(mime)) return <FileSpreadsheet className={cls} />;
  if (/zip|tar|gzip|compressed/.test(mime)) return <FileArchive className={cls} />;
  if (mime.startsWith("text/") || /pdf|json|markdown/.test(mime))
    return <FileText className={cls} />;
  return <FileIcon className={cls} />;
}

/** A full-size image over everything; click anywhere or press Escape to close. */
export function Lightbox({
  src,
  name,
  onClose,
}: {
  src: string | null;
  name: string;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={src !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/80 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-6 outline-none">
          <Dialog.Title className="sr-only">{name}</Dialog.Title>
          {src ? (
            <img
              src={src}
              alt={name}
              onClick={onClose}
              className="max-h-full max-w-full cursor-zoom-out rounded-md object-contain shadow-float"
            />
          ) : null}
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
          >
            <X className="size-4" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** An image the user can click to see full size. */
function Thumbnail({
  connection,
  file,
  className,
}: {
  connection: ServerConnection;
  file: FileRef;
  className?: string;
}) {
  const url = useFileUrl(connection, file.fileId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={file.name}
        className={cn(
          "overflow-hidden rounded-lg border border-line bg-deep cursor-zoom-in",
          className,
        )}
      >
        {url.data ? (
          <img src={url.data} alt={file.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-faint" />
          </div>
        )}
      </button>
      <Lightbox
        src={open ? (url.data ?? null) : null}
        name={file.name}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** A non-image file as a chip that downloads, or opens if the browser can show it. */
function FileChip({ connection, file }: { connection: ServerConnection; file: FileRef }) {
  const url = useFileUrl(connection, file.fileId);
  return (
    <a
      href={url.data ?? undefined}
      target={opensInBrowser(file.mime) ? "_blank" : undefined}
      rel="noreferrer"
      download={opensInBrowser(file.mime) ? undefined : file.name}
      className="flex max-w-60 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs hover:bg-hover"
    >
      <FileTypeIcon mime={file.mime} className="text-dim" />
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      <span className="shrink-0 text-faint">{formatBytes(file.size)}</span>
    </a>
  );
}

/** What the user attached to a message, shown in their bubble. */
export function MessageAttachments({
  connection,
  files,
}: {
  connection: ServerConnection;
  files: FileRef[];
}) {
  const images = files.filter((f) => isImage(f.mime));
  const others = files.filter((f) => !isImage(f.mime));
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((f) => (
            <Thumbnail key={f.fileId} connection={connection} file={f} className="size-28" />
          ))}
        </div>
      ) : null}
      {others.map((f) => (
        <FileChip key={f.fileId} connection={connection} file={f} />
      ))}
    </div>
  );
}

/** A file the nibblet shared: uploading, ready to open or download, or failed. */
export function SharedFile({
  connection,
  item,
}: {
  connection: ServerConnection;
  item: ThreadItemOf<"file">;
}) {
  const ready = item.status === "ready";
  const url = useFileUrl(connection, item.fileId, ready);
  const [open, setOpen] = useState(false);
  const progress = item.size > 0 ? Math.min(1, item.received / item.size) : 0;
  const image = ready && isImage(item.mime);

  return (
    <div className="flex max-w-md flex-col overflow-hidden rounded-lg border border-line bg-surface">
      {image ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex max-h-72 items-center justify-center overflow-hidden bg-deep cursor-zoom-in"
        >
          {url.data ? (
            <img src={url.data} alt={item.name} className="max-h-72 w-full object-contain" />
          ) : (
            <Loader2 className="my-10 size-5 animate-spin text-faint" />
          )}
        </button>
      ) : null}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            item.status === "failed" ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent",
          )}
        >
          {item.status === "failed" ? (
            <AlertTriangle className="size-4" />
          ) : (
            <FileTypeIcon mime={item.mime} />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{item.name}</span>
          <span className="truncate text-2xs text-faint">
            {item.status === "uploading"
              ? `Uploading… ${formatBytes(item.received)} of ${formatBytes(item.size)}`
              : item.status === "failed"
                ? (item.error ?? "Couldn't upload")
                : formatBytes(item.size)}
          </span>
        </div>
        {ready && url.data ? (
          <div className="flex shrink-0 items-center gap-1">
            {opensInBrowser(item.mime) && !image ? (
              <a href={url.data} target="_blank" rel="noreferrer" title="Open">
                <Button size="icon" variant="ghost" tabIndex={-1}>
                  <ExternalLink />
                </Button>
              </a>
            ) : null}
            <a href={url.data} download={item.name} title="Download">
              <Button size="sm" tabIndex={-1}>
                <Download />
                Download
              </Button>
            </a>
          </div>
        ) : null}
      </div>
      {item.status === "uploading" ? (
        <div className="h-1 bg-deep">
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.max(4, progress * 100)}%` }}
          />
        </div>
      ) : null}
      {item.caption ? (
        <p className="border-t border-line px-3 py-2 text-xs text-dim">{item.caption}</p>
      ) : null}
      <Lightbox
        src={open ? (url.data ?? null) : null}
        name={item.name}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/** The thread's way in: looks the server up by id, as the timeline only has that. */
export function UserAttachments({ server, files }: { server: string; files: FileRef[] }) {
  const connection = useServer(server);
  return connection ? <MessageAttachments connection={connection} files={files} /> : null;
}

export function SharedFileEntry({ server, item }: { server: string; item: ThreadItemOf<"file"> }) {
  const connection = useServer(server);
  return connection ? <SharedFile connection={connection} item={item} /> : null;
}
