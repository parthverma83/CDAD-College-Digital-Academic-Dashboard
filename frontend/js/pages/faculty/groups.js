/* ================= Groups (Section 2) ================= */
/* Division filter (top right): 'ALL', '__NONE__' (groups without a division) or a division code like CC1. */
let groupDivisionFilter = 'ALL';
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function groupDivisions(groups) {
  return [...new Set(groups.map((g) => g.division).filter(Boolean))].sort(naturalSort);
}

function renderDivisionFilter(groups) {
  const sel = document.getElementById('groupDivisionFilter');
  if (!sel) return;
  const divisions = groupDivisions(groups);
  const noDivision = groups.filter((g) => !g.division).length;
  // The chosen division can disappear (last group deleted or moved) — fall back to All.
  if (groupDivisionFilter === '__NONE__' ? !(noDivision && divisions.length) : groupDivisionFilter !== 'ALL' && !divisions.includes(groupDivisionFilter)) groupDivisionFilter = 'ALL';
  sel.innerHTML = `<option value="ALL">All divisions (${groups.length})</option>`
    + divisions.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)} (${groups.filter((g) => g.division === d).length})</option>`).join('')
    + (noDivision && divisions.length ? `<option value="__NONE__">No division (${noDivision})</option>` : '');
  sel.value = groupDivisionFilter;
  sel.onchange = () => { groupDivisionFilter = sel.value; drawGroups(); };
}

/* Last loaded data, so typing in the search box filters instantly without asking the server again. */
let groupsPageData = { groups: [], names: new Map() };

async function renderGroups() {
  if (!document.getElementById('groupsGrid')) return;
  const [groups, students] = await Promise.all([allGroups(), getData(CDAD_KEYS.STUDENTS)]);
  groupsPageData = { groups, names: new Map(students.map((s) => [s.displayId, s.name])) };
  const search = document.getElementById('groupSearch');
  if (search && !search.dataset.wired) {
    search.dataset.wired = '1';
    search.addEventListener('input', drawGroups);
  }
  drawGroups();
}

/** Every word typed must appear in the group itself (name, ID, division, leader, project) or in one of its members.
    Returns null for no match, else the members that matched (shown on the card so it's clear why it's listed). */
function matchGroup(g, words, names) {
  const person = (id) => `${id} ${names.get(id) || ''}`.toLowerCase();
  const own = [g.name, g.displayId, g.division, g.project, g.teamLeader ? person(g.teamLeader) : ''].join(' ').toLowerCase();
  if (words.every((w) => own.includes(w))) return [];
  const members = (g.members || []).filter((id) => words.every((w) => own.includes(w) || person(id).includes(w)));
  return members.length ? members : null;
}

function drawGroups() {
  const host = document.getElementById('groupsGrid');
  if (!host) return;
  const { groups: allGroupsList, names } = groupsPageData;
  renderDivisionFilter(allGroupsList);
  const inDivision = allGroupsList.filter((g) => groupDivisionFilter === 'ALL' || (groupDivisionFilter === '__NONE__' ? !g.division : g.division === groupDivisionFilter));
  const words = (document.getElementById('groupSearch')?.value || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matched = new Map(inDivision.map((g) => [g.displayId, matchGroup(g, words, names)]));
  const groups = inDivision.filter((g) => matched.get(g.displayId) !== null);
  const countLabel = document.getElementById('groupSearchCount');
  if (countLabel) countLabel.textContent = words.length ? `${groups.length} of ${inDivision.length} groups` : '';
  // "Delete All" removes everything in the selected division, not just search results — so it's hidden while searching.
  const delAllBtn = document.getElementById('deleteAllGroupsBtn');
  if (delAllBtn) {
    delAllBtn.style.display = groups.length && !words.length ? '' : 'none';
    delAllBtn.innerHTML = icon('trash-2') + ' ' + escapeHtml(groupDivisionFilter === 'ALL' ? 'Delete All' : `Delete ${groupDivisionFilter === '__NONE__' ? 'No division' : groupDivisionFilter} (${groups.length})`);
  }
  host.innerHTML = groups.length ? groups.map((g) => `
    <div class="card">
      <div class="card__top">
        <div>
          <div class="card__title">${escapeHtml(g.name)}</div>
          <div class="card__meta mono">${escapeHtml(g.displayId)}${g.division ? ` &middot; <strong>${escapeHtml(g.division)}</strong>` : ''} &middot; Leader: ${escapeHtml(g.teamLeader || '—')}</div>
        </div>
        <span class="badge ${statusBadgeClass(g.status)}">${escapeHtml(g.status)}</span>
      </div>
      <div class="card__meta">${memberCount(g)} member(s) &middot; Project: ${escapeHtml(g.project || '—')}</div>
      ${(matched.get(g.displayId) || []).map((id) => `<div class="card__meta icon-label">${icon('search')} ${escapeHtml(names.get(id) || '')} <span class="mono">${escapeHtml(id)}</span></div>`).join('')}
      <div>
        <div class="card__progress-label"><span>Progress</span><span>${g.progress || 0}%</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${g.progress || 0}%"></div></div>
      </div>
      <div class="card__actions">
        <button class="btn btn--ghost btn--sm" data-edit-group="${g.id}">${icon('pencil')} Edit</button>
        <button class="btn btn--ghost btn--sm" data-view-group="${g.displayId}">${icon('users')} Members</button>
        <button class="btn btn--danger btn--sm" data-del-group="${g.id}">${icon('trash-2')} Delete</button>
      </div>
    </div>`).join('') : emptyState(words.length && inDivision.length ? 'No groups match your search.' : allGroupsList.length ? 'No groups in this division yet.' : 'No groups yet. Add one to get started.');

  host.querySelectorAll('[data-edit-group]').forEach((b) => b.addEventListener('click', () => openEditGroupModal(b.dataset.editGroup)));
  host.querySelectorAll('[data-view-group]').forEach((b) => b.addEventListener('click', () => openGroupMembersModal(b.dataset.viewGroup)));
  host.querySelectorAll('[data-del-group]').forEach((b) => b.addEventListener('click', async () => {
    const g = await findData(CDAD_KEYS.GROUPS, b.dataset.delGroup);
    confirmDelete(`Delete group ${g.name} (${g.displayId})?`, async () => { await deleteGroup(g.id); showToast('Group deleted', 'success'); await renderAll(); });
  }));
}

/* ================= Bulk import groups from CSV =================
   One row per group: Group Name, Leader, Members (enrollment numbers separated by ; or spaces), Status.
   Leader / Members / Status are optional. parseCsv / findColumn live in students.js. */
const GROUP_CSV_TEMPLATE = 'Group Name,Leader,Members,Status,Division\r\nTeam Falcon,ADT24SOCB0001,ADT24SOCB0001; ADT24SOCB0002; ADT24SOCB0003,Active,CC1\r\n';

function downloadGroupsCsvTemplate() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([GROUP_CSV_TEMPLATE], { type: 'text/csv' }));
  a.download = 'groups-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Turns CSV rows into a list of groups to create, plus everything that was skipped and why. */
/** A student roster (one row per student: Enrollment No. + Group Name, no Members column) is turned into
    one row per group, so the same importer handles both layouts. Returns null for a normal groups file. */
function rosterToGroupRows(rows) {
  const headers = rows[0];
  const idCol = findColumn(headers, ['ENROLLMENT NO.', 'ENROLLMENT NO', 'ENROLLMENTNO', 'STUDENT ID']);
  const groupCol = findGroupNameColumn(headers);
  if (idCol === -1 || groupCol === -1 || findColumn(headers, ['MEMBERS', 'MEMBER IDS', 'MEMBER', 'STUDENTS']) !== -1) return null;
  const byGroup = new Map();
  rows.slice(1).forEach((r) => {
    const name = (r[groupCol] || '').trim();
    const id = (r[idCol] || '').trim();
    if (!name || !id) return;
    if (!byGroup.has(name)) byGroup.set(name, []);
    byGroup.get(name).push(id);
  });
  return [['Group Name', 'Leader', 'Members', 'Status', 'Division'],
    ...[...byGroup].map(([name, ids]) => [name, '', ids.join('; '), 'Active', ''])];
}

function planGroupImport(rows, students, groups, defaultDivision = '') {
  rows = rosterToGroupRows(rows) || rows;
  const headers = rows[0];
  const divisionCol = findColumn(headers, ['DIVISION', 'DIV']);
  const nameCol = findGroupNameColumn(headers) !== -1 ? findGroupNameColumn(headers) : findColumn(headers, ['GROUP NAME', 'TEAM NAME', 'NAME', 'GROUP', 'TEAM']);
  const leaderCol = findColumn(headers, ['LEADER', 'TEAM LEADER', 'LEADER ID', 'TEAM LEADER ID']);
  const membersCol = findColumn(headers, ['MEMBERS', 'MEMBER IDS', 'MEMBER', 'STUDENTS']);
  const statusCol = findColumn(headers, ['STATUS']);
  if (nameCol === -1) return { error: 'Couldn\'t find a "Group Name" column in the header row. Download the template to see the expected format.' };

  const byId = new Map(students.map((s) => [s.displayId.toLowerCase(), s]));
  const takenIds = new Set(students.filter((s) => s.group).map((s) => s.displayId.toLowerCase())); // already in a group
  // A group name only has to be unique within its division (CC1 and CC2 can both have a "Team Falcon").
  const nameKey = (division, name) => `${division.toLowerCase()}|${name.toLowerCase()}`;
  const seenNames = new Set(groups.map((g) => nameKey(g.division || '', g.name.trim())));
  const plans = [], invalid = [], duplicateNames = [], unknown = new Set(), alreadyGrouped = new Set();
  const statuses = ['Active', 'Inactive', 'Completed'];

  rows.slice(1).forEach((r, idx) => {
    const name = (r[nameCol] || '').trim();
    if (!name) { invalid.push(idx + 2); return; } // header is line 1
    const division = ((divisionCol !== -1 ? (r[divisionCol] || '').trim() : '') || defaultDivision || divisionFromGroupName(name)).trim().toUpperCase();
    if (seenNames.has(nameKey(division, name))) { duplicateNames.push(division ? `${name} (${division})` : name); return; }
    seenNames.add(nameKey(division, name));

    const leaderRaw = leaderCol !== -1 ? (r[leaderCol] || '').trim() : '';
    const wanted = [...(leaderRaw ? [leaderRaw] : []), ...(membersCol !== -1 ? (r[membersCol] || '').split(/[;|,\s]+/) : [])]
      .map((x) => x.trim()).filter(Boolean)
      .filter((x, i, arr) => arr.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i); // leader is usually also listed in Members
    const members = [];
    wanted.forEach((id) => {
      const key = id.toLowerCase();
      const student = byId.get(key);
      if (!student) { unknown.add(id); return; }
      if (takenIds.has(key)) { alreadyGrouped.add(student.displayId); return; }
      takenIds.add(key);
      members.push(student.displayId);
    });
    const leader = leaderRaw && byId.get(leaderRaw.toLowerCase()) && members.includes(byId.get(leaderRaw.toLowerCase()).displayId)
      ? byId.get(leaderRaw.toLowerCase()).displayId : '';
    const statusRaw = statusCol !== -1 ? (r[statusCol] || '').trim().toLowerCase() : '';
    const status = statuses.find((s) => s.toLowerCase() === statusRaw) || 'Active';
    plans.push({ name, teamLeader: leader, members, status, division });
  });
  return { plans, invalid, duplicateNames, unknown: [...unknown], alreadyGrouped: [...alreadyGrouped], totalRows: rows.length - 1 };
}

function openImportGroupsModal() {
  const list = (items, max = 8) => items.slice(0, max).map(escapeHtml).join(', ') + (items.length > max ? ', …' : '');
  openModal('Import Groups from CSV', `
    <p class="field-hint" style="margin-bottom:10px;">Upload a CSV with one row per group. Columns: <strong>Group Name</strong> (required), <strong>Leader</strong>, <strong>Members</strong> (enrollment numbers separated by ; or spaces), <strong>Status</strong> and <strong>Division</strong> (e.g. CC1) — the last four are optional. A student roster with Enrollment No. and Group Name columns also works (the students must already exist; to add missing students too, use Students → Import CSV). If Division is blank it is read from the group name (CC1-G1 → CC1). A group is skipped if its name already exists in the same division, and a student who is already in a group is not moved.</p>
    <p style="margin-bottom:14px;"><button type="button" class="btn btn--ghost btn--sm" id="groupsTemplateBtn">${icon('download')} Download template</button></p>
    <div class="field full" style="margin-bottom:14px;">
      <label>Division for imported groups</label>
      <input id="groupsImportDivision" list="groupsImportDivList" placeholder="e.g. CC1 (used for rows with no Division column value)" autocomplete="off" value="${groupDivisionFilter !== 'ALL' && groupDivisionFilter !== '__NONE__' ? escapeHtml(groupDivisionFilter) : ''}">
      <datalist id="groupsImportDivList"></datalist>
    </div>
    <div class="field full" style="margin-bottom:14px;">
      <label>CSV File</label>
      <input type="file" id="groupsCsvInput" accept=".csv,text/csv">
    </div>
    <div id="groupsImportPreview" style="margin-bottom:14px;"></div>
    <div class="form-actions">
      <button type="button" class="btn btn--ghost" id="cancelGroupsImport">Cancel</button>
      <button type="button" class="btn btn--primary" id="confirmGroupsImport" disabled>${icon('upload')} Import Groups</button>
    </div>
  `, {
    onMount: () => {
      let plans = [];
      const preview = document.getElementById('groupsImportPreview');
      const confirmBtn = document.getElementById('confirmGroupsImport');
      document.getElementById('cancelGroupsImport').addEventListener('click', closeModal);
      document.getElementById('groupsTemplateBtn').addEventListener('click', downloadGroupsCsvTemplate);
      const divInput = document.getElementById('groupsImportDivision');
      getData(CDAD_KEYS.GROUPS).then((all) => {
        document.getElementById('groupsImportDivList').innerHTML = groupDivisions(all).map((d) => `<option value="${escapeHtml(d)}">`).join('');
      });
      // Changing the division after choosing a file re-runs the preview, since duplicate names are checked per division.
      divInput.addEventListener('input', () => {
        const fi = document.getElementById('groupsCsvInput');
        if (fi.files[0]) fi.dispatchEvent(new Event('change'));
      });

      document.getElementById('groupsCsvInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (evt) => {
          confirmBtn.disabled = true;
          plans = [];
          const rows = parseCsv(String(evt.target.result).replace(/^﻿/, ''));
          if (rows.length < 2) { preview.innerHTML = '<div class="login-error show" style="display:block;">No data rows found in this file.</div>'; return; }
          const [students, groups] = await Promise.all([getData(CDAD_KEYS.STUDENTS), getData(CDAD_KEYS.GROUPS)]);
          const result = planGroupImport(rows, students, groups, divInput.value);
          if (result.error) { preview.innerHTML = `<div class="login-error show" style="display:block;">${escapeHtml(result.error)}</div>`; return; }
          plans = result.plans;
          preview.innerHTML = `
            <div class="list-item">
              <div class="list-item__body"><strong>${result.totalRows}</strong> data row(s) found in the file.</div>
              <div class="list-item__body"><strong>${plans.length}</strong> group(s) will be created.</div>
              ${plans.slice(0, 6).map((p) => `<div class="list-item__body faint">${escapeHtml(p.name)} — ${p.members.length} member(s)${p.teamLeader ? ', leader ' + escapeHtml(p.teamLeader) : ''}</div>`).join('')}
              ${plans.length > 6 ? `<div class="list-item__body faint">…and ${plans.length - 6} more</div>` : ''}
              ${result.invalid.length ? `<div class="list-item__body" style="color:var(--red);">${result.invalid.length} row(s) skipped — missing group name (line ${result.invalid.slice(0, 8).join(', ')}).</div>` : ''}
              ${result.duplicateNames.length ? `<div class="list-item__body" style="color:var(--orange);">${result.duplicateNames.length} group(s) skipped — name already exists in that division (${list(result.duplicateNames)}).</div>` : ''}
              ${result.unknown.length ? `<div class="list-item__body" style="color:var(--orange);">${result.unknown.length} ID(s) not found as students and left out: ${list(result.unknown)}.</div>` : ''}
              ${result.alreadyGrouped.length ? `<div class="list-item__body" style="color:var(--orange);">${result.alreadyGrouped.length} student(s) already in another group and left out: ${list(result.alreadyGrouped)}.</div>` : ''}
            </div>`;
          confirmBtn.disabled = plans.length === 0;
        };
        reader.readAsText(file);
      });

      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        let created = 0;
        for (const p of plans) { if (await createGroup(p)) created++; }
        closeModal();
        showToast(`Imported ${created} group(s)`, created ? 'success' : 'error');
        await renderAll();
      });
    }
  });
}

/** Deletes every group, or only the division currently selected in the top-right switcher. */
async function confirmDeleteAllGroups() {
  const filter = groupDivisionFilter;
  const all = await allGroups();
  const scope = all.filter((g) => filter === 'ALL' || (filter === '__NONE__' ? !g.division : g.division === filter));
  if (scope.length === 0) { showToast('There are no groups to delete.', 'info'); return; }
  const what = filter === 'ALL' ? `all ${scope.length} group(s)`
    : filter === '__NONE__' ? `the ${scope.length} group(s) with no division`
    : `all ${scope.length} group(s) in division ${escapeHtml(filter)}`;
  confirmDelete(`Delete ${what}? Their exam submissions, join requests and group notifications are removed too. Students stay but become ungrouped, and projects and presentations stay but lose their group.`, async () => {
    const url = '/api/groups' + (filter === 'ALL' ? '' : `?division=${encodeURIComponent(filter)}`);
    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) { showToast('Could not delete the groups', 'error'); return; }
    const { deleted } = await res.json();
    showToast(`Deleted ${deleted} group(s)`, 'success');
    await renderAll();
  });
}

function openAddGroupModal() { groupFormModal('Add Group', null); }
async function openEditGroupModal(id) { groupFormModal('Edit Group', await findData(CDAD_KEYS.GROUPS, id)); }

function groupFormModal(title, group) {
  Promise.all([getData(CDAD_KEYS.STUDENTS), getData(CDAD_KEYS.PROJECTS), getData(CDAD_KEYS.GROUPS)]).then(([students, projects, allGroupRows]) => {
    // New groups start in the division currently being viewed.
    const defaultDivision = group ? (group.division || '') : (groupDivisionFilter !== 'ALL' && groupDivisionFilter !== '__NONE__' ? groupDivisionFilter : '');
    openModal(title, `
      <form id="groupForm">
        <div class="form-grid">
          <div class="field full"><label>Group Name</label><input name="name" required value="${escapeHtml(group?.name || '')}"></div>
          <div class="field full">
            <label>Division</label>
            <input name="division" list="groupDivisionList" placeholder="e.g. CC1" autocomplete="off" value="${escapeHtml(defaultDivision)}">
            <datalist id="groupDivisionList">${groupDivisions(allGroupRows).map((d) => `<option value="${escapeHtml(d)}">`).join('')}</datalist>
          </div>
          <div class="field">
            <label>Team Leader</label>
            <select name="teamLeader" id="groupLeaderSelect"></select>
          </div>
          <div class="field">
            <label>Status</label>
            <select name="status"><option ${group?.status==='Active'?'selected':''}>Active</option><option ${group?.status==='Inactive'?'selected':''}>Inactive</option><option ${group?.status==='Completed'?'selected':''}>Completed</option></select>
          </div>
          <div class="field full">
            <label>Assigned Project</label>
            <select name="project">
              <option value="">— None —</option>
              ${projects.map((p) => `<option value="${p.displayId}" ${group?.project===p.displayId?'selected':''}>${p.displayId} — ${escapeHtml(p.title)}</option>`).join('')}
            </select>
          </div>
          <div class="field full">
            <label>Members</label>
            <div class="checkbox-grid">
              ${students.map((s) => `
                <label class="checkbox-row">
                  <input type="checkbox" name="members" value="${s.displayId}" ${(group?.members || []).includes(s.displayId)?'checked':''}>
                  ${escapeHtml(s.displayId)} — ${escapeHtml(s.name)}
                </label>`).join('')}
            </div>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" id="cancelGroupForm">Cancel</button>
          <button type="submit" class="btn btn--primary">${icon('save')} Save Changes</button>
        </div>
      </form>
    `, {
      onMount: () => {
        document.getElementById('cancelGroupForm').addEventListener('click', closeModal);

        // The leader must be one of this group's members, so the dropdown only lists the
        // students currently ticked under Members and updates as boxes are (un)checked.
        const form = document.getElementById('groupForm');
        const leaderSelect = document.getElementById('groupLeaderSelect');
        const nameOf = new Map(students.map((s) => [s.displayId, s.name]));
        const refreshLeaderOptions = (preferred) => {
          const memberIds = [...form.querySelectorAll('input[name="members"]:checked')].map((cb) => cb.value);
          const current = preferred !== undefined ? preferred : leaderSelect.value;
          leaderSelect.innerHTML = '<option value="">— None —</option>' + memberIds.map((id) =>
            `<option value="${escapeHtml(id)}">${escapeHtml(id)} — ${escapeHtml(nameOf.get(id) || '')}</option>`).join('');
          leaderSelect.value = memberIds.includes(current) ? current : '';
        };
        refreshLeaderOptions(group?.teamLeader || '');
        form.querySelectorAll('input[name="members"]').forEach((cb) => cb.addEventListener('change', () => refreshLeaderOptions()));

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const members = fd.getAll('members');
          const fields = { name: fd.get('name').trim(), division: fd.get('division').trim(), teamLeader: fd.get('teamLeader'), status: fd.get('status'), members };
          const projectDisplayId = fd.get('project');

          const savedGroup = group ? await editGroup(group.id, fields) : await createGroup(fields);

          const oldProjectDisplayId = group?.project || '';
          if (projectDisplayId !== oldProjectDisplayId) {
            if (projectDisplayId) {
              const targetProj = projects.find((p) => p.displayId === projectDisplayId);
              if (targetProj) await assignProjectToGroup(targetProj.id, savedGroup.displayId);
            } else if (oldProjectDisplayId) {
              const oldProj = projects.find((p) => p.displayId === oldProjectDisplayId);
              if (oldProj) await assignProjectToGroup(oldProj.id, '');
            }
          }

          closeModal();
          showToast('Group saved', 'success');
          await renderAll();
        });
      }
    });
  });
}

async function openGroupMembersModal(displayId) {
  const group = await getGroup(displayId);
  const [students, marks] = await Promise.all([getData(CDAD_KEYS.STUDENTS), allMarks()]);
  const markOf = (id) => marks.find((x) => x.studentId === id) || null;
  const members = group.members || [];
  // One small box per Continuous Assessment head (each out of 20, scaled down in the total) plus the Finals (out of 50, as is).
  const MARK_BOXES = [...CA_HEADS.map((h) => ({ ...h, outOf: CA_OUT_OF, hint: 'scaled to ' + h.scaledTo })), { key: 'finals', label: 'Finals', short: 'Finals', outOf: FINALS_OUT_OF, hint: 'out of ' + FINALS_OUT_OF + ', after the CA' }];
  const headInput = (id, h) => {
    const cur = markOf(id);
    return `<label class="faint" style="display:flex;align-items:center;gap:6px;" title="${escapeHtml(h.label)} — ${h.hint}">${escapeHtml(h.short)}
      <input type="number" min="0" max="${h.outOf}" step="any" data-head="${h.key}" data-student="${escapeHtml(id)}" value="${cur && cur[h.key] != null ? cur[h.key] : ''}" placeholder="—" style="width:70px;padding:6px 8px;">
      <span>/ ${h.outOf}</span></label>`;
  };
  openModal(`${group.name} — Members`, `
    <div class="list-item" style="margin-bottom:14px;"><strong>${memberCount(group)}</strong> member(s) &middot; Leader: ${escapeHtml(group.teamLeader || '—')}</div>
    ${members.length ? `<p class="faint" style="font-size:12.5px;margin:0 0 10px;">Continuous Assessment (out of ${CA_TOTAL}): each head is marked out of ${CA_OUT_OF} and scaled down — ${CA_HEADS.map((h) => `${escapeHtml(h.short)} → ${h.scaledTo}`).join(', ')}. Finals is a separate exam out of ${FINALS_OUT_OF}, entered as is after the CA. Leave a box empty if it isn't marked yet.</p>` : ''}
    ${members.map((m) => {
      const s = students.find((x) => x.displayId === m);
      const cur = markOf(m);
      const t = cur ? deriveMarkTotals(cur) : null;
      return `<div class="list-item"><div class="list-item__top">
        <span>${s ? escapeHtml(s.name) : m} <span class="mono faint">${escapeHtml(m)}</span>${t ? ` <span class="badge badge--info">${t.total}/${t.max}</span>` : ''}</span>
        <button class="btn btn--ghost btn--sm" data-remove-member="${m}">${icon('user-minus')} Remove</button>
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;">${MARK_BOXES.map((h) => headInput(m, h)).join('')}</div></div>`;
    }).join('') || emptyState('No members yet.')}
    ${members.length ? `<div class="form-actions"><button type="button" class="btn btn--primary" id="saveGroupMarks">${icon('save')} Save marks</button></div>` : ''}
  `, {
    onMount: () => {
      const saveBtn = document.getElementById('saveGroupMarks');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const read = (id, key) => document.querySelector(`[data-head="${key}"][data-student="${id}"]`).value.trim();
        // Check every box before saving anything, so one typo doesn't leave the group half-saved.
        for (const id of members) {
          for (const h of MARK_BOXES) {
            const raw = read(id, h.key);
            if (raw !== '' && !(Number(raw) >= 0 && Number(raw) <= h.outOf)) {
              showToast(`${id}: ${h.short} must be between 0 and ${h.outOf} — nothing was saved`, 'error');
              return;
            }
          }
        }
        saveBtn.disabled = true;
        let saved = 0;
        for (const id of members) {
          const cur = markOf(id);
          const body = {};
          MARK_BOXES.forEach((h) => { body[h.key] = read(id, h.key) === '' ? null : Number(read(id, h.key)); });
          const unchanged = MARK_BOXES.every((h) => (cur ? cur[h.key] : null) === body[h.key]);
          if (unchanged) continue; // nothing new for this student
          if (!(await upsertMarks(id, body))) {
            saveBtn.disabled = false;
            showToast(`Could not save marks for ${id}`, 'error');
            return;
          }
          saved++;
        }
        closeModal();
        showToast(saved ? `Marks saved for ${saved} member(s)` : 'No changes to save', saved ? 'success' : 'info');
        await renderAll();
      });
      document.querySelectorAll('[data-remove-member]').forEach((b) => b.addEventListener('click', async () => {
        await removeMember(group.id, b.dataset.removeMember);
        closeModal();
        showToast('Member removed', 'info');
        await renderAll();
      }));
    }
  });
}

