import { layoutCitations, type CitationLayout } from "./citations";
import type { NumberingStore } from "./numbering";
import type { PaperStore, ReferencesSnapshot } from "./store";

/**
 * The document's CitationLayout, computed again only when the references, the citation format or the order of
 * first citations change (not on every keystroke).
 */
export class CitationStore {
  private snapshot: CitationLayout;
  private inputs: { refs: ReferencesSnapshot; key: string };
  private listeners = new Set<() => void>();
  private cleanups: (() => void)[];

  constructor(
    private store: PaperStore,
    private numbering: NumberingStore
  ) {
    this.inputs = this.readInputs();
    this.snapshot = this.compute();
    this.cleanups = [
      store.referencesSlice.subscribe(this.update),
      store.formatSlice.subscribe(this.update),
      numbering.subscribe(this.update),
    ];
  }

  private readInputs() {
    const citation = this.store.formatSlice.get().citation;
    const key = [citation.style, citation.order, citation.listUncited, this.numbering.get().citationOrder.join(",")].join(
      "|"
    );
    return { refs: this.store.referencesSlice.get(), key };
  }

  private compute(): CitationLayout {
    return layoutCitations(
      this.inputs.refs.list,
      this.numbering.get().citationOrder,
      this.store.formatSlice.get().citation
    );
  }

  private update = () => {
    const inputs = this.readInputs();
    if (inputs.refs === this.inputs.refs && inputs.key === this.inputs.key) return;
    this.inputs = inputs;
    this.snapshot = this.compute();
    this.listeners.forEach((l) => l());
  };

  get = (): CitationLayout => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  destroy(): void {
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
  }
}
