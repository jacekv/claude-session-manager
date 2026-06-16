let paneManager: PaneManager;
let activeSessionId: string | null = null;
const sessions = new Map<string, SessionInfo>();

document.addEventListener('DOMContentLoaded', () => {
  const terminalPanel = document.getElementById('terminal-panel')!;
  const emptyState = document.getElementById('empty-state')!;

  paneManager = new PaneManager(terminalPanel, {
    getBuffer: (sessionId: string) => window.api.getBuffer(sessionId),
    getSessionName: (sessionId: string) => sessions.get(sessionId)?.name ?? sessionId,
    onInput: (sessionId: string, data: string) => window.api.sendInput(sessionId, data),
    onResize: (sessionId: string, cols: number, rows: number) => window.api.resizeSession(sessionId, cols, rows),
    onFocusChange: (sessionId: string) => {
      activeSessionId = sessionId;
      window.api.setActiveSession(sessionId);
      renderSidebar();
    },
    onLayoutEmpty: () => {
      activeSessionId = null;
      terminalPanel.classList.remove('visible');
      emptyState.style.display = '';
    },
    onSplitRequest: (paneId: string, direction: SplitDirection) => {
      splitNewSession(paneId, direction);
    },
  });

  initStatusBar();

  initScheduleSave(() => {
    if (saveTimeout !== undefined) clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(async () => {
      if (sessions.size > 0) {
        await window.api.saveState(buildSavedState(paneManager));
      }
    }, 500);
  });

  window.api.onSaveAndQuit(async () => {
    if (sessions.size > 0) {
      await window.api.saveState(buildSavedState(paneManager));
    }
  });

  async function createNewSession(): Promise<void> {
    const session = await window.api.createSession();
    if (!session) return;

    sessions.set(session.id, session);
    sidebarOrder.push({ type: 'session', id: session.id });
    renderSidebar();
    switchToSession(session.id);
    scheduleSave();
  }

  // Attempt to restore previous state on startup
  restoreState(paneManager).then((restored) => {
    if (restored) {
      renderSidebar();
      if (!paneManager.isEmpty()) {
        terminalPanel.classList.add('visible');
        emptyState.style.display = 'none';
      } else {
        const firstId = getVisibleSessionOrder()[0];
        if (firstId) switchToSession(firstId);
      }
    }
  });

document.getElementById('new-session-btn')!.addEventListener('click', createNewSession);
  document.getElementById('rename-session-btn')!.addEventListener('click', () => {
    if (!activeSessionId) return;
    const nameSpan = document.querySelector(`#session-list li.active .session-name`) as HTMLSpanElement | null;
    if (nameSpan) startRename(activeSessionId, nameSpan);
  });
  window.api.onNewSession(createNewSession);
  window.api.onSwitchSession((sessionId: string) => {
    if (sessions.has(sessionId)) switchToSession(sessionId);
  });

  window.api.onOutput((sessionId: string, data: string) => {
    paneManager.routeOutput(sessionId, data);
  });

  window.api.onStateChange((sessionId: string, state: SessionStatus) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = state;
      renderSidebar();
    }
  });

  window.api.onExit((sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = 'done';
      renderSidebar();
    }
  });

  window.api.onSplitSession((direction: SplitDirection) => {
    const paneId = paneManager.getFocusedPaneId();
    if (paneId) splitNewSession(paneId, direction);
  });

  window.api.onNavSession((direction: 'next' | 'prev') => {
    const ids = getVisibleSessionOrder();
    if (ids.length < 2) return;
    const currentIndex = ids.indexOf(activeSessionId!);
    const next = direction === 'next'
      ? (currentIndex + 1) % ids.length
      : (currentIndex - 1 + ids.length) % ids.length;
    switchToSession(ids[next]);
  });

  function switchToSession(sessionId: string): void {
    terminalPanel.classList.add('visible');
    emptyState.style.display = 'none';
    // PaneManager focuses (or opens) the pane and fires onFocusChange, which
    // updates activeSessionId, the active-session IPC, and the sidebar.
    paneManager.showSession(sessionId);
  }

  async function splitNewSession(paneId: string, direction: SplitDirection): Promise<void> {
    const session = await window.api.createSession();
    if (!session) return;
    sessions.set(session.id, session);
    sidebarOrder.push({ type: 'session', id: session.id });
    terminalPanel.classList.add('visible');
    emptyState.style.display = 'none';
    paneManager.splitPane(paneId, direction, session.id, false);
    renderSidebar();
    scheduleSave();
  }

  function startRenameInput(
    nameSpan: HTMLSpanElement,
    currentName: string,
    onCommit: (newName: string) => void,
  ): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = currentName;

    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) onCommit(newName);
      renderSidebar();
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); renderSidebar(); }
    });
    input.addEventListener('blur', commit);

    nameSpan.textContent = '';
    nameSpan.appendChild(input);
    input.focus();
    input.select();
  }

  function startRename(sessionId: string, nameSpan: HTMLSpanElement): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    startRenameInput(nameSpan, session.name, (newName) => {
      session.name = newName;
      paneManager.updateHeaders();
      scheduleSave();
    });
  }

  function startGroupRename(group: SessionGroup, nameSpan: HTMLSpanElement): void {
    startRenameInput(nameSpan, group.name, (newName) => {
      group.name = newName;
      scheduleSave();
    });
  }

  function showCorrectionDropdown(dot: HTMLElement, sessionId: string, currentStatus: SessionStatus): void {
    document.querySelector('.correction-dropdown')?.remove();

    const allStates: SessionStatus[] = ['idle', 'working', 'needs-input', 'done'];
    const options = allStates.filter(s => s !== currentStatus);

    const dropdown = document.createElement('div');
    dropdown.className = 'correction-dropdown';

    const label = document.createElement('div');
    label.className = 'correction-label';
    label.textContent = `Showing: ${currentStatus}`;
    dropdown.appendChild(label);

    for (const state of options) {
      const btn = document.createElement('button');
      btn.className = `correction-option ${state}`;
      btn.textContent = state;
      btn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        window.api.correctState(sessionId, state);
        const session = sessions.get(sessionId);
        if (session) session.status = state;
        dropdown.remove();
        renderSidebar();
      });
      dropdown.appendChild(btn);
    }

    const rect = dot.getBoundingClientRect();
    dropdown.style.left = `${rect.right + 8}px`;
    dropdown.style.top = `${rect.top - 4}px`;
    document.body.appendChild(dropdown);

    const close = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // --- Drag-and-drop helpers ---

  function clearDropIndicators(): void {
    const list = document.getElementById('session-list')!;
    list.querySelectorAll('.drop-target-merge, .drop-target-above, .drop-target-below').forEach(el => {
      el.classList.remove('drop-target-merge', 'drop-target-above', 'drop-target-below');
    });
  }

  function getDropZone(e: DragEvent, el: HTMLElement): 'above' | 'below' | 'merge' {
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const ratio = y / rect.height;
    if (ratio < 0.25) return 'above';
    if (ratio > 0.75) return 'below';
    return 'merge';
  }

  function handleDrop(draggedId: string, targetId: string, zone: 'above' | 'below' | 'merge', targetIsGroup: boolean): void {
    if (draggedId === targetId) return;

    if (zone === 'merge') {
      if (targetIsGroup) {
        // Drop onto group header — add to group
        const group = groups.get(targetId);
        if (!group) return;
        if (group.sessionIds.includes(draggedId)) return;
        removeSidebarEntry(draggedId);
        enforceGroupIntegrity();
        group.sessionIds.push(draggedId);
      } else {
        // Merge two sessions (or add to target's group)
        const targetGroup = getGroupForSession(targetId);
        if (targetGroup) {
          if (targetGroup.sessionIds.includes(draggedId)) return;
          removeSidebarEntry(draggedId);
          enforceGroupIntegrity();
          targetGroup.sessionIds.push(draggedId);
        } else {
          // Create new group — remove dragged from old location first
          removeSidebarEntry(draggedId);
          enforceGroupIntegrity();

          groupCounter++;
          const newGroup: SessionGroup = {
            id: `group-${groupCounter}`,
            name: `Group ${groupCounter}`,
            sessionIds: [targetId, draggedId],
            collapsed: false,
          };
          groups.set(newGroup.id, newGroup);

          // Replace target's sidebarOrder entry with the group
          const targetIdx = sidebarOrder.findIndex(e => e.type === 'session' && e.id === targetId);
          if (targetIdx !== -1) {
            sidebarOrder[targetIdx] = { type: 'group', id: newGroup.id };
          }
        }
      }
    } else {
      // Reorder (above/below)
      removeSidebarEntry(draggedId);
      enforceGroupIntegrity();

      if (targetIsGroup) {
        const idx = sidebarOrder.findIndex(e => e.type === 'group' && e.id === targetId);
        if (idx !== -1) {
          const insertIdx = zone === 'above' ? idx : idx + 1;
          sidebarOrder.splice(insertIdx, 0, { type: 'session', id: draggedId });
        }
      } else {
        // Find target in sidebarOrder (could be standalone or inside a group)
        const targetGroup = getGroupForSession(targetId);
        if (targetGroup) {
          // Insert into group at target position
          const tIdx = targetGroup.sessionIds.indexOf(targetId);
          const insertIdx = zone === 'above' ? tIdx : tIdx + 1;
          targetGroup.sessionIds.splice(insertIdx, 0, draggedId);
        } else {
          const idx = sidebarOrder.findIndex(e => e.type === 'session' && e.id === targetId);
          if (idx !== -1) {
            const insertIdx = zone === 'above' ? idx : idx + 1;
            sidebarOrder.splice(insertIdx, 0, { type: 'session', id: draggedId });
          }
        }
      }
    }

    enforceGroupIntegrity();
    renderSidebar();
    scheduleSave();
  }

  // --- Session <li> creation ---

  function createSessionLi(id: string, session: SessionInfo, indented: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = (id === activeSessionId ? 'active' : '') + (indented ? ' grouped-session' : '');
    li.setAttribute('draggable', 'true');
    li.dataset.sessionId = id;
    li.innerHTML = `
      <span class="status-dot ${session.status}"></span>
      <span class="session-name" title="${session.cwd}">${session.name}</span>
      <button class="session-close" title="Close session">&times;</button>
    `;

    const statusDot = li.querySelector('.status-dot') as HTMLElement;
    statusDot.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      showCorrectionDropdown(e.target as HTMLElement, id, session.status);
    });

    li.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('session-close')) return;
      if ((e.target as HTMLElement).classList.contains('session-rename-input')) return;
      if ((e.target as HTMLElement).classList.contains('status-dot')) return;
      switchToSession(id);
    });

    li.querySelector('.session-close')!.addEventListener('click', async () => {
      await window.api.killSession(id);
      sessions.delete(id);
      removeSidebarEntry(id);
      enforceGroupIntegrity();

      // Remove the killed session from any pane (collapses its split).
      paneManager.removeSession(id);

      if (paneManager.isEmpty()) {
        activeSessionId = null;
        terminalPanel.classList.remove('visible');
        emptyState.style.display = '';
        // Open another session in the freed space if any remain.
        const remaining = getVisibleSessionOrder();
        if (remaining.length > 0) switchToSession(remaining[0]);
      }

      renderSidebar();
      scheduleSave();
    });

    // Drag events
    li.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer!.setData('text/plain', id);
      e.dataTransfer!.setData('application/x-session-id', id);
      e.dataTransfer!.effectAllowed = 'move';
      dragInProgress = true;
      li.classList.add('dragging');
    });

    li.addEventListener('dragend', () => {
      dragInProgress = false;
      li.classList.remove('dragging');
      clearDropIndicators();
      renderSidebar();
    });

    li.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      const zone = getDropZone(e, li);
      if (zone === 'merge') li.classList.add('drop-target-merge');
      else if (zone === 'above') li.classList.add('drop-target-above');
      else li.classList.add('drop-target-below');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-target-merge', 'drop-target-above', 'drop-target-below');
    });

    li.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      const draggedId = e.dataTransfer!.getData('text/plain');
      if (!draggedId || !sessions.has(draggedId)) return;
      const zone = getDropZone(e, li);
      handleDrop(draggedId, id, zone, false);
    });

    return li;
  }

  // --- Render ---

  function renderSidebar(): void {
    if (dragInProgress) return;

    const renameBtn = document.getElementById('rename-session-btn')!;
    renameBtn.style.display = activeSessionId ? 'inline-block' : 'none';

    const list = document.getElementById('session-list')!;
    list.innerHTML = '';

    for (const entry of sidebarOrder) {
      if (entry.type === 'session') {
        const session = sessions.get(entry.id);
        if (!session) continue;
        list.appendChild(createSessionLi(entry.id, session, false));
      } else {
        const group = groups.get(entry.id);
        if (!group) continue;

        // Group header
        const header = document.createElement('li');
        header.className = 'session-group-header';
        header.dataset.groupId = group.id;
        header.innerHTML = `
          <span class="group-collapse-icon">${group.collapsed ? '▸' : '▾'}</span>
          <span class="group-name">${group.name}</span>
          <button class="group-rename-btn" title="Rename group">✎</button>
          <span class="group-count">${group.sessionIds.length}</span>
        `;

        (header.querySelector('.group-rename-btn') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          const nameSpan = header.querySelector('.group-name') as HTMLSpanElement;
          startGroupRename(group, nameSpan);
        });

        header.addEventListener('click', (e: MouseEvent) => {
          if ((e.target as HTMLElement).classList.contains('group-rename-btn')) return;
          if ((e.target as HTMLElement).classList.contains('session-rename-input')) return;
          group.collapsed = !group.collapsed;
          renderSidebar();
          scheduleSave();
        });

        // Group header drag events (accept drops)
        header.addEventListener('dragover', (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          clearDropIndicators();
          const zone = getDropZone(e, header);
          if (zone === 'merge') header.classList.add('drop-target-merge');
          else if (zone === 'above') header.classList.add('drop-target-above');
          else header.classList.add('drop-target-below');
        });

        header.addEventListener('dragleave', () => {
          header.classList.remove('drop-target-merge', 'drop-target-above', 'drop-target-below');
        });

        header.addEventListener('drop', (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          clearDropIndicators();
          const draggedId = e.dataTransfer!.getData('text/plain');
          if (!draggedId || !sessions.has(draggedId)) return;
          const zone = getDropZone(e, header);
          handleDrop(draggedId, group.id, zone, true);
        });

        list.appendChild(header);

        // Render children if not collapsed
        if (!group.collapsed) {
          for (const sid of group.sessionIds) {
            const session = sessions.get(sid);
            if (!session) continue;
            list.appendChild(createSessionLi(sid, session, true));
          }
        }
      }
    }

    // List-level drop handler: drop onto empty area to ungroup
    list.ondragover = (e: DragEvent) => {
      // Only handle if not over a child element
      if (e.target === list) {
        e.preventDefault();
      }
    };

    list.ondrop = (e: DragEvent) => {
      if (e.target !== list) return;
      e.preventDefault();
      clearDropIndicators();
      const draggedId = e.dataTransfer!.getData('text/plain');
      if (!draggedId || !sessions.has(draggedId)) return;

      // Remove from group/sidebarOrder and add as standalone at end
      removeSidebarEntry(draggedId);
      enforceGroupIntegrity();
      sidebarOrder.push({ type: 'session', id: draggedId });
      renderSidebar();
      scheduleSave();
    };
  }
});
