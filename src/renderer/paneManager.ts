// PaneManager owns the layout tree and renders it into the DOM as nested flex
// containers with draggable dividers, one TerminalWrapper per leaf. It is the
// single consumer of the layout-tree algorithms (global `LayoutTree`).
//
// Rendering reconciles by paneId: a leaf's `.terminal-pane` element (and its
// xterm instance) is created once and re-parented across re-renders, so splits
// and ratio changes never destroy a live terminal. Wrappers whose pane leaves
// the tree are disposed.

interface PaneManagerCallbacks {
  getBuffer: (sessionId: string) => Promise<string>;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onFocusChange: (sessionId: string) => void;
}

interface PaneRecord {
  paneId: string;
  wrapper: TerminalWrapper;
  element: HTMLElement;
}

class PaneManager {
  private root: HTMLElement;
  private callbacks: PaneManagerCallbacks;
  private tree: LayoutNode | null = null;
  private panes = new Map<string, PaneRecord>();
  private focusedPaneId: string | null = null;
  private paneCounter = 0;
  private splitCounter = 0;

  constructor(root: HTMLElement, callbacks: PaneManagerCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.installFileDrop();
  }

  // --- Public API ---------------------------------------------------------

  /** True when no panes are shown (renderer should show the empty state). */
  isEmpty(): boolean {
    return this.tree === null;
  }

  /** The session in the currently focused pane, or null. */
  getFocusedSessionId(): string | null {
    if (!this.focusedPaneId) return null;
    const rec = this.panes.get(this.focusedPaneId);
    return rec ? rec.wrapper.sessionId : null;
  }

  /** Session ids currently visible across all panes. */
  getVisibleSessionIds(): string[] {
    if (!this.tree) return [];
    return LayoutTree.allLeaves(this.tree).map(l => l.sessionId);
  }

  /**
   * Show a session. If it is already in a pane, just focus that pane. Otherwise
   * point the focused pane at it (replacing what it showed), or create the first
   * pane if the layout is empty.
   */
  showSession(sessionId: string): void {
    if (this.tree) {
      const existing = LayoutTree.leafForSession(this.tree, sessionId);
      if (existing) {
        this.setFocus(existing.paneId);
        return;
      }
    }

    if (!this.tree) {
      const paneId = this.nextPaneId();
      this.tree = LayoutTree.createLeaf(paneId, sessionId);
      this.focusedPaneId = paneId;
    } else if (this.focusedPaneId) {
      this.tree = LayoutTree.setLeafSession(this.tree, this.focusedPaneId, sessionId);
    }
    this.render();
  }

  /** Split the focused pane, opening `sessionId` in the new pane. */
  splitFocused(direction: SplitDirection, sessionId: string): void {
    if (!this.tree || !this.focusedPaneId) {
      this.showSession(sessionId);
      return;
    }
    const newPaneId = this.nextPaneId();
    this.tree = LayoutTree.splitLeaf(
      this.tree, this.focusedPaneId, direction, this.nextSplitId(), newPaneId, sessionId,
    );
    this.focusedPaneId = newPaneId;
    this.render();
  }

  /** Split a specific pane (used by drag-to-edge), opening `sessionId`. */
  splitPane(paneId: string, direction: SplitDirection, sessionId: string, before: boolean): void {
    if (!this.tree) {
      this.showSession(sessionId);
      return;
    }
    const newPaneId = this.nextPaneId();
    this.tree = LayoutTree.splitLeaf(
      this.tree, paneId, direction, this.nextSplitId(), newPaneId, sessionId, before,
    );
    this.focusedPaneId = newPaneId;
    this.render();
  }

  /** Point an existing pane at a different session (drag onto pane center). */
  setPaneSession(paneId: string, sessionId: string): void {
    if (!this.tree) return;
    this.tree = LayoutTree.setLeafSession(this.tree, paneId, sessionId);
    this.focusedPaneId = paneId;
    this.render();
  }

  /** Close a pane; the layout collapses into its sibling. */
  closePane(paneId: string): void {
    if (!this.tree) return;
    const { tree, focusPaneId } = LayoutTree.closePane(this.tree, paneId);
    this.tree = tree;
    this.focusedPaneId = focusPaneId;
    this.render();
  }

  /** Remove whichever pane(s) show a session (e.g. when the session is killed). */
  removeSession(sessionId: string): void {
    if (!this.tree) return;
    let leaf = LayoutTree.leafForSession(this.tree, sessionId);
    while (leaf) {
      const { tree, focusPaneId } = LayoutTree.closePane(this.tree, leaf.paneId);
      this.tree = tree;
      this.focusedPaneId = focusPaneId;
      if (!this.tree) break;
      leaf = LayoutTree.leafForSession(this.tree, sessionId);
    }
    this.render();
  }

  /** Write live output to the pane showing `sessionId` (no-op if not visible). */
  routeOutput(sessionId: string, data: string): void {
    if (!this.tree) return;
    const leaf = LayoutTree.leafForSession(this.tree, sessionId);
    if (!leaf) return;
    this.panes.get(leaf.paneId)?.wrapper.write(data);
  }

  /** Re-fit every visible terminal (e.g. after a window resize). */
  refitAll(): void {
    for (const rec of this.panes.values()) rec.wrapper.fit();
  }

  // --- Focus --------------------------------------------------------------

  setFocus(paneId: string): void {
    this.focusedPaneId = paneId;
    const rec = this.panes.get(paneId);
    if (rec) {
      rec.wrapper.focus();
      this.callbacks.onFocusChange(rec.wrapper.sessionId);
    }
    this.updateFocusStyles();
  }

  private updateFocusStyles(): void {
    for (const [paneId, rec] of this.panes) {
      rec.element.classList.toggle('focused', paneId === this.focusedPaneId);
    }
  }

  // --- Rendering ----------------------------------------------------------

  private render(): void {
    if (!this.tree) {
      this.disposeAllPanes();
      this.root.innerHTML = '';
      return;
    }

    // Reconcile panes: drop wrappers no longer present in the tree.
    const leaves = LayoutTree.allLeaves(this.tree);
    const liveIds = new Set(leaves.map(l => l.paneId));
    for (const [paneId, rec] of [...this.panes]) {
      if (!liveIds.has(paneId)) {
        rec.wrapper.dispose();
        rec.element.remove();
        this.panes.delete(paneId);
      }
    }

    // (Re)build the container tree, re-parenting stable pane elements.
    const rootEl = this.buildNode(this.tree);
    this.root.innerHTML = '';
    this.root.appendChild(rootEl);

    if (!this.focusedPaneId || !this.panes.has(this.focusedPaneId)) {
      this.focusedPaneId = leaves[0]?.paneId ?? null;
    }
    // Focus the active pane and notify the app (keeps sidebar/active session in sync).
    if (this.focusedPaneId) this.setFocus(this.focusedPaneId);
    else this.updateFocusStyles();

    // Layout changed — fit terminals after the browser applies flex sizing.
    requestAnimationFrame(() => this.refitAll());
  }

  private buildNode(node: LayoutNode): HTMLElement {
    if (node.type === 'leaf') {
      return this.ensurePane(node).element;
    }

    const container = document.createElement('div');
    container.className = 'split-container';
    container.style.flexDirection = node.direction === 'vertical' ? 'row' : 'column';

    const childA = this.buildNode(node.a);
    const childB = this.buildNode(node.b);
    childA.style.flex = `${node.ratio} 1 0`;
    childB.style.flex = `${1 - node.ratio} 1 0`;

    const divider = this.makeDivider(node);

    container.appendChild(childA);
    container.appendChild(divider);
    container.appendChild(childB);
    return container;
  }

  private ensurePane(leaf: LeafNode): PaneRecord {
    const existing = this.panes.get(leaf.paneId);
    if (existing && existing.wrapper.sessionId === leaf.sessionId) {
      return existing;
    }
    // Session changed for this paneId (repoint) — replace the wrapper.
    if (existing) {
      existing.wrapper.dispose();
      existing.element.remove();
      this.panes.delete(leaf.paneId);
    }

    const element = document.createElement('div');
    element.className = 'terminal-pane';
    element.dataset.paneId = leaf.paneId;

    const wrapper = new TerminalWrapper(element, leaf.sessionId);
    wrapper.onInput(this.callbacks.onInput);
    wrapper.onResize(this.callbacks.onResize);
    wrapper.onFocus(() => this.setFocus(leaf.paneId));

    element.addEventListener('mousedown', () => this.setFocus(leaf.paneId));

    const rec: PaneRecord = { paneId: leaf.paneId, wrapper, element };
    this.panes.set(leaf.paneId, rec);

    this.callbacks.getBuffer(leaf.sessionId).then(buf => wrapper.load(buf));
    return rec;
  }

  private makeDivider(split: SplitNode): HTMLElement {
    const divider = document.createElement('div');
    divider.className = `pane-divider ${split.direction}`;

    const onMove = (ev: MouseEvent) => {
      const container = divider.parentElement;
      if (!container || !this.tree) return;
      const rect = container.getBoundingClientRect();
      const ratio = split.direction === 'vertical'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      this.tree = LayoutTree.setRatio(this.tree, split.id, ratio);
      this.applyRatios();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      this.refitAll();
    };

    divider.addEventListener('mousedown', (ev: MouseEvent) => {
      ev.preventDefault();
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    return divider;
  }

  /**
   * Cheaply update flex ratios in-place during a divider drag, without a full
   * re-render (which would thrash xterm). Walks the DOM in lockstep with the tree.
   */
  private applyRatios(): void {
    if (!this.tree) return;
    const rootChild = this.root.firstElementChild as HTMLElement | null;
    if (rootChild) this.applyRatiosNode(this.tree, rootChild);
  }

  private applyRatiosNode(node: LayoutNode, el: HTMLElement): void {
    if (node.type === 'leaf') return;
    // A split-container holds [childA, divider, childB].
    const childA = el.children[0] as HTMLElement;
    const childB = el.children[2] as HTMLElement;
    if (!childA || !childB) return;
    childA.style.flex = `${node.ratio} 1 0`;
    childB.style.flex = `${1 - node.ratio} 1 0`;
    this.applyRatiosNode(node.a, childA);
    this.applyRatiosNode(node.b, childB);
  }

  private disposeAllPanes(): void {
    for (const rec of this.panes.values()) {
      rec.wrapper.dispose();
      rec.element.remove();
    }
    this.panes.clear();
    this.focusedPaneId = null;
  }

  // --- File drag/drop (document-level, routed to the focused pane) ---------

  private installFileDrop(): void {
    document.addEventListener('dragover', (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    document.addEventListener('drop', (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      const target = this.getFocusedSessionId();
      if (!target) return;
      const paths = Array.from(files)
        .map(f => (window as any).api.getPathForFile(f) as string)
        .filter(Boolean);
      if (paths.length > 0) this.callbacks.onInput(target, paths.join(' '));
    });
  }

  // --- Id generation ------------------------------------------------------

  private nextPaneId(): string {
    return `pane-${++this.paneCounter}`;
  }

  private nextSplitId(): string {
    return `split-${++this.splitCounter}`;
  }
}
