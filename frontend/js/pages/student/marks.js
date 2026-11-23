/* ================= Marks page (Evaluation Summary + Donut + Trend + Details) ================= */
async function renderMarksPage() {
  const host = document.getElementById('marksMainGrid');
  if (!host) return;
  const m = await marksForStudent(ME.displayId);
  const groupCard = await buildGroupMarksCard();
  if (!m) { host.innerHTML = `<div class="section">${emptyState('Marks have not been released yet.')}</div>` + groupCard; return; }
  const t = deriveMarkTotals(m);

  // Continuous Assessment (50 marks): each head is marked out of 20 and scaled down for the total.
  const summaryCard = `
    <div class="section">
      <div class="section__head"><h3>Continuous Assessment — ${CA_TOTAL} Marks</h3></div>
      <div class="marks-ledger">
        <table>
          <thead><tr><th>Evaluation</th><th>Marked</th><th>Final Marks</th><th>Maximum</th></tr></thead>
          <tbody>
            ${CA_HEADS.map((h) => `
            <tr>
              <td>${escapeHtml(h.label)}<div class="faint" style="font-size:11.5px;">${escapeHtml(h.detail)}</div></td>
              <td>${m[h.key] != null ? m[h.key] + ' / ' + CA_OUT_OF : '—'}</td>
              <td>${m[h.key] != null ? scaledMark(m[h.key], h) : '—'}</td>
              <td>${h.scaledTo}</td>
            </tr>`).join('')}
            <tr style="font-weight:600;"><td>Continuous Assessment total</td><td></td><td>${t.ca}</td><td>${t.caMax}</td></tr>
            <tr>
              <td>Finals<div class="faint" style="font-size:11.5px;">Final exam, conducted after the Continuous Assessment</div></td>
              <td>${t.finals != null ? t.finals + ' / ' + FINALS_OUT_OF : '—'}</td>
              <td>${t.finals != null ? t.finals : '—'}</td>
              <td>${FINALS_OUT_OF}</td>
            </tr>
          </tbody>
          <tfoot><tr><td>${t.finals != null ? 'Overall total' : 'Total so far (Finals not held yet)'}</td><td></td><td>${t.total}</td><td>${t.max}</td></tr></tfoot>
        </table>
      </div>
    </div>`;

  const donutCard = `
    <div class="section">
      <div class="section__head"><h3>Overall Marks</h3></div>
      <div class="donut-wrap">
        <div style="position:relative; width:160px; height:160px;">
          ${buildDonutChart(t.percentage, { size: 160, stroke: 16, color: 'var(--blue)' })}
          <div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
            <div class="donut-center-value">${t.total} / ${t.max}</div>
            <div class="donut-center-label">${t.percentage}%</div>
          </div>
        </div>
        <div class="donut-stats">
          <div class="donut-stat"><div class="donut-stat__value" title="${escapeHtml(t.gradeText)}">${t.grade}</div><div class="donut-stat__label">Grade · ${t.gradePoint} pts</div></div>
          <div class="donut-stat"><div class="donut-stat__value donut-stat__value--good">${t.percentage >= 60 ? 'Good' : 'Needs Work'}</div><div class="donut-stat__label">Status</div></div>
        </div>
      </div>
    </div>`;

  // Trend: how well each marked assessment went (raw mark out of 20, as a percentage).
  const marked = CA_HEADS.filter((h) => m[h.key] != null);
  const trendPoints = [...marked.map((h) => Math.round((m[h.key] / CA_OUT_OF) * 100)), ...(m.finals != null ? [Math.round((m.finals / FINALS_OUT_OF) * 100)] : [])];
  const trendLabels = [...marked.map((h) => h.short), ...(m.finals != null ? ['Finals'] : [])];
  const trendCard = `
    <div class="section">
      <div class="section__head"><h3>Marks Trend</h3></div>
      ${trendPoints.length >= 2 ? `<div class="line-chart-wrap">
        ${buildLineChart(trendPoints, trendLabels, { width: 420, height: 160, max: 100, min: 0 })}
        <div class="line-chart-caption">${trendLabels.map((l) => `<span>${escapeHtml(l)}</span>`).join('')}</div>
      </div>` : emptyState('The trend appears once two assessments have been marked.')}
    </div>`;

  const detailsCard = `
    <div class="section">
      <div class="section__head"><h3>Evaluation Details</h3></div>
      <p class="muted" style="font-size:12.5px;">Note: Marks will be updated by respective faculty members.</p>
      <p class="faint" style="font-size:12px;">Check back regularly for the latest updates.</p>
      <div style="margin-top:18px; text-align:center; opacity:0.5; font-size:38px;">${icon('clipboard-list')}</div>
    </div>`;

  host.innerHTML = summaryCard + donutCard + trendCard + detailsCard + groupCard;
}

/* Marks of every member of the student's own group, as assigned by faculty. */
async function buildGroupMarksCard() {
  const group = await getGroup(ME.group);
  if (!group) return '';
  const students = await getData(CDAD_KEYS.STUDENTS);
  const marks = await allMarks();
  const members = (group.members || []).map((id) => students.find((s) => s.displayId === id)).filter(Boolean);
  const rows = members.map((s) => {
    const m = marks.find((x) => x.studentId === s.displayId);
    return { s, m, t: m ? deriveMarkTotals(m) : null };
  });
  const scored = rows.filter((r) => r.t);
  const avg = scored.length ? Math.round(scored.reduce((a, r) => a + r.t.percentage, 0) / scored.length * 100) / 100 : null;
  const cell = (m, h) => (m && m[h.key] != null ? `${scaledMark(m[h.key], h)}/${h.scaledTo}` : '—');
  return `
    <div class="section" style="grid-column:1 / -1;">
      <div class="section__head">
        <div><span class="faint mono" style="font-size:11px;">${escapeHtml(group.displayId)}</span><h3>Group Marks — ${escapeHtml(group.name)}</h3></div>
        ${avg !== null ? `<span class="badge badge--info">Group avg ${avg}%</span>` : ''}
      </div>
      <div class="marks-ledger">
        <table>
          <thead><tr><th>Member</th>${CA_HEADS.map((h) => `<th>${escapeHtml(h.short)}</th>`).join('')}<th>Finals</th><th>Total</th><th>%</th><th>Grade</th></tr></thead>
          <tbody>
            ${rows.map(({ s, m, t }) => `
              <tr${s.displayId === ME.displayId ? ' style="font-weight:600;"' : ''}>
                <td>${escapeHtml(s.name)}${s.displayId === ME.displayId ? ' (you)' : ''}<div class="faint mono" style="font-size:11px;">${escapeHtml(s.displayId)}</div></td>
                ${CA_HEADS.map((h) => `<td>${cell(m, h)}</td>`).join('')}
                <td>${m && m.finals != null ? m.finals + '/' + FINALS_OUT_OF : '—'}</td>
                <td>${t ? t.total + '/' + t.max : '—'}</td><td>${t ? t.percentage + '%' : '—'}</td><td>${t ? t.grade : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="faint" style="font-size:12px; margin-top:10px;">Marks are assigned by your faculty and shown for all members of your group.</p>
    </div>`;
}
