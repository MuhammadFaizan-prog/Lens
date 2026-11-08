/**
 * Undo / redo history of immutable documents. A drag previews many intermediate states and commits
 * once, so one gesture is one undo step.
 */
export interface Entry<T> {
  doc: T;
  label: string;
}

export class History<T> {
  private past: Entry<T>[] = [];
  private future: Entry<T>[] = [];
  private present: Entry<T>;
  /** Document as it was when a transient gesture began. */
  private gestureBase: Entry<T> | null = null;

  constructor(doc: T, private readonly limit = 200) {
    this.present = { doc, label: "open" };
  }

  get doc(): T {
    return this.present.doc;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | null {
    return this.past.length ? this.present.label : null;
  }

  get redoLabel(): string | null {
    return this.future.length ? this.future[this.future.length - 1]!.label : null;
  }

  get size(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  get inGesture(): boolean {
    return this.gestureBase !== null;
  }

  /** A finished edit: one undo step. No-op when the document is unchanged. */
  commit(doc: T, label: string): void {
    if (this.gestureBase) {
      this.preview(doc);
      this.endGesture(label);
      return;
    }
    if (doc === this.present.doc) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = { doc, label };
    this.future = [];
  }

  /** Start a gesture (drag): following previews replace the present without history entries. */
  beginGesture(): void {
    if (!this.gestureBase) this.gestureBase = this.present;
  }

  preview(doc: T): void {
    if (!this.gestureBase) this.beginGesture();
    this.present = { doc, label: this.present.label };
  }

  /** End a gesture: one undo step back to the state before it began (none if nothing changed). */
  endGesture(label: string): void {
    const base = this.gestureBase;
    this.gestureBase = null;
    if (!base || base.doc === this.present.doc) return;
    this.past.push(base);
    if (this.past.length > this.limit) this.past.shift();
    this.present = { doc: this.present.doc, label };
    this.future = [];
  }

  cancelGesture(): void {
    if (this.gestureBase) this.present = this.gestureBase;
    this.gestureBase = null;
  }

  undo(): boolean {
    if (this.gestureBase) this.cancelGesture();
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.present);
    this.present = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.present);
    this.present = next;
    return true;
  }

  /** Replace everything (open another project). */
  reset(doc: T): void {
    this.past = [];
    this.future = [];
    this.gestureBase = null;
    this.present = { doc, label: "open" };
  }
}
