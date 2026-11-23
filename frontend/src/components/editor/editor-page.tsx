"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { FileXIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { COLLAB_URL } from "@/lib/config";
import { CitationStore } from "@/lib/paper/citation-store";
import { NumberingStore } from "@/lib/paper/numbering";
import { PaperStore } from "@/lib/paper/store";
import { Workspace } from "./workspace";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Session {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  store: PaperStore;
  numbering: NumberingStore;
  citations: CitationStore;
}

/** Close code sent by the backend when the document does not exist (or was deleted). */
const CLOSE_NOT_FOUND = 4404;

export function EditorPage({ docId }: { docId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(COLLAB_URL, docId, ydoc);
    const store = new PaperStore(ydoc);
    const numbering = new NumberingStore();
    const citations = new CitationStore(store, numbering);

    provider.on("status", ({ status }) => setStatus(status));
    // The editor is created only after the first sync, otherwise TipTap would
    // write an empty paragraph into the shared document before the real content arrives.
    provider.on("sync", (isSynced) => {
      if (isSynced) setSynced(true);
    });
    provider.on("closed", ({ code }) => {
      if (code === CLOSE_NOT_FOUND) setNotFound(true);
    });

    // The session owns sockets/timers, so it has to be created and destroyed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession({ ydoc, provider, store, numbering, citations });
    return () => {
      provider.destroy();
      citations.destroy();
      store.destroy();
      ydoc.destroy();
      setSession(null);
      setSynced(false);
      setNotFound(false);
    };
  }, [docId]);

  if (notFound) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 text-center">
        <FileXIcon className="size-10 text-muted-foreground" />
        <div>
          <p className="text-lg font-medium">문서를 찾을 수 없습니다</p>
          <p className="text-sm text-muted-foreground">삭제되었거나 잘못된 주소입니다.</p>
        </div>
        <Button asChild>
          <Link href="/">문서 목록으로</Link>
        </Button>
      </div>
    );
  }

  if (!session || !synced) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin" />
        {status === "disconnected" ? "서버에 연결할 수 없습니다. 재시도 중…" : "문서를 불러오는 중…"}
      </div>
    );
  }

  return <Workspace docId={docId} session={session} status={status} />;
}
