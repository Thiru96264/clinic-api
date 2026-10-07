require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectDb, nextSeq, Doctor, Appointment } = require('./db');
const {
  todayStr,
  isValidDate,
  isValidSlot,
  msUntil,
  doctorExists,
  getFreeSlots,
} = require('./slots');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ''; // optional: set to require x-api-key header
const MIN_HOURS_BEFORE_CHANGE = 2; // cancel / reschedule allowed only if appointment is >= 2 hrs away

// ---------- helpers ----------
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

// Express 4 does not catch errors from async handlers, so wrap them
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const formatId = (seq) => `APT${1000 + seq}`;
function parseSeq(param) {
  const m = /^APT(\d+)$/i.exec(param || '');
  if (!m) return null;
  const n = Number(m[1]) - 1000;
  return n > 0 ? n : null;
}

const isPhone = (p) => typeof p === 'string' && /^[6-9]\d{9}$/.test(p);
const isDupKey = (e) => e && e.code === 11000;

async function present(a) {
  const doc = await Doctor.findById(a.doctorId).lean();
  return {
    appointmentId: formatId(a.seq),
    doctorId: a.doctorId,
    doctorName: doc ? doc.name : null,
    specialization: doc ? doc.specialization : null,
    patientName: a.patientName,
    phone: a.phone,
    reason: a.reason || null,
    date: a.date,
    slot: a.slot,
    status: a.status,
  };
}

// optional API key guard (everything except /health)
app.use((req, res, next) => {
  if (!API_KEY || req.path === '/health') return next();
  if (req.get('x-api-key') !== API_KEY) return fail(res, 401, 'UNAUTHORIZED', 'Invalid or missing x-api-key');
  next();
});

// Load an appointment and verify phone. Returns the document, or sends an error and returns null.
async function loadVerified(req, res, phone) {
  const seq = parseSeq(req.params.id);
  if (!seq) { fail(res, 400, 'INVALID_ID', 'Appointment ID format thappu (example: APT1001)'); return null; }
  if (!isPhone(phone)) { fail(res, 400, 'INVALID_PHONE', 'Valid 10 digit phone number venum'); return null; }
  const a = await Appointment.findOne({ seq }).lean();
  // same message for "not found" and "phone mismatch" so IDs cannot be guessed
  if (!a || a.phone !== phone) {
    fail(res, 404, 'NOT_FOUND', 'Appointment ID / phone number match aagala');
    return null;
  }
  return a;
}

// ---------- health ----------
app.get('/health', (req, res) => res.json({ success: true, status: 'ok', today: todayStr() }));

// ---------- helper: specializations ----------
app.get('/specializations', ah(async (req, res) => {
  const list = await Doctor.distinct('specialization');
  res.json({ success: true, specializations: list.sort() });
}));

// ---------- API 1: available doctors for a date ----------
// GET /doctors/available?date=YYYY-MM-DD&specialization=Cardiology
app.get('/doctors/available', ah(async (req, res) => {
  const { date, specialization } = req.query;
  if (!isValidDate(date)) return fail(res, 400, 'INVALID_DATE', 'date YYYY-MM-DD format la venum');
  if (date < todayStr()) return fail(res, 400, 'PAST_DATE', 'Past date ku booking panna mudiyaadhu');

  const doctors = await Doctor.find().sort({ name: 1 }).lean();
  const wanted = specialization ? String(specialization).toLowerCase() : null;

  const result = [];
  for (const d of doctors) {
    if (wanted && d.specialization.toLowerCase() !== wanted) continue;
    const free = await getFreeSlots(d._id, date);
    if (free.length > 0) {
      result.push({
        doctorId: d._id,
        name: d.name,
        specialization: d.specialization,
        freeSlots: free.length,
        firstSlot: free[0],
      });
    }
  }
  res.json({ success: true, date, count: result.length, doctors: result });
}));

// ---------- API 2: free slots for doctor + date ----------
// GET /doctors/:id/slots?date=YYYY-MM-DD
app.get('/doctors/:id/slots', ah(async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  if (!(await doctorExists(id))) return fail(res, 404, 'DOCTOR_NOT_FOUND', 'Doctor kidaikala');
  if (!isValidDate(date)) return fail(res, 400, 'INVALID_DATE', 'date YYYY-MM-DD format la venum');
  if (date < todayStr()) return fail(res, 400, 'PAST_DATE', 'Past date ku booking panna mudiyaadhu');

  const doc = await Doctor.findById(id).lean();
  const freeSlots = await getFreeSlots(id, date);
  res.json({
    success: true,
    doctorId: id,
    doctorName: doc.name,
    specialization: doc.specialization,
    date,
    count: freeSlots.length,
    freeSlots,
  });
}));

// ---------- Book ----------
// POST /appointments
app.post('/appointments', ah(async (req, res) => {
  const { doctorId, date, slot, patientName, phone, reason } = req.body || {};

  if (typeof doctorId !== 'string' || !(await doctorExists(doctorId)))
    return fail(res, 404, 'DOCTOR_NOT_FOUND', 'Doctor kidaikala');
  if (!isValidDate(date)) return fail(res, 400, 'INVALID_DATE', 'date YYYY-MM-DD format la venum');
  if (!isValidSlot(slot)) return fail(res, 400, 'INVALID_SLOT', 'slot HH:MM format la venum (example 10:30)');
  if (!patientName || typeof patientName !== 'string' || patientName.trim().length < 2)
    return fail(res, 400, 'INVALID_NAME', 'Patient name venum');
  if (!isPhone(phone)) return fail(res, 400, 'INVALID_PHONE', 'Valid 10 digit phone number venum');
  if (date < todayStr()) return fail(res, 400, 'PAST_DATE', 'Past date ku booking panna mudiyaadhu');

  // availability re-check at booking time
  if (!(await getFreeSlots(doctorId, date)).includes(slot))
    return fail(res, 409, 'SLOT_UNAVAILABLE', 'Andha slot ippo available illa. Vera slot select pannunga.');

  try {
    const created = await Appointment.create({
      seq: await nextSeq(),
      doctorId,
      patientName: patientName.trim(),
      phone,
      reason: typeof reason === 'string' && reason ? reason : undefined,
      date,
      slot,
      status: 'BOOKED',
      active: true,
    });
    res.status(201).json({
      success: true,
      message: 'Appointment confirm aayiduchu',
      appointment: await present(created),
    });
  } catch (e) {
    if (isDupKey(e))
      return fail(res, 409, 'SLOT_UNAVAILABLE', 'Andha slot ippo thaan vera yaaro book pannitaanga. Vera slot select pannunga.');
    throw e;
  }
}));

// ---------- View ----------
// GET /appointments/:id?phone=XXXXXXXXXX
app.get('/appointments/:id', ah(async (req, res) => {
  const a = await loadVerified(req, res, req.query.phone);
  if (!a) return;
  res.json({ success: true, appointment: await present(a) });
}));

// ---------- Cancel ----------
// POST /appointments/:id/cancel   body: { phone, reason }
app.post('/appointments/:id/cancel', ah(async (req, res) => {
  const { phone, reason } = req.body || {};
  const a = await loadVerified(req, res, phone);
  if (!a) return;

  if (a.status === 'CANCELLED')
    return fail(res, 409, 'ALREADY_CANCELLED', 'Intha appointment already cancel aayiduchu');

  if (msUntil(a.date, a.slot) < MIN_HOURS_BEFORE_CHANGE * 3600 * 1000)
    return fail(res, 422, 'TOO_LATE', `Appointment ku ${MIN_HOURS_BEFORE_CHANGE} hrs kulla cancel panna mudiyaadhu`);

  const updated = await Appointment.findOneAndUpdate(
    { seq: a.seq, active: true },
    {
      $set: {
        status: 'CANCELLED',
        active: false,
        cancelReason: typeof reason === 'string' && reason ? reason : undefined,
      },
    },
    { new: true }
  ).lean();
  if (!updated) return fail(res, 409, 'ALREADY_CANCELLED', 'Intha appointment already cancel aayiduchu');

  res.json({ success: true, message: 'Appointment cancel aayiduchu', appointment: await present(updated) });
}));

// ---------- Reschedule ----------
// PUT /appointments/:id/reschedule   body: { phone, newDate, newSlot }
app.put('/appointments/:id/reschedule', ah(async (req, res) => {
  const { phone, newDate, newSlot } = req.body || {};
  const a = await loadVerified(req, res, phone);
  if (!a) return;

  if (!isValidDate(newDate)) return fail(res, 400, 'INVALID_DATE', 'newDate YYYY-MM-DD format la venum');
  if (!isValidSlot(newSlot)) return fail(res, 400, 'INVALID_SLOT', 'newSlot HH:MM format la venum');
  if (newDate < todayStr()) return fail(res, 400, 'PAST_DATE', 'Past date ku reschedule panna mudiyaadhu');

  if (a.status === 'CANCELLED')
    return fail(res, 409, 'ALREADY_CANCELLED', 'Cancel aana appointment ah reschedule panna mudiyaadhu. Pudhu booking pannunga.');

  if (newDate === a.date && newSlot === a.slot)
    return fail(res, 400, 'SAME_SLOT', 'Pazhaiya slot thaan, vera date / slot sollunga');

  if (msUntil(a.date, a.slot) < MIN_HOURS_BEFORE_CHANGE * 3600 * 1000)
    return fail(res, 422, 'TOO_LATE', `Appointment ku ${MIN_HOURS_BEFORE_CHANGE} hrs kulla reschedule panna mudiyaadhu`);

  if (!(await getFreeSlots(a.doctorId, newDate)).includes(newSlot))
    return fail(res, 409, 'SLOT_UNAVAILABLE', 'Andha slot available illa. Vera slot select pannunga.');

  try {
    const updated = await Appointment.findOneAndUpdate(
      { seq: a.seq, active: true },
      { $set: { date: newDate, slot: newSlot, status: 'RESCHEDULED' } },
      { new: true }
    ).lean();
    if (!updated) return fail(res, 409, 'ALREADY_CANCELLED', 'Appointment ippo active illa');
    res.json({ success: true, message: 'Appointment reschedule aayiduchu', appointment: await present(updated) });
  } catch (e) {
    if (isDupKey(e))
      return fail(res, 409, 'SLOT_UNAVAILABLE', 'Andha slot ippo thaan vera yaaro book pannitaanga. Vera slot select pannunga.');
    throw e;
  }
}));

// ---------- 404 + error handler ----------
app.use((req, res) => fail(res, 404, 'NOT_FOUND', 'Endpoint kidaikala'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'BAD_JSON', 'Request body valid JSON illa');
  console.error(err);
  fail(res, 500, 'SERVER_ERROR', 'Something went wrong');
});

// ---------- start ----------
connectDb()
  .then(() => app.listen(PORT, () => console.log(`Clinic API (MongoDB) running on port ${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
