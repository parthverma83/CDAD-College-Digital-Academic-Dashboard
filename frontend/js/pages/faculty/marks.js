/* ================= Marks (Section 5) ================= */
async function renderMarksTable() {
  const host = document.getElementById('marksTableBody');
  if (!host) return;
  const students = await getData(CDAD_KEYS.STUDENTS);
  const marks = await allMarks();

  // Section filter: rebuild options, keeping the current selection if it still exists.
  const filter = document.getElementById('marksSectionFilter');
  const sections = [...new Set(students.map((s) => s.section || ''))].sort((a, b) => (a || '￿').localeCompare(b || '￿'));
  const current = filter.value || '__all';
  filter.innerHTML = '<option value="__all">All Sections</option>' +
    sections.map((sec) => `<option value="${escapeHtml(sec)}">${sec ? 'Section ' + escapeHtml(sec) : 'No Section'}</option>`).join('');
  filter.value = [...filter.options].some((o) => o.value === current) ? current : '__all';
  filter.onchange = renderMarksTable;
  const searchEl = document.getElementById('marksSearch');
  if (!searchEl.dataset.wired) {
    searchEl.dataset.wired = '1';
    searchEl.addEventListener('input', renderMarksTable);
  }
  const query = searchEl.value.trim().toLowerCase();

  const studentRow = (s) => {
    const m = marks.find((x) => x.studentId === s.displayId);
    const t = m ? deriveMarkTotals(m) : null;
    return `
      <tr>
        <td><div class="row-name__text"><strong>${escapeHtml(s.name)}</strong><span class="mono">${escapeHtml(s.displayId)}</span></div></td>
        ${CA_HEADS.map((h) => `<td>${m && m[h.key] != null
          ? `<strong>${scaledMark(m[h.key], h)}</strong>/${h.scaledTo}<div class="faint" style="font-size:11px;">${m[h.key]}/${CA_OUT_OF} marked</div>`
          : '—'}</td>`).join('')}
        <td>${t ? t.ca + '/' + t.caMax : '—'}</td>
        <td>${t && t.finals != null ? '<strong>' + t.finals + '</strong>/' + t.finalsMax : '—'}</td>
        <td>${t && t.finals != null ? '<strong>' + t.total + '</strong>/' + t.max : '—'}</td>
        <td>${t ? t.percentage + '%' : '—'}</td>
        <td>${t ? `<span class="badge badge--info" title="Grade point ${t.gradePoint} — ${escapeHtml(t.gradeText)}">${t.grade}</span>` : '—'}</td>
        <td class="table-actions">
          ${m ? `<button class="btn btn--ghost btn--sm" data-release-marks="${m.id}" aria-label="${m.released ? 'Withdraw marks' : 'Release marks'}" data-released="${m.released ? 1 : 0}" title="${m.released ? 'Released — click to withdraw' : 'Hidden from student — click to release'}">${icon(m.released ? 'lock-open' : 'lock')}</button>` : ''}
          <button class="btn btn--ghost btn--sm" data-edit-marks="${s.displayId}">${icon('pencil')} Edit</button>
          ${m ? `<button class="btn btn--ghost btn--sm" data-reset-marks="${m.id}">${icon('rotate-ccw')} Reset</button><button class="btn btn--danger btn--sm" data-del-marks="${m.id}">${icon('trash-2')} Delete</button>` : ''}
        </td>
      </tr>`;
  };

  const matches = (s) => !query || s.displayId.toLowerCase().includes(query);
  const shown = sections.filter((sec) => (filter.value === '__all' || sec === filter.value) && students.some((s) => (s.section || '') === sec && matches(s)));
  host.innerHTML = !shown.length && query ? `<tr class="empty-row"><td colspan="11">No student matches "${escapeHtml(searchEl.value.trim())}".</td></tr>` : students.length ? shown.map((sec) => {
    const rows = students.filter((s) => (s.section || '') === sec && matches(s));
    const withMarks = rows.map((s) => marks.find((x) => x.studentId === s.displayId)).filter(Boolean);
    const avg = withMarks.length ? Math.round(withMarks.reduce((a, m) => a + deriveMarkTotals(m).percentage, 0) / withMarks.length * 100) / 100 : null;
    return `<tr class="section-row"><td colspan="11"><strong>${sec ? 'Section ' + escapeHtml(sec) : 'No Section'}</strong>
      <span class="faint"> · ${rows.length} student${rows.length === 1 ? '' : 's'}${avg !== null ? ' · avg ' + avg + '%' : ''}</span></td></tr>` + rows.map(studentRow).join('');
  }).join('') : `<tr class="empty-row"><td colspan="11">No students yet.</td></tr>`;

  host.querySelectorAll('[data-release-marks]').forEach((b) => b.addEventListener('click', async () => {
    const next = b.dataset.released !== '1';
    await setMarksReleased(b.dataset.releaseMarks, next);
    showToast(next ? 'Marks released to student' : 'Marks hidden from student', 'info');
    await renderMarksTable();
  }));
  host.querySelectorAll('[data-edit-marks]').forEach((b) => b.addEventListener('click', () => openMarksModal(b.dataset.editMarks)));
  host.querySelectorAll('[data-reset-marks]').forEach((b) => b.addEventListener('click', () => {
    confirmDelete('Clear all four assessment marks for this student?', async () => { await resetMarks(b.dataset.resetMarks); showToast('Marks reset', 'info'); await renderAll(); });
  }));
  host.querySelectorAll('[data-del-marks]').forEach((b) => b.addEventListener('click', () => {
    confirmDelete("Delete this student's marks record?", async () => { await deleteMarks(b.dataset.delMarks); showToast('Marks deleted', 'success'); await renderAll(); });
  }));
}

/* Download the marks currently listed (section filter + search) as CSV, with each student's name. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  // Text starting with = + - @ would run as a formula in Excel: a leading ' keeps it as text.
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportMarksCsv() {
  const btn = document.getElementById('exportMarksBtn');
  btn.disabled = true;
  try {
    const [students, marks] = await Promise.all([getData(CDAD_KEYS.STUDENTS), allMarks()]);
    const section = document.getElementById('marksSectionFilter').value || '__all';
    const query = document.getElementById('marksSearch').value.trim().toLowerCase();
    const listed = students
      .filter((s) => (section === '__all' || (s.section || '') === section) && (!query || s.displayId.toLowerCase().includes(query)))
      .sort((a, b) => (a.section || '￿').localeCompare(b.section || '￿') || a.displayId.localeCompare(b.displayId));
    if (!listed.length) { showToast('There are no students to download.', 'info'); return; }

    const byStudent = new Map(marks.map((m) => [m.studentId, m]));
    const header = ['Enrollment No.', 'Name', 'Section', 'Group',
      ...CA_HEADS.flatMap((h) => [`${h.short} (out of ${CA_OUT_OF})`, `${h.short} (scaled to ${h.scaledTo})`]),
      `CA Total (out of ${CA_TOTAL})`, `Finals (out of ${FINALS_OUT_OF})`, 'Overall', 'Overall Out Of', 'Percentage', 'Grade', 'Released to Student'];
    const rows = listed.map((s) => {
      const m = byStudent.get(s.displayId);
      const who = [s.displayId, s.name, s.section || '', s.group || ''];
      if (!m) return [...who, ...Array(header.length - who.length).fill('')]; // no marks entered
      const t = deriveMarkTotals(m);
      return [...who, ...CA_HEADS.flatMap((h) => [m[h.key], scaledMark(m[h.key], h)]),
        t.ca, t.finals, t.total, t.max, t.percentage, t.grade, m.released ? 'Yes' : 'No'];
    });

    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const part = section === '__all' ? 'all-sections' : section || 'no-section';
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // The BOM makes Excel read names in any language correctly.
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `marks-${part.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'section'}-${day}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const withMarks = rows.filter((r) => r[r.length - 1] !== '').length;
    showToast(`Downloaded ${rows.length} student${rows.length === 1 ? '' : 's'} (${withMarks} with marks)`, 'success');
  } catch {
    showToast('Could not download the marks', 'error');
  } finally {
    btn.disabled = false;
  }
}

function confirmReleaseAllMarks() {
  openModal('Release All Marks', `
    <p class="confirm-text">Release marks for all students? Every student with a marks record will be able to see their own marks and their group's marks.</p>
    <p class="faint" style="font-size:12.5px;">You can hide individual students again with the lock icon in the table.</p>
    <div class="form-actions">
      <button class="btn btn--ghost" id="relCancelBtn" type="button">Cancel</button>
      <button class="btn btn--primary" id="relOkBtn" type="button">${icon('megaphone')} Release All</button>
    </div>
  `, {
    onMount: () => {
      document.getElementById('relCancelBtn').addEventListener('click', closeModal);
      document.getElementById('relOkBtn').addEventListener('click', async () => {
        closeModal();
        const r = await releaseAllMarks(true);
        if (r) showToast(`Marks released for ${r.updated} student${r.updated === 1 ? '' : 's'}`, 'success');
        else showToast('Could not release marks', 'error');
        await renderAll();
      });
    }
  });
}

/* Release only for students who have completed their tasks. The list updates as tasks are ticked;
   nothing is released until the button is pressed. [key, label, ticked by default] */
const COMPLETION_TASKS = [
  ['TA1', 'TA1 submitted', true], ['TA2', 'TA2 submitted', true], ['EndSem', 'End Sem submitted', true],
  ['projectSubmitted', 'Project submitted', false], ['projectApproved', 'Project approved', true],
  ['ca', 'All four CA marks entered', true], ['finals', 'Finals marks entered', false]
];

function openReleaseCompletedModal() {
  const pageFilter = document.getElementById('marksSectionFilter');
  openModal('Release Marks — Completed Students', `
    <p class="confirm-text">Marks are released only to students who have completed <strong>every</strong> task ticked below. Exam and project work counts for the whole group.</p>
    <form id="releaseCompletedForm">
      <div class="checkbox-grid">
        ${COMPLETION_TASKS.map(([key, label, on]) => `<label class="checkbox-row"><input type="checkbox" name="task" value="${key}" ${on ? 'checked' : ''}> ${label}</label>`).join('')}
      </div>
      <div class="field" style="margin-top:14px;"><label>Section</label><select name="section">${pageFilter.innerHTML}</select></div>
      <div id="releaseCompletedPreview" role="status" style="margin-top:14px; min-height:60px;"></div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cancelReleaseCompleted">Cancel</button>
        <button type="submit" class="btn btn--primary" id="releaseCompletedSubmit" disabled>${icon('circle-check')} Release</button>
      </div>
    </form>`, {
    onMount: () => {
      const form = document.getElementById('releaseCompletedForm');
      const panel = document.getElementById('releaseCompletedPreview');
      const submit = document.getElementById('releaseCompletedSubmit');
      form.section.value = pageFilter.value;
      const choice = () => ({
        require: [...form.querySelectorAll('input[name="task"]:checked')].map((c) => c.value),
        section: form.section.value === '__all' ? undefined : form.section.value
      });
      const list = (rows, text) => rows.slice(0, 200).map((s) => `<div style="font-size:12.5px; padding:3px 0;"><strong>${escapeHtml(s.name)}</strong> <span class="mono faint">${escapeHtml(s.studentId)}</span>${text ? `<div class="faint">${escapeHtml(text(s))}</div>` : ''}</div>`).join('');
      let turn = 0; // ignore answers that arrive after a newer choice was made
      const refresh = async () => {
        const mine = ++turn;
        submit.disabled = true;
        submit.innerHTML = `${icon('circle-check')} Release`;
        const c = choice();
        if (!c.require.length) { panel.innerHTML = '<span class="faint">Tick at least one task.</span>'; return; }
        panel.innerHTML = '<span class="faint">Checking…</span>';
        const r = await releaseCompletedMarks({ ...c, preview: true });
        if (mine !== turn || !panel.isConnected) return;
        if (r.error) { panel.innerHTML = `<span style="color:var(--red);">${escapeHtml(r.error)}</span>`; return; }
        const n = r.toRelease.length;
        submit.disabled = !n;
        submit.innerHTML = `${icon('circle-check')} Release${n ? ` for ${n} student${n === 1 ? '' : 's'}` : ''}`;
        panel.innerHTML = `
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
            <span class="badge badge--good">${n} ready to release</span>
            <span class="badge badge--muted">${r.alreadyReleased} already released</span>
            <span class="badge badge--warn">${r.incomplete.length} incomplete</span>
          </div>
          ${n ? `<details open><summary>Ready to release</summary>${list(r.toRelease)}</details>` : '<p class="faint">No one new has completed all of these tasks.</p>'}
          ${r.incomplete.length ? `<details><summary>Incomplete — what is missing</summary>${list(r.incomplete, (s) => s.missing.join(', '))}</details>` : ''}`;
      };
      form.addEventListener('change', refresh);
      document.getElementById('cancelReleaseCompleted').addEventListener('click', closeModal);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        turn++;
        const r = await releaseCompletedMarks(choice());
        if (r.error) { showToast(r.error, 'error'); submit.disabled = false; return; }
        closeModal();
        showToast(`Marks released for ${r.released} student${r.released === 1 ? '' : 's'}`, 'success');
        await renderAll();
      });
      refresh();
    }
  });
}

/** One box per Continuous Assessment head, each marked out of 20 (scaled down in the total). */
function caInputsHtml(values, placeholder) {
  return CA_HEADS.map((h) => `
        <div class="field">
          <label>${h.label} <span class="faint">(out of ${CA_OUT_OF}, scaled to ${h.scaledTo})</span></label>
          <input type="number" name="${h.key}" min="0" max="${CA_OUT_OF}" step="any" value="${values && values[h.key] != null ? values[h.key] : ''}" placeholder="${placeholder}">
          <div class="field-hint">${escapeHtml(h.detail)}</div>
        </div>`).join('');
}

async function openGroupMarksModal() {
  const groups = await getData(CDAD_KEYS.GROUPS);
  const withMembers = groups.filter((g) => (g.members || []).length);
  if (!withMembers.length) return showToast('No groups with members yet', 'info');
  openModal('Add Group Marks', `
    <form id="groupMarksForm">
      <div class="form-grid">
        <div class="field full"><label>Group</label>
          <select name="group" required>
            ${withMembers.map((g) => `<option value="${g.displayId}">${g.displayId} — ${escapeHtml(g.name)} (${g.members.length} members)</option>`).join('')}
          </select>
        </div>
        ${caInputsHtml(null, 'leave blank to skip')}
      </div>
      <p class="faint" style="font-size:12.5px;">Applied to every member of the group. Blank fields keep each member's existing mark. For marks that differ per student, open the group's Members window instead, or use Edit on the Marks page.</p>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cancelGroupMarksForm">Cancel</button>
        <button type="submit" class="btn btn--primary">${icon('check')} Apply to Group</button>
      </div>
    </form>
  `, {
    onMount: () => {
      document.getElementById('cancelGroupMarksForm').addEventListener('click', closeModal);
      document.getElementById('groupMarksForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const fields = {};
        CA_HEADS.forEach((h) => { if (fd.get(h.key) !== '') fields[h.key] = Number(fd.get(h.key)); });
        const r = await upsertGroupMarks(fd.get('group'), fields);
        if (!r) { showToast(`Could not apply — each mark must be between 0 and ${CA_OUT_OF}`, 'error'); return; }
        closeModal();
        showToast(`Marks applied to ${r.updated} member${r.updated === 1 ? '' : 's'}`, 'success');
        await renderAll();
      });
    }
  });
}

async function openMarksModal(studentDisplayId) {
  const m = (await marksForStudent(studentDisplayId)) || {};
  openModal(`Edit Marks — ${studentDisplayId}`, `
    <form id="marksForm">
      <div class="form-grid">
        ${caInputsHtml(m, 'not entered')}
        <div class="field full">
          <label>Finals <span class="faint">(out of ${FINALS_OUT_OF}, entered as is)</span></label>
          <input type="number" name="finals" min="0" max="${FINALS_OUT_OF}" step="any" value="${m.finals != null ? m.finals : ''}" placeholder="not entered">
          <div class="field-hint">Final exam, conducted after the Continuous Assessment. Once entered, the overall total is out of ${CA_TOTAL + FINALS_OUT_OF}.</div>
        </div>
      </div>
      <p class="faint" style="font-size:12.5px;">Continuous Assessment is out of ${CA_TOTAL}. Leave a box empty if that assessment isn't marked yet — it is then left out of the total.</p>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cancelMarksForm">Cancel</button>
        <button type="submit" class="btn btn--primary">${icon('save')} Save Marks</button>
      </div>
    </form>
  `, {
    onMount: () => {
      document.getElementById('cancelMarksForm').addEventListener('click', closeModal);
      document.getElementById('marksForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {};
        CA_HEADS.forEach((h) => { body[h.key] = fd.get(h.key).trim() === '' ? null : Number(fd.get(h.key)); }); // blank = not entered
        body.finals = fd.get('finals').trim() === '' ? null : Number(fd.get('finals'));
        const saved = await upsertMarks(studentDisplayId, body);
        if (!saved) { showToast(`Could not save — CA marks must be 0 to ${CA_OUT_OF} and Finals 0 to ${FINALS_OUT_OF}`, 'error'); return; }
        closeModal();
        showToast('Marks saved', 'success');
        await renderAll();
      });
    }
  });
}
