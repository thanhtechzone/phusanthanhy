require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function parseWeekStart(weekStr) {
  // expect 'YYYY-MM-DD' (thứ Hai của tuần) → lưu UTC 00:00
  // Ví dụ '2025-09-15' → new Date('2025-09-15T00:00:00Z')
  if (!weekStr) return null;
  const d = new Date(`${weekStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return d;
}

function mapSlotOut(s) {
  return {
    id: s.id,
    weekday: s.weekday,
    start: fromMinutes(s.startMin),
    end: fromMinutes(s.endMin),
    doctor: s.doctor,
    room: s.room,
    note: s.note || '',
    status: s.status,
    capacity: s.capacity,
    weekStart: s.weekStart ? s.weekStart.toISOString().slice(0,10) : null, // YYYY-MM-DD
  };
}

function toMinutes(timeStr) {
  // expects HH:MM
  const [h, m] = timeStr.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id, role: user.role, email: user.email }, JWT_SECRET, {
    expiresIn: '7d',
  });
  res.json({ token });
});

app.get('/api/schedule', async (req, res) => {
  const weekStr = req.query.week;
  const order = [{ weekday: 'asc' }, { startMin: 'asc' }];

  // Nếu có chọn tuần: ưu tiên trả về slot của tuần đó.
  // Nếu tuần đó chưa có dữ liệu, fallback về slot "chung" (weekStart = null).
  if (weekStr) {
    const weekStart = parseWeekStart(weekStr);
    if (!weekStart) return res.status(400).json({ error: 'Invalid week param' });

    let slots = await prisma.slot.findMany({ where: { weekStart }, orderBy: order });
    if (slots.length === 0) {
      slots = await prisma.slot.findMany({ where: { weekStart: null }, orderBy: order });
    }
    return res.json(slots.map(mapSlotOut));
  }

  // Mặc định: giữ hành vi cũ (toàn bộ)
  const slots = await prisma.slot.findMany({ orderBy: order });
  res.json(slots.map(mapSlotOut));
});

app.post('/api/admin/slots', authMiddleware, async (req, res) => {
  const { weekday, start, end, doctor, room, note, status, capacity, weekStart } = req.body;
  if (
    typeof weekday !== 'number' ||
    weekday < 0 || weekday > 6 ||
    !start || !end || !doctor || !room ||
    typeof capacity !== 'number'
  ) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const created = await prisma.slot.create({
    data: {
      weekday,
      startMin: toMinutes(start),
      endMin: toMinutes(end),
      doctor,
      room,
      note: note || null,
      status: status === 'CLOSED' ? 'CLOSED' : 'AVAILABLE',
      capacity,
      weekStart: weekStart ? parseWeekStart(weekStart) : null, // <-- NEW
    },
  });
  res.json(created);
});


app.put('/api/admin/slots/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { weekday, start, end, doctor, room, note, status, capacity, weekStart } = req.body;
  const data = {};
  if (typeof weekday === 'number') data.weekday = weekday;
  if (start) data.startMin = toMinutes(start);
  if (end) data.endMin = toMinutes(end);
  if (doctor) data.doctor = doctor;
  if (room) data.room = room;
  if (note !== undefined) data.note = note || null;
  if (status) data.status = status === 'CLOSED' ? 'CLOSED' : 'AVAILABLE';
  if (typeof capacity === 'number') data.capacity = capacity;
  if (weekStart !== undefined) data.weekStart = weekStart ? parseWeekStart(weekStart) : null; // <-- NEW
  try {
    const updated = await prisma.slot.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    res.status(404).json({ error: 'Slot not found' });
  }
});


// DELETE ALL slots (optional reseed defaults with ?defaults=1)
app.delete('/api/admin/slots/purge', authMiddleware, adminOnly, async (req, res) => {
  try {
    const reseed = String(req.query.defaults || '').toLowerCase();
    const doReseed = reseed === '1' || reseed === 'true';

    const result = await prisma.slot.deleteMany(); // { count }
    if (doReseed) {
      await applyWeeklyDefaultsIfMissing();
    }
    res.json({ ok: true, deleted: result.count, reseeded: doReseed });
  } catch (e) {
    console.error('Purge error', e);
    res.status(500).json({ error: 'Purge failed' });
  }
});


app.delete('/api/admin/slots/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await prisma.slot.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: 'Slot not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Weekly auto default scheduler: Sunday 23:59 (server time)
const DEFAULT_DOCTOR = 'Ths BSNT Phan Thị Minh Ý';
const DEFAULT_ROOM = 'PK SPK Thành Ý';
async function applyWeeklyDefaultsIfMissing() {
  // Check if next week has any slots; if none, create defaults
  // We use weekday-only schedule, so just check presence of any slot entries
  const any = await prisma.slot.count();
  if (any === 0) {
    const sundayNote = 'CN có Test tiểu đường thai kì, các Bầu lưu ý phải nhịn ăn trước đó 6 tiếng.';
    const ops = [];
    ops.push(
      prisma.slot.create({ data: { weekday: 0, startMin: 7*60, endMin: 11*60, doctor: DEFAULT_DOCTOR, room: DEFAULT_ROOM, note: sundayNote, status: 'AVAILABLE', capacity: 10 } })
    );
    for (let d = 1; d <= 6; d++) {
      ops.push(
        prisma.slot.create({ data: { weekday: d, startMin: 17*60, endMin: 20*60, doctor: DEFAULT_DOCTOR, room: DEFAULT_ROOM, note: '', status: 'AVAILABLE', capacity: 10 } })
      );
    }
    await Promise.all(ops);
    console.log('Applied weekly default schedule');
  }
}

setInterval(async () => {
  const now = new Date();
  const isSunday = now.getDay() === 0; // 0=Sunday
  if (isSunday && now.getHours() === 23 && now.getMinutes() === 59) {
    try { await applyWeeklyDefaultsIfMissing(); } catch (e) { console.error('Auto default error', e); }
  }
}, 60 * 1000);


