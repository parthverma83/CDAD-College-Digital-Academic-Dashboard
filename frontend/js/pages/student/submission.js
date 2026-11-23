/* ================= Submission tab (dedicated page) ================= */
async function renderSubmissionTab() {
  const host = document.getElementById('submissionTabPanel');
  if (!host) return;
  const group = await getGroup(ME.group);
  const project = group ? await getProject(group.project) : null;

  if (!project) {
    host.innerHTML = emptyState('You need a project before you can submit anything. Check My Project.');
    return;
  }

  // Load everything first, then draw in one go: two refreshes that overlap must not each add their own exam cards.
  const amLeader = group.teamLeader === ME.displayId;
  const examData = await fetchExamSubmissions();
  host.innerHTML = `
    <div id="submissionTabBlock"></div>
    <p class="field-hint" style="margin-top:10px;">You can update your submission any time until it's approved.</p>
    <div id="examSubmissionCards" style="margin-top:28px;"></div>`;
  renderSubmissionBlock(project, 'submissionTabBlock', amLeader);
  renderExamSubmissionCards(document.getElementById('examSubmissionCards'), amLeader, examData);
}

/* TA1 / TA2 / EndSem: one card per exam, team leader submits a link and/or file. */
function renderExamSubmissionCards(host, amLeader, { exams, submissions, deadlines = {} }) {
  host.innerHTML = `
    <div class="section__head" style="margin-bottom:6px;"><h3>Exam Submissions</h3></div>
    <p class="field-hint" style="margin-bottom:14px;">Submit your PPT, document or link for each exam${amLeader ? '' : ' — only your team leader can submit'}. <strong>Submitting your final project above does not submit these.</strong></p>
    <div class="card-grid">
      ${exams.map((exam) => {
        const s = submissions.find((x) => x.exam === exam);
        const dl = deadlines[exam];
        const closed = !!dl && new Date(dl) < new Date();
        return `
          <div class="card">
            <div class="card__top"><div class="card__title">${EXAM_LABELS[exam] || exam}</div>
              <span class="badge ${s ? 'badge--good' : 'badge--warn'}">${s ? 'Submitted' : 'Pending'}</span></div>
            ${s ? `
              ${s.link ? `<div class="card__meta"><a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${icon('external-link')} Link</a></div>` : ''}
              ${s.files.map((f) => `<div class="card__meta"><a href="/api/exam-submissions/files/${f.id}" target="_blank">${escapeHtml(f.name)}</a> <span class="faint">(${formatFileSize(f.size)})</span></div>`).join('')}
              <div class="card__meta faint">by ${escapeHtml(s.submittedBy)} · ${formatDateTime(s.submittedAt)}</div>` : ''}
            ${dl ? `<div class="card__meta" style="${closed ? 'color:var(--red);' : ''}">${closed ? icon('lock') + ' Closed' : icon('alarm-clock') + ' Due'} ${formatDateTime(dl)}</div>` : ''}
            ${amLeader ? (closed
              ? `<div class="card__actions"><button class="btn btn--ghost btn--sm" disabled>${icon('lock')} Submissions closed</button></div>`
              : `<div class="card__actions"><button class="btn btn--ghost btn--sm" data-exam-submit="${exam}">${icon('upload')} ${s ? 'Update' : 'Submit'}</button></div>`) : ''}
          </div>`;
      }).join('')}
    </div>`;
  host.querySelectorAll('[data-exam-submit]').forEach((b) => b.addEventListener('click', () => {
    openExamSubmitModal(b.dataset.examSubmit, submissions.find((x) => x.exam === b.dataset.examSubmit));
  }));
}

function openExamSubmitModal(exam, existing) {
  openModal(`${existing ? 'Update' : 'Submit'} ${EXAM_LABELS[exam] || exam}`, `
    <form id="examSubmitForm">
      <div class="login-error" id="examSubmitError" role="alert"></div>
      <div class="field full" style="margin-bottom:14px;">
        <label>Link (Drive / PPT / repo — optional if attaching a file)</label>
        <input name="link" type="url" placeholder="https://..." value="${escapeHtml(existing?.link || '')}">
      </div>
      <div class="field full" style="margin-bottom:14px;">
        <label for="examFilesInput">Files (up to ${EXAM_MAX_FILES} — PDF, PPT, CSV or DOC, ${EXAM_MAX_UPLOAD < EXAM_MAX_FILE_SIZE ? 'max 4 MB per submit in total' : 'max 10 MB each'})</label>
        <div class="file-list" id="examFileList"></div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <button type="button" class="btn btn--ghost btn--sm" id="examAddFile">${icon('plus')} Add file</button>
          <span class="field-hint" id="examFilesHint" role="status"></span>
        </div>
        <input type="file" id="examFilesInput" multiple hidden accept="${EXAM_FILE_TYPES.join(',')}">
      </div>
      <div class="field full"><label>Note (optional)</label><textarea name="note">${escapeHtml(existing?.note || '')}</textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cancelExamSubmit">Cancel</button>
        <button type="submit" class="btn btn--primary" id="examSubmitBtn">${icon('upload')} ${existing ? 'Update' : 'Submit'}</button>
      </div>
    </form>
  `, {
    onMount: () => {
      const form = document.getElementById('examSubmitForm');
      const input = document.getElementById('examFilesInput');
      const addBtn = document.getElementById('examAddFile');
      const listEl = document.getElementById('examFileList');
      const hint = document.getElementById('examFilesHint');
      const errEl = document.getElementById('examSubmitError');
      const fail = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
      const clearError = () => errEl.classList.remove('show');

      const saved = existing?.files || [];
      const removed = new Set(); // ids of already submitted files to delete on save
      let added = [];            // File objects picked now
      const count = () => saved.length - removed.size + added.length;
      const addedSize = () => added.reduce((n, f) => n + f.size, 0);

      const row = (ic, name, size, tag, action, label) => `
        <div class="file-row">${icon(ic)}<span class="file-row__name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="faint">${formatFileSize(size)}</span><span class="badge ${tag[0]}">${tag[1]}</span>
          <button type="button" class="file-row__remove" ${action} aria-label="${label} ${escapeHtml(name)}" title="${label}">${icon(label === 'Undo remove' ? 'rotate-ccw' : 'x')}</button></div>`;
      const draw = () => {
        listEl.innerHTML = saved.map((f) => removed.has(f.id)
          ? row('file-check', f.name, f.size, ['badge--bad', 'Will be removed'], `data-undo="${f.id}"`, 'Undo remove')
          : row('file-check', f.name, f.size, ['badge--good', 'Submitted'], `data-remove-saved="${f.id}"`, 'Remove')).join('')
          + added.map((f, i) => row('upload', f.name, f.size, ['badge--info', 'New'], `data-remove-new="${i}"`, 'Remove')).join('');
        addBtn.disabled = count() >= EXAM_MAX_FILES;
        hint.textContent = `${count()} of ${EXAM_MAX_FILES} files${added.length ? ` · ${formatFileSize(addedSize())} to upload` : ''}`;
      };

      listEl.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        clearError();
        if (b.dataset.removeNew !== undefined) added.splice(Number(b.dataset.removeNew), 1);
        else if (b.dataset.removeSaved) removed.add(Number(b.dataset.removeSaved));
        else if (b.dataset.undo) {
          if (count() >= EXAM_MAX_FILES) return fail(`Remove another file first: at most ${EXAM_MAX_FILES} files.`);
          removed.delete(Number(b.dataset.undo));
        }
        draw();
      });
      addBtn.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        clearError();
        const problems = [];
        for (const f of input.files) {
          const dot = f.name.lastIndexOf('.');
          const ext = dot < 0 ? '' : f.name.slice(dot).toLowerCase();
          if (added.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) continue;
          if (!EXAM_FILE_TYPES.includes(ext)) problems.push(`${f.name}: only PDF, PPT, CSV or DOC files are allowed.`);
          else if (f.size > EXAM_MAX_FILE_SIZE) problems.push(`${f.name} is larger than 10 MB.`);
          else if (!f.size) problems.push(`${f.name} is empty.`);
          else if (count() >= EXAM_MAX_FILES) { problems.push(`At most ${EXAM_MAX_FILES} files. ${f.name} was not added.`); }
          else added.push(f);
        }
        input.value = ''; // so the same file can be picked again after removing it
        if (problems.length) fail(problems.join(' '));
        draw();
      });
      document.getElementById('cancelExamSubmit').addEventListener('click', closeModal);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('examSubmitBtn');
        if (submitBtn.disabled) return;
        clearError();
        const link = form.link.value.trim();
        if (!link && !count()) return fail('Provide a link or attach at least one file.');
        if (added.length && count() > EXAM_MAX_FILES) return fail(`At most ${EXAM_MAX_FILES} files in total.`);
        if (addedSize() > EXAM_MAX_UPLOAD) return fail(`These files total ${formatFileSize(addedSize())}. This site accepts up to ${formatFileSize(EXAM_MAX_UPLOAD)} per submit: submit some now and add the rest with Update, or share a Drive link.`);
        const label = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading…';
        let r;
        try {
          r = await submitExamWork(exam, { link, note: form.note.value.trim(), files: added, removeFileIds: [...removed] });
        } catch {
          r = { error: 'Could not reach the server. Check your connection and try again.' };
        }
        if (r.error) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = label;
          return fail(r.error);
        }
        closeModal();
        showToast(`${EXAM_LABELS[exam] || exam} submitted`, 'success');
        await renderAll();
      });
      draw();
    }
  });
}
/** amLeader: only the group's team leader can submit/resubmit (server enforces this
    too) — everyone else still sees the submission's status/link/file/note, just not
    the button to change it. */
function renderSubmissionBlock(project, hostId, amLeader) {
  const host = document.getElementById(hostId || 'submissionBlock');
  if (!host) return;
  const sub = project.submission;
  // The Progress page reuses this block and already names the project in its heading.
  const projectTag = hostId !== 'submissionTabBlock' ? '' : `<span class="faint" style="font-size:13px;">${escapeHtml(project.title)} <span class="id-tag mono">${escapeHtml(project.displayId)}</span></span>`;

  if (!sub) {
    host.innerHTML = `
      <div class="section__head"><h3>Final Submission</h3>${projectTag}</div>
      <p class="muted" style="font-size:12.5px; margin-bottom:12px;">Once your project is ready, submit a link (repository, drive folder, etc.) and/or attach a file (PDF, PPT, CSV, or DOC) for faculty to review.</p>
      ${amLeader
        ? `<button class="btn btn--primary btn--sm" data-submit-project-btn>${icon('upload')} Submit Project</button>`
        : `<p class="field-hint">Only your team leader (${escapeHtml(project.teamLeader || 'not set')}) can submit this project.</p>`}`;
    const submitBtn = host.querySelector('[data-submit-project-btn]');
    if (submitBtn) submitBtn.addEventListener('click', () => openSubmitProjectModal(project));
    return;
  }

  const badgeClass = sub.status === 'Approved' ? 'badge--good' : sub.status === 'Rejected' ? 'badge--bad' : 'badge--warn';
  host.innerHTML = `
    <div class="section__head"><h3>Final Submission <span class="badge ${badgeClass}">${escapeHtml(sub.status)}</span></h3>${projectTag}</div>
    <div class="list-item">
      ${sub.link ? `<div class="list-item__body"><strong>Link:</strong> <a href="${escapeHtml(sub.link)}" target="_blank" rel="noopener">${escapeHtml(sub.link)}</a></div>` : ''}
      ${sub.fileName ? `<div class="list-item__body"><strong>File:</strong> <a href="/api/projects/${project.id}/submission/file" target="_blank">${escapeHtml(sub.fileName)}</a> <span class="faint">(${formatFileSize(sub.fileSize)})</span></div>` : ''}
      ${sub.note ? `<div class="list-item__body"><strong>Note:</strong> ${escapeHtml(sub.note)}</div>` : ''}
      <div class="list-item__body faint">Submitted by ${escapeHtml(sub.submittedBy)} on ${formatDateTime(sub.submittedAt)}</div>
      ${sub.facultyNote ? `<div class="list-item__body"><strong>Faculty note:</strong> ${escapeHtml(sub.facultyNote)}</div>` : ''}
    </div>
    ${sub.status !== 'Approved' && amLeader ? `<button class="btn btn--ghost btn--sm" data-resubmit-project-btn>${sub.status === 'Rejected' ? 'Resubmit' : 'Update Submission'}</button>` : ''}
    ${sub.status !== 'Approved' && !amLeader ? `<p class="field-hint">Only your team leader (${escapeHtml(project.teamLeader || sub.submittedBy)}) can update this submission.</p>` : ''}`;

  const resubmitBtn = host.querySelector('[data-resubmit-project-btn]');
  if (resubmitBtn) resubmitBtn.addEventListener('click', () => openSubmitProjectModal(project));
}

function openSubmitProjectModal(project) {
  const sub = project.submission;
  openModal(sub ? 'Update Submission' : 'Submit Project', `
    <form id="submitProjectForm">
      <div class="login-error" id="submitProjectError"></div>
      <div class="field full" style="margin-bottom:14px;">
        <label>Link (repository, drive folder, doc, etc. — optional if attaching a file)</label>
        <input name="link" type="url" placeholder="https://..." value="${escapeHtml(sub?.link || project.githubUrl || '')}">
      </div>
      <div class="field full" style="margin-bottom:14px;">
        <label>Attach a file (optional — PDF, PPT, CSV, or DOC, max 10MB)</label>
        <input type="file" name="file" accept=".pdf,.ppt,.pptx,.csv,.doc,.docx">
        ${sub?.fileName ? `<div class="field-hint" style="margin-top:6px;">Currently attached: ${escapeHtml(sub.fileName)} — choose a new file to replace it, or leave blank to keep it.</div>` : ''}
      </div>
      <div class="field full">
        <label>Note for faculty (optional)</label>
        <textarea name="note" placeholder="Anything faculty should know before reviewing...">${escapeHtml(sub?.note || '')}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cancelSubmitProject">Cancel</button>
        <button type="submit" class="btn btn--primary">${sub ? 'Resubmit' : 'Submit'}</button>
      </div>
    </form>
  `, {
    onMount: () => {
      document.getElementById('cancelSubmitProject').addEventListener('click', closeModal);
      document.getElementById('submitProjectForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const link = fd.get('link').trim();
        const file = e.target.querySelector('input[name=file]').files[0] || null;
        const errEl = document.getElementById('submitProjectError');
        errEl.classList.remove('show');

        if (!link && !file && !sub?.fileName) {
          errEl.textContent = 'Provide a link or attach a file.';
          errEl.classList.add('show');
          return;
        }

        const result = await submitProjectWork(project.id, { link, note: fd.get('note').trim(), file });
        if (result.error) {
          errEl.textContent = result.error;
          errEl.classList.add('show');
          return;
        }
        closeModal();
        showToast('Submission sent to faculty for review', 'success');
        await renderAll();
      });
    }
  });
}

