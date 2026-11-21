/* ============================================================
   CDAD backend :: routes/activity.js
   Ports the activity-log half of js/common.js.
   ============================================================ */
const express = require('express');
const { db } = require('../db');
const { serializeActivity } = require('../lib/serializers');
const { requireRole } = require('../lib/sessions');

const router = express.Router();

router.get('/', requireRole('faculty'), async (req, res) => {
  res.json((await db.prepare('SELECT * FROM activity ORDER BY date DESC, id DESC').all()).map(serializeActivity));
});

router.delete('/', requireRole('faculty'), async (req, res) => {
  await db.prepare('DELETE FROM activity').run();
  res.json({ ok: true });
});

module.exports = router;
