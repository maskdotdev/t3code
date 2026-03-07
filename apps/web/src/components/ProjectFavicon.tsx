import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `ws://${window.location.hostname}:${window.location.port}`;
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

export default function ProjectFavicon({
  className,
  cwd,
}: {
  className?: string;
  cwd: string;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return (
      <FolderIcon className={cn("size-3.5 shrink-0 text-muted-foreground/50", className)} />
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={cn(
        "size-3.5 shrink-0 rounded-sm object-contain",
        status === "loading" && "hidden",
        className,
      )}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}
