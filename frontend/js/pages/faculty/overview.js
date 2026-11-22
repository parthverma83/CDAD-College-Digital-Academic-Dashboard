/* ================= Overview: dashboard (Sections 13/14) =================
   Stat cards, a per-division overview (submissions and presentations per
   exam), what's coming up next, recent activity and the project status breakdown. */

const OVERVIEW_EXAMS = ['TA1', 'TA2', 'EndSem'];

function overviewTimeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : formatDate(iso);
}

function overviewTimeUntil(iso) {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** "3 / 16" with a small bar. */
function miniProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="mini-progress" title="${pct}%">
    <div class="bar-track"><div class="bar-fill${pct === 100 ? '' : ' bar-fill--blue'}" style="width:${pct}%"></div></div>
    <span>${done} / ${total}</span></div>`;
}

async function renderOverview() {
  const host = document.getElementById('overviewStats');
  if (!host) return;
  const [students, groups, projects, requests, peerRequests, exam, presentations, activity] = await Promise.all([
    getData(CDAD_KEYS.STUDENTS), getData(CDAD_KEYS.GROUPS), getData(CDAD_KEYS.PROJECTS), getData(CDAD_KEYS.REQUESTS),
    allStudentRequests(), fetchExamSubmissions(), allPresentations(), getData(CDAD_KEYS.ACTIVITY).catch(() => [])
  ]);
  const examSubs = exam.submissions || [];
  const deadlines = exam.deadlines || {};
  const divisions = groupDivisions(groups);
  const pendingRequests = requests.filter((r) => r.status === 'Pending').length + peerRequests.filter((r) => r.status === 'Pending').length;
  const examCount = (e) => examSubs.filter((s) => s.exam === e).length;

  // ---- Stat cards ----
  host.innerHTML = `
    <div class="stat-card stat-card--blue"><div class="stat-card__icon">👥</div><div class="stat-card__label">Total Students</div>
      <div class="stat-card__value">${students.length}</div><div class="stat-card__sub stat-card__sub--good">${students.filter((s) => s.status === 'Active').length} active</div></div>
    <div class="stat-card stat-card--purple"><div class="stat-card__icon">▦</div><div class="stat-card__label">Total Groups</div>
      <div class="stat-card__value">${groups.length}</div><div class="stat-card__sub stat-card__sub--muted">across ${divisions.length || 0} division${divisions.length === 1 ? '' : 's'}</div></div>
    <div class="stat-card stat-card--green"><div class="stat-card__icon">📤</div><div class="stat-card__label">Exam Submissions</div>
      <div class="stat-card__value">${examSubs.length}</div><div class="stat-card__sub stat-card__sub--muted">TA1 ${examCount('TA1')} · TA2 ${examCount('TA2')} · End Sem ${examCount('EndSem')}</div></div>
    <div class="stat-card stat-card--orange"><div class="stat-card__icon">📨</div><div class="stat-card__label">Pending Requests</div>
      <div class="stat-card__value">${pendingRequests}</div><div class="stat-card__sub ${pendingRequests ? 'stat-card__sub--warn' : 'stat-card__sub--muted'}">${pendingRequests ? 'waiting for a response' : 'all caught up'}</div></div>`;

  // ---- Division overview ----
  const divBody = document.getElementById('divisionOverviewBody');
  if (divBody) {
    const activePres = presentations.filter((p) => p.status !== 'Cancelled');
    const rowsFor = (label, value, list) => {
      const ids = new Set(list.map((g) => g.displayId));
      const counted = list.filter((g) => (g.members || []).length).length || list.length;
      const studentsIn = list.reduce((n, g) => n + (g.members || []).length, 0);
      const cells = OVERVIEW_EXAMS.map((e) => `<td>${miniProgress(examSubs.filter((s) => s.exam === e && ids.has(s.group)).length, counted)}</td>`).join('');
      const presented = new Set(activePres.filter((p) => ids.has(p.group)).map((p) => p.group)).size;
      const isTotal = value === 'ALL';
      return `<tr class="division-row${isTotal ? ' division-row--total' : ''}" ${isTotal ? '' : `data-division="${escapeHtml(value)}" title="Open ${escapeHtml(label)} submissions"`}>
        <td><strong>${escapeHtml(label)}</strong></td><td>${list.length}</td><td>${studentsIn}</td>${cells}<td>${miniProgress(presented, counted)}</td></tr>`;
    };
    const noDivision = groups.filter((g) => !g.division);
    const rows = divisions.map((d) => rowsFor(d, d, groups.filter((g) => g.division === d)));
    if (noDivision.length && divisions.length) rows.push(rowsFor('No division', '__NONE__', noDivision));
    if (rows.length > 1 || !divisions.length) rows.push(rowsFor(divisions.length ? 'All divisions' : 'All groups', 'ALL', groups));
    divBody.innerHTML = groups.length ? rows.join('') : `<tr class="empty-row"><td colspan="7">No groups yet.</td></tr>`;
    divBody.querySelectorAll('[data-division]').forEach((tr) => tr.addEventListener('click', async () => {
      submissionDivisionFilter = tr.dataset.division;
      showView('submissions');
      await renderSubmissionsHub();
      await renderExamSubmissions();
    }));
  }

  // ---- Upcoming: open exam deadlines and the next presentations ----
  const upHost = document.getElementById('overviewUpcoming');
  if (upHost) {
    const now = Date.now();
    const items = [];
    OVERVIEW_EXAMS.forEach((e) => {
      const d = deadlines[e];
      if (d && new Date(d).getTime() > now) {
        items.push({ at: new Date(d).getTime(), icon: '⏰', title: `${EXAM_LABELS[e]} submissions close ${overviewTimeUntil(d)}`,
          sub: `${formatDateTime(d)} · ${examCount(e)} of ${groups.length} groups submitted` });
      }
    });
    presentations
      .filter((p) => p.status !== 'Cancelled' && p.status !== 'Completed' && p.date && new Date(p.date).getTime() >= now - 86400000)
      .forEach((p) => {
        const g = groups.find((x) => x.displayId === p.group);
        items.push({ at: new Date(p.date).getTime(), icon: '🎤', title: `Presentation — ${p.group}${g ? ' · ' + g.name : ''}`,
          sub: `${formatDate(p.date)}${p.time ? ', ' + p.time : ''}${p.venue ? ' · ' + p.venue : ''}` });
      });
    items.sort((a, b) => a.at - b.at);
    upHost.innerHTML = items.length ? items.slice(0, 6).map((i) => `
      <div class="notif-mini"><div class="notif-mini__icon">${i.icon}</div>
        <div><div class="notif-mini__title">${escapeHtml(i.title)}</div><div class="notif-mini__time">${escapeHtml(i.sub)}</div></div></div>`).join('')
      + (items.length > 6 ? `<div class="notif-mini-foot">+ ${items.length - 6} more</div>` : '')
      : emptyState('Nothing scheduled — set exam deadlines or schedule presentations.');
  }

  // ---- Recent activity ----
  const actHost = document.getElementById('overviewActivity');
  if (actHost) {
    actHost.innerHTML = activity.length ? activity.slice(0, 6).map((a) => `
      <div class="notif-mini"><div class="notif-mini__icon">•</div>
        <div><div class="notif-mini__title" style="font-weight:600;">${escapeHtml(a.text)}</div><div class="notif-mini__time">${overviewTimeAgo(a.date)}</div></div></div>`).join('')
      : emptyState('No activity yet.');
  }

  // ---- Project status breakdown ----
  const statusHost = document.getElementById('projectStatusChart');
  if (statusHost) {
    const byStatus = {};
    projects.forEach((p) => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
    const total = projects.length || 1;
    statusHost.innerHTML = Object.keys(byStatus).length ? Object.entries(byStatus).map(([status, count]) => `
      <div class="bar-row">
        <div class="bar-row__label">${escapeHtml(status)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round((count / total) * 100)}%"></div></div>
        <div class="bar-row__value">${count}</div>
      </div>`).join('') : emptyState('No projects yet.');
  }
}
