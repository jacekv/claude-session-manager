// Group & sidebar state shared across renderer scripts
const groups = new Map<string, SessionGroup>();
let groupCounter = 0;
let dragInProgress = false;
type SidebarEntry = { type: 'session'; id: string } | { type: 'group'; id: string };
let sidebarOrder: SidebarEntry[] = [];

function getGroupForSession(sessionId: string): SessionGroup | undefined {
  for (const group of groups.values()) {
    if (group.sessionIds.includes(sessionId)) return group;
  }
  return undefined;
}

function enforceGroupIntegrity(): void {
  for (const [groupId, group] of groups) {
    group.sessionIds = group.sessionIds.filter(id => sessions.has(id));

    if (group.sessionIds.length <= 1) {
      const remainingId = group.sessionIds[0];
      const idx = sidebarOrder.findIndex(e => e.type === 'group' && e.id === groupId);
      if (idx !== -1) {
        if (remainingId) {
          sidebarOrder[idx] = { type: 'session', id: remainingId };
        } else {
          sidebarOrder.splice(idx, 1);
        }
      }
      groups.delete(groupId);
    }
  }
}

function getVisibleSessionOrder(): string[] {
  const result: string[] = [];
  for (const entry of sidebarOrder) {
    if (entry.type === 'session') {
      if (sessions.has(entry.id)) result.push(entry.id);
    } else {
      const group = groups.get(entry.id);
      if (group) {
        for (const sid of group.sessionIds) {
          if (sessions.has(sid)) result.push(sid);
        }
      }
    }
  }
  return result;
}

function removeSidebarEntry(sessionId: string): void {
  sidebarOrder = sidebarOrder.filter(e => !(e.type === 'session' && e.id === sessionId));
  const group = getGroupForSession(sessionId);
  if (group) {
    group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
  }
}

// --- State persistence ---

function buildSavedState(pm: PaneManager): string {
  const savedSessions = Array.from(sessions.entries()).map(([id, s]) => ({
    id, name: s.name, cwd: s.cwd,
  }));
  const savedGroups = Array.from(groups.values());
  return JSON.stringify({
    sessions: savedSessions,
    groups: savedGroups,
    sidebarOrder,
    groupCounter,
    layout: pm.serializeLayout(),
  } as SavedState);
}

let saveTimeout: number | undefined;
let scheduleSaveImpl: (() => void) | null = null;

function scheduleSave(): void {
  scheduleSaveImpl?.();
}

function initScheduleSave(impl: () => void): void {
  scheduleSaveImpl = impl;
}

async function restoreState(pm: PaneManager): Promise<boolean> {
  const raw = await window.api.loadState();
  if (!raw) return false;

  let state: SavedState;
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }

  const idMap = new Map<string, string>();

  await Promise.all(state.sessions.map(async (saved) => {
    const session = await window.api.createSessionAt(saved.cwd, { continue: true }) as SessionInfo | null;
    if (session) {
      session.name = saved.name;
      sessions.set(session.id, session);
      idMap.set(saved.id, session.id);
    }
  }));

  groupCounter = state.groupCounter;
  for (const savedGroup of state.groups) {
    const remappedIds = savedGroup.sessionIds
      .map(id => idMap.get(id))
      .filter((id): id is string => id !== undefined);
    if (remappedIds.length >= 2) {
      const group: SessionGroup = {
        id: savedGroup.id,
        name: savedGroup.name,
        sessionIds: remappedIds,
        collapsed: savedGroup.collapsed,
      };
      groups.set(group.id, group);
    }
  }

  for (const entry of state.sidebarOrder) {
    if (entry.type === 'session') {
      const newId = idMap.get(entry.id);
      if (newId) sidebarOrder.push({ type: 'session', id: newId });
    } else {
      if (groups.has(entry.id)) {
        sidebarOrder.push({ type: 'group', id: entry.id });
      } else {
        const savedGroup = state.groups.find(g => g.id === entry.id);
        if (savedGroup) {
          for (const oldId of savedGroup.sessionIds) {
            const newId = idMap.get(oldId);
            if (newId) sidebarOrder.push({ type: 'session', id: newId });
          }
        }
      }
    }
  }

  // Any sessions not yet in sidebarOrder (edge case)
  const inOrder = new Set(getVisibleSessionOrder());
  for (const id of sessions.keys()) {
    if (!inOrder.has(id)) {
      sidebarOrder.push({ type: 'session', id });
    }
  }

  if (state.layout) {
    pm.restoreLayout(state.layout, idMap);
  }

  return sessions.size > 0;
}
