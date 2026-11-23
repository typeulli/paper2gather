import { Suspense } from "react";
import { EditorPage } from "@/components/editor/editor-page";

export default function DocumentPage({ params }: PageProps<"/doc/[id]">) {
  return (
    <Suspense fallback={null}>
      {params.then(({ id }) => (
        <EditorPage key={id} docId={id} />
      ))}
    </Suspense>
  );
}
