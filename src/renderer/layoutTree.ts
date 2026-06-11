// Renderer-global copy of the layout-tree model. The renderer compiles with
// module: "none" (plain <script> tags, no import/export), so it cannot consume
// src/layout-tree.ts directly. This file mirrors that module's algorithms and
// exposes them as a single global `LayoutTree` object. The src/ version is the
// unit-tested source of truth (see layout-tree.test.ts) — keep the two in sync.
//
// A tiling layout is a binary tree: every `leaf` shows one session in one pane;
// every `split` node holds two children laid out side by side (vertical divider)
// or stacked (horizontal divider), with `ratio` giving the first child's share.

type SplitDirection = 'horizontal' | 'vertical';

interface LeafNode {
  type: 'leaf';
  paneId: string;
  sessionId: string;
}

interface SplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

type LayoutNode = LeafNode | SplitNode;

interface SerializedLayout {
  tree: LayoutNode | null;
}

const LayoutTree = (() => {
  function createLeaf(paneId: string, sessionId: string): LeafNode {
    return { type: 'leaf', paneId, sessionId };
  }

  function splitLeaf(
    tree: LayoutNode,
    paneId: string,
    direction: SplitDirection,
    splitId: string,
    newPaneId: string,
    newSessionId: string,
    before = false,
  ): LayoutNode {
    if (tree.type === 'leaf') {
      if (tree.paneId !== paneId) return tree;
      const newLeaf = createLeaf(newPaneId, newSessionId);
      return {
        type: 'split',
        id: splitId,
        direction,
        ratio: 0.5,
        a: before ? newLeaf : tree,
        b: before ? tree : newLeaf,
      };
    }
    const a = splitLeaf(tree.a, paneId, direction, splitId, newPaneId, newSessionId, before);
    if (a !== tree.a) return { ...tree, a };
    const b = splitLeaf(tree.b, paneId, direction, splitId, newPaneId, newSessionId, before);
    if (b !== tree.b) return { ...tree, b };
    return tree;
  }

  function closePane(tree: LayoutNode, paneId: string): { tree: LayoutNode | null; focusPaneId: string | null } {
    if (tree.type === 'leaf') {
      if (tree.paneId === paneId) return { tree: null, focusPaneId: null };
      return { tree, focusPaneId: tree.paneId };
    }
    if (tree.a.type === 'leaf' && tree.a.paneId === paneId) {
      return { tree: tree.b, focusPaneId: firstLeaf(tree.b).paneId };
    }
    if (tree.b.type === 'leaf' && tree.b.paneId === paneId) {
      return { tree: tree.a, focusPaneId: firstLeaf(tree.a).paneId };
    }
    if (findLeaf(tree.a, paneId)) {
      const res = closePane(tree.a, paneId);
      return { tree: { ...tree, a: res.tree as LayoutNode }, focusPaneId: res.focusPaneId };
    }
    if (findLeaf(tree.b, paneId)) {
      const res = closePane(tree.b, paneId);
      return { tree: { ...tree, b: res.tree as LayoutNode }, focusPaneId: res.focusPaneId };
    }
    return { tree, focusPaneId: null };
  }

  function setRatio(tree: LayoutNode, splitId: string, ratio: number): LayoutNode {
    const clamped = Math.max(0.05, Math.min(0.95, ratio));
    if (tree.type === 'leaf') return tree;
    if (tree.id === splitId) {
      if (tree.ratio === clamped) return tree;
      return { ...tree, ratio: clamped };
    }
    const a = setRatio(tree.a, splitId, clamped);
    if (a !== tree.a) return { ...tree, a };
    const b = setRatio(tree.b, splitId, clamped);
    if (b !== tree.b) return { ...tree, b };
    return tree;
  }

  function setLeafSession(tree: LayoutNode, paneId: string, sessionId: string): LayoutNode {
    if (tree.type === 'leaf') {
      if (tree.paneId !== paneId || tree.sessionId === sessionId) return tree;
      return { ...tree, sessionId };
    }
    const a = setLeafSession(tree.a, paneId, sessionId);
    if (a !== tree.a) return { ...tree, a };
    const b = setLeafSession(tree.b, paneId, sessionId);
    if (b !== tree.b) return { ...tree, b };
    return tree;
  }

  function findLeaf(tree: LayoutNode, paneId: string): LeafNode | undefined {
    if (tree.type === 'leaf') return tree.paneId === paneId ? tree : undefined;
    return findLeaf(tree.a, paneId) ?? findLeaf(tree.b, paneId);
  }

  function leafForSession(tree: LayoutNode, sessionId: string): LeafNode | undefined {
    if (tree.type === 'leaf') return tree.sessionId === sessionId ? tree : undefined;
    return leafForSession(tree.a, sessionId) ?? leafForSession(tree.b, sessionId);
  }

  function allLeaves(tree: LayoutNode): LeafNode[] {
    if (tree.type === 'leaf') return [tree];
    return [...allLeaves(tree.a), ...allLeaves(tree.b)];
  }

  function firstLeaf(tree: LayoutNode): LeafNode {
    let node: LayoutNode = tree;
    while (node.type === 'split') node = node.a;
    return node;
  }

  function serialize(tree: LayoutNode | null): SerializedLayout {
    return { tree };
  }

  function deserialize(data: SerializedLayout | null | undefined): LayoutNode | null {
    return data?.tree ?? null;
  }

  return {
    createLeaf,
    splitLeaf,
    closePane,
    setRatio,
    setLeafSession,
    findLeaf,
    leafForSession,
    allLeaves,
    firstLeaf,
    serialize,
    deserialize,
  };
})();
