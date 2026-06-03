// PaneManager owns the layout tree and renders it into the DOM as nested flex
// containers with draggable dividers, one TerminalWrapper per leaf. It is the
// single consumer of the layout-tree algorithms (global `LayoutTree`).
//
// Rendering reconciles by paneId: a leaf's wrapper and header are created once
// and re-parented on re-renders — splits and ratio changes never destroy a live
// terminal. Wrappers for panes that leave the tree are disposed.

type PaneDropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

interface PaneManagerCallbacks {
  getBuffer: (sessionId: string) => Promise<string>;
  getSessionName: (sessionId: string) => string;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onFocusChange: (sessionId: string) => void;
  /** Called when the last pane is closed (tree becomes empty). */
  onLayoutEmpty: () => void;
  /** Called when a split button is clicked; caller creates the session and calls splitPane(). */
  onSplitRequest: (paneId: string, direction: SplitDirection) => void;
}

interface PaneRecord {
  paneId: string;
  sessionId: string;
  wrapper: TerminalWrapper;
  /** Outer .terminal-pane element (contains header + body). */
  element: HTMLElement;
  /** The .pane-header element — updated on re-render. */
  header: HTMLElement;
  /** The .pane-close button — visibility toggled when pane count changes. */
  closeBtn: HTMLButtonElement;
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

  isEmpty(): boolean {
    return this.tree === null;
  }

  getFocusedSessionId(): string | null {
    if (!this.focusedPaneId) return null;
    return this.panes.get(this.focusedPaneId)?.sessionId ?? null;
  }

  getFocusedPaneId(): string | null {
    return this.focusedPaneId;
  }

  getVisibleSessionIds(): string[] {
    if (!this.tree) return [];
    return LayoutTree.allLeaves(this.tree).map(l => l.sessionId);
  }

  showSession(sessionId: string): void {
    if (this.tree) {
      const existing = LayoutTree.leafForSession(this.tree, sessionId);
      if (existing) { this.setFocus(existing.paneId); return; }
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

  splitFocused(direction: SplitDirection, sessionId: string): void {
    if (!this.tree || !this.focusedPaneId) { this.showSession(sessionId); return; }
    const newPaneId = this.nextPaneId();
    this.tree = LayoutTree.splitLeaf(
      this.tree, this.focusedPaneId, direction, this.nextSplitId(), newPaneId, sessionId,
    );
    this.focusedPaneId = newPaneId;
    this.render();
  }

  splitPane(paneId: string, direction: SplitDirection, sessionId: string, before: boolean): void {
    if (!this.tree) { this.showSession(sessionId); return; }
    const newPaneId = this.nextPaneId();
    this.tree = LayoutTree.splitLeaf(
      this.tree, paneId, direction, this.nextSplitId(), newPaneId, sessionId, before,
    );
    this.focusedPaneId = newPaneId;
    this.render();
  }

  setPaneSession(paneId: string, sessionId: string): void {
    if (!this.tree) return;
    this.tree = LayoutTree.setLeafSession(this.tree, paneId, sessionId);
    this.focusedPaneId = paneId;
    this.render();
  }

  closePane(paneId: string): void {
    if (!this.tree) return;
    const { tree, focusPaneId } = LayoutTree.closePane(this.tree, paneId);
    this.tree = tree;
    this.focusedPaneId = focusPaneId;
    this.render();
  }

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

  routeOutput(sessionId: string, data: string): void {
    if (!this.tree) return;
    // Write to every pane showing this session (same session can appear in multiple panes).
    for (const leaf of LayoutTree.allLeaves(this.tree)) {
      if (leaf.sessionId === sessionId) {
        this.panes.get(leaf.paneId)?.wrapper.write(data);
      }
    }
  }

  refitAll(): void {
    for (const rec of this.panes.values()) rec.wrapper.fit();
  }

  /** Refresh pane header titles (call after session rename). */
  updateHeaders(): void {
    for (const rec of this.panes.values()) {
      const title = rec.header.querySelector('.pane-title') as HTMLElement | null;
      if (title) title.textContent = this.callbacks.getSessionName(rec.sessionId);
    }
  }

  // --- Focus --------------------------------------------------------------

  setFocus(paneId: string): void {
    this.focusedPaneId = paneId;
    const rec = this.panes.get(paneId);
    if (rec) {
      rec.wrapper.focus();
      this.callbacks.onFocusChange(rec.sessionId);
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
      this.callbacks.onLayoutEmpty();
      return;
    }

    const leaves = LayoutTree.allLeaves(this.tree);
    const liveIds = new Set(leaves.map(l => l.paneId));

    // Dispose wrappers for panes that left the tree.
    for (const [paneId, rec] of [...this.panes]) {
      if (!liveIds.has(paneId)) {
        rec.wrapper.dispose();
        rec.element.remove();
        this.panes.delete(paneId);
      }
    }

    const multiPane = leaves.length > 1;

    // Ensure/update all remaining panes, then rebuild the container tree.
    for (const leaf of leaves) {
      const rec = this.ensurePane(leaf);
      // Update close button visibility based on current pane count.
      rec.closeBtn.style.display = multiPane ? '' : 'none';
    }

    const rootEl = this.buildNode(this.tree);
    this.root.innerHTML = '';
    this.root.appendChild(rootEl);

    if (!this.focusedPaneId || !this.panes.has(this.focusedPaneId)) {
      this.focusedPaneId = leaves[0]?.paneId ?? null;
    }
    if (this.focusedPaneId) this.setFocus(this.focusedPaneId);
    else this.updateFocusStyles();

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

    container.appendChild(childA);
    container.appendChild(this.makeDivider(node));
    container.appendChild(childB);
    return container;
  }

  private ensurePane(leaf: LeafNode): PaneRecord {
    const existing = this.panes.get(leaf.paneId);
    if (existing && existing.sessionId === leaf.sessionId) {
      // Refresh title in case session was renamed.
      const title = existing.header.querySelector('.pane-title') as HTMLElement;
      if (title) title.textContent = this.callbacks.getSessionName(leaf.sessionId);
      return existing;
    }

    // Session changed for this paneId (repoint) — replace.
    if (existing) {
      existing.wrapper.dispose();
      existing.element.remove();
      this.panes.delete(leaf.paneId);
    }

    // .terminal-pane
    //   .pane-header  [title | split-v btn | split-h btn | close btn]
    //   .pane-body    [xterm mounts here]
    const element = document.createElement('div');
    element.className = 'terminal-pane';
    element.dataset.paneId = leaf.paneId;

    const header = this.makeHeader(leaf);

    const body = document.createElement('div');
    body.className = 'pane-body';

    element.appendChild(header);
    element.appendChild(body);

    const wrapper = new TerminalWrapper(body, leaf.sessionId);
    wrapper.onInput(this.callbacks.onInput);
    wrapper.onResize(this.callbacks.onResize);
    wrapper.onFocus(() => this.setFocus(leaf.paneId));

    element.addEventListener('mousedown', () => this.setFocus(leaf.paneId));
    this.installPaneDrop(element, leaf.paneId);

    const closeBtn = header.querySelector('.pane-close') as HTMLButtonElement;
    const rec: PaneRecord = { paneId: leaf.paneId, sessionId: leaf.sessionId, wrapper, element, header, closeBtn };
    this.panes.set(leaf.paneId, rec);

    this.callbacks.getBuffer(leaf.sessionId).then(buf => wrapper.load(buf));
    return rec;
  }

  private makeHeader(leaf: LeafNode): HTMLElement {
    const header = document.createElement('div');
    header.className = 'pane-header';

    const title = document.createElement('span');
    title.className = 'pane-title';
    title.textContent = this.callbacks.getSessionName(leaf.sessionId);
    header.appendChild(title);

    const splitV = document.createElement('button');
    splitV.className = 'pane-btn';
    splitV.title = 'Split right (Cmd+D)';
    splitV.textContent = '⬝';
    splitV.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this.callbacks.onSplitRequest(leaf.paneId, 'vertical');
    });
    header.appendChild(splitV);

    const splitH = document.createElement('button');
    splitH.className = 'pane-btn';
    splitH.title = 'Split down (Cmd+Shift+D)';
    splitH.textContent = '⬚';
    splitH.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this.callbacks.onSplitRequest(leaf.paneId, 'horizontal');
    });
    header.appendChild(splitH);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pane-btn pane-close';
    closeBtn.title = 'Close pane';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this.closePane(leaf.paneId);
    });
    header.appendChild(closeBtn);

    return header;
  }

  // --- Divider drag -------------------------------------------------------

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

  private applyRatios(): void {
    if (!this.tree) return;
    const rootChild = this.root.firstElementChild as HTMLElement | null;
    if (rootChild) this.applyRatiosNode(this.tree, rootChild);
  }

  private applyRatiosNode(node: LayoutNode, el: HTMLElement): void {
    if (node.type === 'leaf') return;
    const childA = el.children[0] as HTMLElement;
    const childB = el.children[2] as HTMLElement;
    if (!childA || !childB) return;
    childA.style.flex = `${node.ratio} 1 0`;
    childB.style.flex = `${1 - node.ratio} 1 0`;
    this.applyRatiosNode(node.a, childA);
    this.applyRatiosNode(node.b, childB);
  }

  // --- Pane drag-to-split -------------------------------------------------

  private installPaneDrop(element: HTMLElement, paneId: string): void {
    element.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('application/x-session-id')) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = this.getPaneDropZone(e, element);
      element.dataset.dropZone = zone;
    });

    element.addEventListener('dragleave', (e: DragEvent) => {
      // Only clear if leaving the pane entirely (not entering a child).
      if (!element.contains(e.relatedTarget as Node | null)) {
        delete element.dataset.dropZone;
      }
    });

    element.addEventListener('drop', (e: DragEvent) => {
      const sessionId = e.dataTransfer?.getData('application/x-session-id');
      if (!sessionId) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = this.getPaneDropZone(e, element);
      delete element.dataset.dropZone;

      if (zone === 'center') {
        this.setPaneSession(paneId, sessionId);
      } else if (zone === 'left') {
        this.splitPane(paneId, 'vertical', sessionId, true);
      } else if (zone === 'right') {
        this.splitPane(paneId, 'vertical', sessionId, false);
      } else if (zone === 'top') {
        this.splitPane(paneId, 'horizontal', sessionId, true);
      } else {
        this.splitPane(paneId, 'horizontal', sessionId, false);
      }
    });
  }

  private getPaneDropZone(e: DragEvent, el: HTMLElement): PaneDropZone {
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0.25) return 'left';
    if (x > 0.75) return 'right';
    if (y < 0.25) return 'top';
    if (y > 0.75) return 'bottom';
    return 'center';
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
      // Ignore session drags — those are handled by individual pane handlers.
      if (e.dataTransfer?.types.includes('application/x-session-id')) return;
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

  // --- Misc ---------------------------------------------------------------

  private disposeAllPanes(): void {
    for (const rec of this.panes.values()) {
      rec.wrapper.dispose();
      rec.element.remove();
    }
    this.panes.clear();
    this.focusedPaneId = null;
  }

  private nextPaneId(): string { return `pane-${++this.paneCounter}`; }
  private nextSplitId(): string { return `split-${++this.splitCounter}`; }
}
