// Pure, DOM-free layout-tree model for tiled (split) terminal panes.
//
// A tiling layout is a binary tree: every `leaf` shows one session in one pane;
// every `split` node holds two children laid out side by side (vertical divider)
// or stacked (horizontal divider), with `ratio` giving the first child's share.
//
// This module is intentionally free of any DOM/xterm dependency so it can be
// unit-tested in isolation (see layout-tree.test.ts), mirroring how
// app-state-logic.ts extracts the renderer's sidebar logic.

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
  /** First child's fraction of the available space, 0..1. Second child gets 1 - ratio. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

type LayoutNode = LeafNode | SplitNode;

interface SerializedLayout {
  tree: LayoutNode | null;
}

/** Create a single-pane layout. */
function createLeaf(paneId: string, sessionId: string): LeafNode {
  return { type: 'leaf', paneId, sessionId };
}

/**
 * Split the leaf identified by `paneId`, replacing it with a split node whose
 * first child is the original leaf and whose second child is a new leaf.
 *
 * `before === true` places the new pane first (a), otherwise second (b).
 * Returns a new tree; the input is not mutated. If `paneId` is not found the
 * tree is returned unchanged (referentially equal).
 */
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

/**
 * Remove the pane `paneId`. Its parent split collapses into the sibling subtree.
 * Returns `{ tree, focusPaneId }` where `focusPaneId` is a sensible pane to
 * focus next (the nearest leaf of the surviving sibling), or null if nothing
 * remains. Closing the last pane yields `{ tree: null, focusPaneId: null }`.
 * The input is not mutated.
 */
function closePane(tree: LayoutNode, paneId: string): { tree: LayoutNode | null; focusPaneId: string | null } {
  if (tree.type === 'leaf') {
    if (tree.paneId === paneId) return { tree: null, focusPaneId: null };
    return { tree, focusPaneId: tree.paneId };
  }

  // If a direct child is the target leaf, collapse to the other child.
  if (tree.a.type === 'leaf' && tree.a.paneId === paneId) {
    return { tree: tree.b, focusPaneId: firstLeaf(tree.b).paneId };
  }
  if (tree.b.type === 'leaf' && tree.b.paneId === paneId) {
    return { tree: tree.a, focusPaneId: firstLeaf(tree.a).paneId };
  }

  // Recurse into whichever subtree contains the pane.
  const inA = findLeaf(tree.a, paneId);
  if (inA) {
    const res = closePane(tree.a, paneId);
    return { tree: { ...tree, a: res.tree as LayoutNode }, focusPaneId: res.focusPaneId };
  }
  const inB = findLeaf(tree.b, paneId);
  if (inB) {
    const res = closePane(tree.b, paneId);
    return { tree: { ...tree, b: res.tree as LayoutNode }, focusPaneId: res.focusPaneId };
  }

  return { tree, focusPaneId: null };
}

/** Set the divider ratio of the split node `splitId` (clamped to 0.05..0.95). Non-mutating. */
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

/** Find a leaf by paneId, or undefined. */
function findLeaf(tree: LayoutNode, paneId: string): LeafNode | undefined {
  if (tree.type === 'leaf') return tree.paneId === paneId ? tree : undefined;
  return findLeaf(tree.a, paneId) ?? findLeaf(tree.b, paneId);
}

/** Find the leaf currently showing `sessionId`, or undefined. */
function leafForSession(tree: LayoutNode, sessionId: string): LeafNode | undefined {
  if (tree.type === 'leaf') return tree.sessionId === sessionId ? tree : undefined;
  return leafForSession(tree.a, sessionId) ?? leafForSession(tree.b, sessionId);
}

/** All leaves, left-to-right depth-first (matches visual order). */
function allLeaves(tree: LayoutNode): LeafNode[] {
  if (tree.type === 'leaf') return [tree];
  return [...allLeaves(tree.a), ...allLeaves(tree.b)];
}

/** Leftmost/topmost leaf of a subtree — the default focus target after a collapse. */
function firstLeaf(tree: LayoutNode): LeafNode {
  let node: LayoutNode = tree;
  while (node.type === 'split') node = node.a;
  return node;
}

/** Point an existing pane at a different session (e.g. dropping a session onto a pane's center). Non-mutating. */
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

function serialize(tree: LayoutNode | null): SerializedLayout {
  return { tree };
}

function deserialize(data: SerializedLayout | null | undefined): LayoutNode | null {
  return data?.tree ?? null;
}

// Exported as a namespace-style object so the renderer (module: "none", plain
// script tag) and the Vitest suite can both consume it without a bundler.
const LayoutTree = {
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

export default LayoutTree;
export type { LayoutNode, LeafNode, SplitNode, SplitDirection, SerializedLayout };
