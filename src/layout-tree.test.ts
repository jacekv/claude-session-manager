import { describe, it, expect, beforeEach } from 'vitest';
import LayoutTree, { LayoutNode, SplitNode } from './layout-tree';

const {
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
} = LayoutTree;

/** Split a leaf with terse positional defaults for test readability. */
function split(
  tree: LayoutNode,
  paneId: string,
  dir: 'horizontal' | 'vertical',
  splitId: string,
  newPane: string,
  newSession: string,
  before = false,
): LayoutNode {
  return splitLeaf(tree, paneId, dir, splitId, newPane, newSession, before);
}

describe('createLeaf', () => {
  it('creates a single-pane leaf', () => {
    const leaf = createLeaf('p1', 's1');
    expect(leaf).toEqual({ type: 'leaf', paneId: 'p1', sessionId: 's1' });
  });
});

describe('splitLeaf', () => {
  it('replaces the target leaf with a split node, original first by default', () => {
    const tree = createLeaf('p1', 's1');
    const result = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2') as SplitNode;

    expect(result.type).toBe('split');
    expect(result.id).toBe('sp1');
    expect(result.direction).toBe('vertical');
    expect(result.ratio).toBe(0.5);
    expect(result.a).toEqual({ type: 'leaf', paneId: 'p1', sessionId: 's1' });
    expect(result.b).toEqual({ type: 'leaf', paneId: 'p2', sessionId: 's2' });
  });

  it('places the new pane first when before=true', () => {
    const tree = createLeaf('p1', 's1');
    const result = split(tree, 'p1', 'horizontal', 'sp1', 'p2', 's2', true) as SplitNode;
    expect((result.a as any).paneId).toBe('p2');
    expect((result.b as any).paneId).toBe('p1');
  });

  it('splits a nested leaf, leaving the rest of the tree intact', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2'); // p1 | p2
    tree = split(tree, 'p2', 'horizontal', 'sp2', 'p3', 's3'); // p1 | (p2 / p3)

    const root = tree as SplitNode;
    expect(root.id).toBe('sp1');
    expect((root.a as any).paneId).toBe('p1');
    const right = root.b as SplitNode;
    expect(right.type).toBe('split');
    expect(right.direction).toBe('horizontal');
    expect((right.a as any).paneId).toBe('p2');
    expect((right.b as any).paneId).toBe('p3');
  });

  it('returns the same reference when paneId is not found (no-op)', () => {
    const tree = createLeaf('p1', 's1');
    const result = split(tree, 'nope', 'vertical', 'sp1', 'p2', 's2');
    expect(result).toBe(tree);
  });

  it('does not mutate the input tree', () => {
    const tree = createLeaf('p1', 's1');
    const snapshot = JSON.parse(JSON.stringify(tree));
    split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    expect(tree).toEqual(snapshot);
  });
});

describe('closePane', () => {
  it('returns null tree when closing the only pane', () => {
    const tree = createLeaf('p1', 's1');
    const { tree: next, focusPaneId } = closePane(tree, 'p1');
    expect(next).toBeNull();
    expect(focusPaneId).toBeNull();
  });

  it('collapses a 2-pane split to the surviving sibling and focuses it', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');

    const { tree: next, focusPaneId } = closePane(tree, 'p1');
    expect(next).toEqual({ type: 'leaf', paneId: 'p2', sessionId: 's2' });
    expect(focusPaneId).toBe('p2');
  });

  it('collapses the correct branch in a nested tree', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');   // p1 | p2
    tree = split(tree, 'p2', 'horizontal', 'sp2', 'p3', 's3'); // p1 | (p2 / p3)

    const { tree: next } = closePane(tree, 'p3'); // -> p1 | p2
    const root = next as SplitNode;
    expect(root.id).toBe('sp1');
    expect((root.a as any).paneId).toBe('p1');
    expect((root.b as any).paneId).toBe('p2'); // sp2 collapsed away
    expect(root.b.type).toBe('leaf');
  });

  it('focuses a leaf within the surviving sibling subtree', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');   // p1 | p2
    tree = split(tree, 'p1', 'horizontal', 'sp2', 'p3', 's3'); // (p1 / p3) | p2

    // Close p2 -> survivor is the (p1 / p3) subtree; focus its first leaf p1.
    const { tree: next, focusPaneId } = closePane(tree, 'p2');
    expect((next as SplitNode).id).toBe('sp2');
    expect(focusPaneId).toBe('p1');
  });

  it('does not mutate the input tree', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    const snapshot = JSON.parse(JSON.stringify(tree));
    closePane(tree, 'p1');
    expect(tree).toEqual(snapshot);
  });

  it('is a no-op for an unknown paneId', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    const { tree: next } = closePane(tree, 'ghost');
    expect(next).toBe(tree);
  });
});

describe('setRatio', () => {
  it('updates the matching split node ratio', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    const next = setRatio(tree, 'sp1', 0.3) as SplitNode;
    expect(next.ratio).toBe(0.3);
  });

  it('clamps ratio to 0.05..0.95', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    expect((setRatio(tree, 'sp1', 0) as SplitNode).ratio).toBe(0.05);
    expect((setRatio(tree, 'sp1', 1) as SplitNode).ratio).toBe(0.95);
    expect((setRatio(tree, 'sp1', -5) as SplitNode).ratio).toBe(0.05);
  });

  it('returns the same reference when ratio is unchanged', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    const next = setRatio(tree, 'sp1', 0.5);
    expect(next).toBe(tree);
  });

  it('updates a nested split without disturbing siblings', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    tree = split(tree, 'p2', 'horizontal', 'sp2', 'p3', 's3');
    const next = setRatio(tree, 'sp2', 0.25) as SplitNode;
    expect((next.b as SplitNode).ratio).toBe(0.25);
    expect(next.ratio).toBe(0.5); // outer unchanged
  });
});

describe('setLeafSession', () => {
  it('repoints a pane at a new session', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    const next = setLeafSession(tree, 'p2', 's9') as SplitNode;
    expect((next.b as any).sessionId).toBe('s9');
    expect((next.a as any).sessionId).toBe('s1');
  });

  it('returns the same reference when session is unchanged', () => {
    const tree = createLeaf('p1', 's1');
    expect(setLeafSession(tree, 'p1', 's1')).toBe(tree);
  });
});

describe('queries', () => {
  let tree: LayoutNode;
  beforeEach(() => {
    tree = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    tree = split(tree, 'p2', 'horizontal', 'sp2', 'p3', 's3'); // p1 | (p2 / p3)
  });

  it('findLeaf locates leaves by paneId', () => {
    expect(findLeaf(tree, 'p3')).toEqual({ type: 'leaf', paneId: 'p3', sessionId: 's3' });
    expect(findLeaf(tree, 'nope')).toBeUndefined();
  });

  it('leafForSession locates leaves by sessionId', () => {
    expect(leafForSession(tree, 's2')?.paneId).toBe('p2');
    expect(leafForSession(tree, 'ghost')).toBeUndefined();
  });

  it('allLeaves returns leaves in left-to-right visual order', () => {
    expect(allLeaves(tree).map(l => l.paneId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('firstLeaf returns the leftmost/topmost leaf', () => {
    expect(firstLeaf(tree).paneId).toBe('p1');
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a tree', () => {
    let tree: LayoutNode = createLeaf('p1', 's1');
    tree = split(tree, 'p1', 'vertical', 'sp1', 'p2', 's2');
    const restored = deserialize(serialize(tree));
    expect(restored).toEqual(tree);
  });

  it('round-trips an empty layout', () => {
    expect(deserialize(serialize(null))).toBeNull();
    expect(deserialize(null)).toBeNull();
    expect(deserialize(undefined)).toBeNull();
  });
});
