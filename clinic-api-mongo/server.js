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
    source: a.source || 'chatbot',
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
  const { doctorId, date, slot, patientName, phone, reason, source } = req.body || {};

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
      source: ['chatbot', 'dashboard', 'phone'].includes(source) ? source : 'chatbot',
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

// ---------- Details by ID only ----------
// GET /appointments/:id/details      (no phone needed)
app.get('/appointments/:id/details', ah(async (req, res) => {
  const seq = parseSeq(req.params.id);
  if (!seq) return fail(res, 400, 'INVALID_ID', 'Appointment ID format thappu (example: APT1001)');

  const a = await Appointment.findOne({ seq }).lean();
  if (!a) return fail(res, 404, 'NOT_FOUND', 'Intha ID-ku appointment illa');

  const full = await present(a);
  // mask the phone so only the last 4 digits are shown (XXXXXX1234)
  full.phone = 'XXXXXX' + String(full.phone).slice(-4);
  res.json({ success: true, appointment: full });
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


// =====================================================================
//  LIST + DASHBOARD ENDPOINTS (admin side, all need x-api-key if API_KEY is set)
// =====================================================================

// ---------- List all appointments (simple) ----------
// GET /appointments?date=YYYY-MM-DD&doctorId=D101&status=BOOKED&active=true
app.get('/appointments', ah(async (req, res) => {
  const { date, doctorId, status, active } = req.query;
  const q = {};
  if (date) {
    if (!isValidDate(date)) return fail(res, 400, 'INVALID_DATE', 'date YYYY-MM-DD format la venum');
    q.date = date;
  }
  if (doctorId) q.doctorId = String(doctorId);
  if (status) q.status = String(status).toUpperCase();
  if (active === 'true') q.active = true;
  const list = await Appointment.find(q).sort({ date: 1, slot: 1 }).limit(200).lean();
  const appointments = await Promise.all(list.map(present));
  res.json({ success: true, count: appointments.length, appointments });
}));

// ---------- Bookings by doctor NAME ----------
// GET /appointments-by-doctor?name=ramesh&date=YYYY-MM-DD&status=BOOKED&active=true
app.get('/appointments-by-doctor', ah(async (req, res) => {
  const { name, date, status, active } = req.query;
  if (!name || !String(name).trim()) return fail(res, 400, 'INVALID_NAME', 'name venum (example: ramesh)');
  const safe = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await Doctor.find({ name: new RegExp(safe, 'i') }).lean();
  if (docs.length === 0) return fail(res, 404, 'DOCTOR_NOT_FOUND', 'Antha name la doctor kidaikala');
  const q = { doctorId: { $in: docs.map((d) => d._id) } };
  if (date) {
    if (!isValidDate(date)) return fail(res, 400, 'INVALID_DATE', 'date YYYY-MM-DD format la venum');
    q.date = date;
  }
  if (status) q.status = String(status).toUpperCase();
  if (active === 'true') q.active = true;
  const list = await Appointment.find(q).sort({ date: 1, slot: 1 }).limit(200).lean();
  const appointments = await Promise.all(list.map(present));
  res.json({
    success: true,
    doctors: docs.map((d) => ({ doctorId: d._id, name: d.name, specialization: d.specialization })),
    count: appointments.length,
    appointments,
  });
}));

// ---------- All doctors (no date needed) ----------
// GET /doctors
app.get('/doctors', ah(async (req, res) => {
  const docs = await Doctor.find().sort({ name: 1 }).lean();
  res.json({
    success: true,
    count: docs.length,
    doctors: docs.map((d) => ({
      doctorId: d._id,
      name: d.name,
      specialization: d.specialization,
      qualification: d.qualification,
      experienceYears: d.experienceYears,
      consultationFee: d.consultationFee,
      isAvailable: d.isAvailable !== false,
    })),
  });
}));

// ---------- Dashboard helpers ----------
const DEPT_ICONS = { Cardiology: '❤️', 'General Medicine': '🩺', Pediatrics: '🧒', Dermatology: '🧴' };

// Dashboard status: Cancelled / Rescheduled / Completed (time over) / Confirmed (upcoming)
function uiStatus(a) {
  if (a.status === 'CANCELLED') return 'Cancelled';
  if (msUntil(a.date, a.slot) < 0) return 'Completed';
  return a.status === 'RESCHEDULED' ? 'Rescheduled' : 'Confirmed';
}

async function doctorMap() {
  const docs = await Doctor.find().lean();
  return new Map(docs.map((d) => [d._id, d]));
}

function adminRow(a, dm) {
  const d = dm.get(a.doctorId);
  return {
    id: formatId(a.seq),
    appointment_date: a.date,
    appointment_time: a.slot,
    status: uiStatus(a),
    booking_source: a.source || 'chatbot',
    notes: a.reason || null,
    cancellation_reason: a.cancelReason || null,
    created_at: a.createdAt ? new Date(a.createdAt).toISOString() : a.date + 'T00:00:00.000Z',
    patient_id: a.phone,
    doctor_id: a.doctorId,
    department_id: d ? d.specialization : null,
    patientsdetails: { full_name: a.patientName, phone: a.phone },
    doctors: d ? { full_name: d.name } : null,
    departments: d ? { name: d.specialization } : null,
  };
}

// Patients are derived from appointments (phone number = patient key)
function buildPatients(all) {
  const byPhone = new Map();
  const sorted = [...all].sort((x, y) => new Date(x.createdAt || 0) - new Date(y.createdAt || 0));
  for (const a of sorted) {
    const p = byPhone.get(a.phone) || {
      id: a.phone, full_name: a.patientName, phone: a.phone, email: null, date_of_birth: null,
      gender: null, blood_group: null, address: null, emergency_contact_name: null, emergency_contact_phone: null,
      created_at: a.createdAt ? new Date(a.createdAt).toISOString() : a.date + 'T00:00:00.000Z',
      total_appointments: 0, last_visit: null,
    };
    p.full_name = a.patientName; // latest name wins
    p.total_appointments += 1;
    if (!p.last_visit || a.date > p.last_visit) p.last_visit = a.date;
    byPhone.set(a.phone, p);
  }
  return [...byPhone.values()].sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
}

// ---------- Dashboard: appointments (with filters) ----------
// GET /admin/appointments?status=Confirmed&source=chatbot&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&doctorId=D101&q=ravi&limit=500
app.get('/admin/appointments', ah(async (req, res) => {
  const { status, source, dateFrom, dateTo, doctorId, q } = req.query;
  const filter = {};
  if (dateFrom && !isValidDate(dateFrom)) return fail(res, 400, 'INVALID_DATE', 'dateFrom YYYY-MM-DD format la venum');
  if (dateTo && !isValidDate(dateTo)) return fail(res, 400, 'INVALID_DATE', 'dateTo YYYY-MM-DD format la venum');
  if (dateFrom || dateTo) {
    filter.date = {};
    if (dateFrom) filter.date.$gte = dateFrom;
    if (dateTo) filter.date.$lte = dateTo;
  }
  if (doctorId) filter.doctorId = String(doctorId);
  if (source && source !== 'All') filter.source = String(source);

  const dm = await doctorMap();
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  const all = await Appointment.find(filter).sort({ date: -1, slot: -1 }).limit(limit).lean();
  let rows = all.map((a) => adminRow(a, dm));
  if (status && status !== 'All') rows = rows.filter((r) => r.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) =>
      (r.patientsdetails.full_name || '').toLowerCase().includes(needle) ||
      (r.patientsdetails.phone || '').includes(needle) ||
      (r.doctors && r.doctors.full_name.toLowerCase().includes(needle)) ||
      (r.departments && r.departments.name.toLowerCase().includes(needle)) ||
      r.id.toLowerCase().includes(needle));
  }
  res.json({ success: true, count: rows.length, appointments: rows });
}));

// ---------- Dashboard: doctors list ----------
// GET /admin/doctors
app.get('/admin/doctors', ah(async (req, res) => {
  const docs = await Doctor.find().sort({ name: 1 }).lean();
  res.json({
    success: true,
    count: docs.length,
    doctors: docs.map((d) => ({
      id: d._id,
      full_name: d.name,
      qualification: d.qualification || '',
      experience_years: d.experienceYears || 0,
      consultation_fee: d.consultationFee || 0,
      phone: d.phone || '',
      email: d.email || '',
      is_available: d.isAvailable !== false,
      departments: { name: d.specialization, icon: DEPT_ICONS[d.specialization] || '🏥' },
    })),
  });
}));

// ---------- Dashboard: patients (derived from appointments) ----------
// GET /admin/patients?q=ravi
app.get('/admin/patients', ah(async (req, res) => {
  const all = await Appointment.find().lean();
  let patients = buildPatients(all);
  if (req.query.q) {
    const needle = String(req.query.q).toLowerCase();
    patients = patients.filter((p) => p.full_name.toLowerCase().includes(needle) || p.phone.includes(needle));
  }
  res.json({ success: true, count: patients.length, patients });
}));

// ---------- Dashboard: billing (derived: fee of each appointment) ----------
// Completed -> Paid, upcoming (Confirmed / Rescheduled) -> Pending, Cancelled -> not billed
// GET /admin/billing
app.get('/admin/billing', ah(async (req, res) => {
  const dm = await doctorMap();
  const all = await Appointment.find().sort({ date: -1, slot: -1 }).limit(5000).lean();
  const records = [];
  for (const a of all) {
    const st = uiStatus(a);
    if (st === 'Cancelled') continue;
    const d = dm.get(a.doctorId);
    records.push({
      id: 'INV-' + formatId(a.seq),
      amount: d ? d.consultationFee || 0 : 0,
      status: st === 'Completed' ? 'Paid' : 'Pending',
      payment_method: null,
      created_at: new Date(a.date + 'T' + a.slot + ':00+05:30').toISOString(),
      patientsdetails: { full_name: a.patientName, phone: a.phone },
      appointmentsdetails: { appointment_date: a.date, doctors: d ? { full_name: d.name } : null },
    });
  }
  res.json({ success: true, count: records.length, records });
}));

// ---------- Dashboard: summary numbers ----------
// GET /admin/stats
app.get('/admin/stats', ah(async (req, res) => {
  const dm = await doctorMap();
  const all = await Appointment.find().lean();
  const byStatus = { Pending: 0, Confirmed: 0, Completed: 0, Cancelled: 0, Rescheduled: 0 };
  const bySource = {};
  const byDepartment = {};
  let revenue = 0;
  for (const a of all) {
    const st = uiStatus(a);
    byStatus[st] += 1;
    const src = a.source || 'chatbot';
    bySource[src] = (bySource[src] || 0) + 1;
    const d = dm.get(a.doctorId);
    const dept = d ? d.specialization : 'Unknown';
    byDepartment[dept] = (byDepartment[dept] || 0) + 1;
    if (st === 'Completed' && d) revenue += d.consultationFee || 0;
  }
  const patients = buildPatients(all);
  const doctors = [...dm.values()];
  res.json({
    success: true,
    today: todayStr(),
    totalPatients: patients.length,
    totalAppointments: all.length,
    completedAppointments: byStatus.Completed,
    totalRevenue: revenue,
    totalDoctors: doctors.length,
    availableDoctors: doctors.filter((d) => d.isAvailable !== false).length,
    byStatus,
    bySource,
    byDepartment,
    recentPatients: patients.slice(0, 5),
  });
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
