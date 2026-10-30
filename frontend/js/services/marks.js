/* ============================================================
   CDAD :: marks.js
   Faculty-editable marks per student. Total/percentage/grade
   are always derived — never stored as independent fields.
   Thin wrappers over /api/marks now; activity logging happens
   server-side.
   ============================================================ */

async function allMarks() {
  return getData(CDAD_KEYS.MARKS);
}

async function marksForStudent(studentDisplayId) {
  const marks = await allMarks();
  return marks.find((m) => m.studentId === studentDisplayId) || null;
}

/* Continuous Assessment — 50 marks. Every head is marked out of 20 and scaled down for the total. */
const CA_OUT_OF = 20;
const CA_TOTAL = 50;
const CA_HEADS = [
  { key: 'jury1', label: 'Jury Assessment-I', short: 'Jury I', scaledTo: 16, detail: 'Jury-based, micro project driven evaluation (Unit 1 & 2)' },
  { key: 'jury2', label: 'Jury Assessment-II', short: 'Jury II', scaledTo: 16, detail: 'Jury-based, micro project driven evaluation (Unit 3 & 4)' },
  { key: 'assess3', label: 'Unit 5 - MCQ based', short: 'Unit 5 MCQ', scaledTo: 8, detail: 'MCQ based assessment (Unit 5)' },
  { key: 'assign1', label: 'Coursera Certification', short: 'Coursera', scaledTo: 10, detail: 'Coursera certification (minimum 30 hours)' }
];
const round2 = (n) => Math.round(n * 100) / 100;

/** A head's mark after scaling down (e.g. 15/20 in Jury I -> 12/16). null while it hasn't been entered. */
function scaledMark(raw, head) {
  return raw == null ? null : round2((raw / CA_OUT_OF) * head.scaledTo);
}

/* Finals — a separate exam held after the Continuous Assessment, marked directly out of 50. */
const FINALS_OUT_OF = 50;

/** CA total (out of 50) from the scaled marks, plus the Finals (out of 50) once it has been entered.
    Heads not entered yet simply add nothing, so totals grow as marks come in. Before the Finals the overall
    total / percentage / grade are out of 50 (CA only); once Finals are entered they are out of 100. */
function deriveMarkTotals(m) {
  const ca = round2(CA_HEADS.reduce((sum, h) => sum + (scaledMark(m[h.key], h) || 0), 0));
  const finals = m.finals == null ? null : m.finals;
  const total = round2(ca + (finals || 0));
  const max = CA_TOTAL + (finals != null ? FINALS_OUT_OF : 0);
  const pct = round2((total / max) * 100);
  return { ca, caMax: CA_TOTAL, finals, finalsMax: FINALS_OUT_OF, total, max, percentage: pct, grade: gradeInfoFromPercentage(pct).grade, gradePoint: gradeInfoFromPercentage(pct).point, gradeText: gradeInfoFromPercentage(pct).text, entered: CA_HEADS.filter((h) => m[h.key] != null).length };
}

async function upsertMarks(studentDisplayId, fields) {
  const res = await fetch(`/api/marks/student/${encodeURIComponent(studentDisplayId)}`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
  });
  return res.ok ? res.json() : null;
}

async function upsertGroupMarks(groupDisplayId, fields) {
  const res = await fetch(`/api/marks/group/${encodeURIComponent(groupDisplayId)}`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
  });
  return res.ok ? res.json() : null;
}

async function releaseAllMarks(released = true) {
  const res = await fetch('/api/marks/release-all', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ released })
  });
  return res.ok ? res.json() : null;
}

async function setMarksReleased(id, released) {
  const res = await fetch(`/api/marks/${id}/release`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ released })
  });
  return res.ok;
}

async function deleteMarks(id) {
  return deleteData(CDAD_KEYS.MARKS, id);
}

async function resetMarks(id) {
  const res = await fetch(`/api/marks/${id}/reset`, { method: 'POST', credentials: 'include' });
  return res.ok;
}
