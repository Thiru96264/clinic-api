require('dotenv').config();
const mongoose = require('mongoose');

const { Schema } = mongoose;

// ---------- Schemas ----------
const doctorSchema = new Schema({
  _id: { type: String, required: true }, // example: D101
  name: { type: String, required: true },
  specialization: { type: String, required: true },
  qualification: { type: String, default: 'MBBS' },
  experienceYears: { type: Number, default: 5 },
  consultationFee: { type: Number, default: 500 },
  phone: String,
  email: String,
  isAvailable: { type: Boolean, default: true },
});

// Weekly working hours. dayOfWeek: 0 = Sunday ... 6 = Saturday
const scheduleSchema = new Schema({
  doctorId: { type: String, required: true, index: true },
  dayOfWeek: { type: Number, required: true },
  startTime: { type: String, required: true }, // HH:MM
  endTime: { type: String, required: true }, // HH:MM
  slotDuration: { type: Number, required: true }, // minutes
});

const leaveSchema = new Schema({
  doctorId: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  reason: String,
});
leaveSchema.index({ doctorId: 1, date: 1 });

const appointmentSchema = new Schema(
  {
    seq: { type: Number, required: true, unique: true }, // APT id = 1000 + seq
    doctorId: { type: String, required: true },
    patientName: { type: String, required: true },
    phone: { type: String, required: true },
    reason: String,
    date: { type: String, required: true }, // YYYY-MM-DD
    slot: { type: String, required: true }, // HH:MM
    status: { type: String, enum: ['BOOKED', 'RESCHEDULED', 'CANCELLED'], default: 'BOOKED' },
    active: { type: Boolean, default: true }, // false once cancelled
    cancelReason: String,
    source: { type: String, enum: ['chatbot', 'dashboard', 'phone'], default: 'chatbot' }, // where the booking came from
  },
  { timestamps: true }
);
// Double booking safety net: only one ACTIVE appointment per doctor + date + slot
appointmentSchema.index(
  { doctorId: 1, date: 1, slot: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

const counterSchema = new Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});

const Doctor = mongoose.model('Doctor', doctorSchema);
const Schedule = mongoose.model('Schedule', scheduleSchema);
const Leave = mongoose.model('Leave', leaveSchema);
const Appointment = mongoose.model('Appointment', appointmentSchema);
const Counter = mongoose.model('Counter', counterSchema);

// Next appointment number: 1, 2, 3 ... (shown to user as APT1001, APT1002 ...)
async function nextSeq() {
  const c = await Counter.findOneAndUpdate(
    { _id: 'appointment' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return c.seq;
}

// ---------- Seed (runs only when doctors collection is empty) ----------
// Extra doctor profile info used by the dashboard
const DOCTOR_PROFILES = {
  D101: { qualification: 'MD, DM (Cardiology)', experienceYears: 15, consultationFee: 800, phone: '9840011101', email: 'ramesh@clinic.com' },
  D102: { qualification: 'MD, DNB (Cardiology)', experienceYears: 10, consultationFee: 700, phone: '9840011102', email: 'priya@clinic.com' },
  D103: { qualification: 'MBBS, MD (General Medicine)', experienceYears: 12, consultationFee: 400, phone: '9840011103', email: 'karthik@clinic.com' },
  D104: { qualification: 'MBBS, DCH (Pediatrics)', experienceYears: 8, consultationFee: 500, phone: '9840011104', email: 'meena@clinic.com' },
  D105: { qualification: 'MD (Dermatology)', experienceYears: 9, consultationFee: 600, phone: '9840011105', email: 'suresh@clinic.com' },
};

// Fills profile fields on existing doctors (only where missing), so old databases get upgraded safely
async function upgradeDoctorProfiles() {
  for (const [id, p] of Object.entries(DOCTOR_PROFILES)) {
    const d = await Doctor.findById(id).lean();
    if (!d) continue;
    const patch = {};
    for (const [k, v] of Object.entries(p)) if (d[k] === undefined || d[k] === null) patch[k] = v;
    if (d.isAvailable === undefined) patch.isAvailable = true;
    if (Object.keys(patch).length) await Doctor.updateOne({ _id: id }, { $set: patch });
  }
}

async function seed() {
  if ((await Doctor.countDocuments()) > 0) {
    await upgradeDoctorProfiles();
    return;
  }

  await Doctor.insertMany([
    { _id: 'D101', name: 'Dr. Ramesh', specialization: 'Cardiology' },
    { _id: 'D102', name: 'Dr. Priya', specialization: 'Cardiology' },
    { _id: 'D103', name: 'Dr. Karthik', specialization: 'General Medicine' },
    { _id: 'D104', name: 'Dr. Meena', specialization: 'Pediatrics' },
    { _id: 'D105', name: 'Dr. Suresh', specialization: 'Dermatology' },
  ]);

  const sched = [];
  const add = (doctorId, dayOfWeek, startTime, endTime, slotDuration) =>
    sched.push({ doctorId, dayOfWeek, startTime, endTime, slotDuration });

  // D101: Mon-Fri 10:00-13:00, 30 min
  for (let d = 1; d <= 5; d++) add('D101', d, '10:00', '13:00', 30);
  // D102: Mon, Wed, Fri 16:00-19:00, 30 min
  for (const d of [1, 3, 5]) add('D102', d, '16:00', '19:00', 30);
  // D103: Mon-Sat, morning + evening shift, 15 min
  for (let d = 1; d <= 6; d++) {
    add('D103', d, '09:00', '12:00', 15);
    add('D103', d, '17:00', '20:00', 15);
  }
  // D104: Tue, Thu, Sat 10:00-14:00, 20 min
  for (const d of [2, 4, 6]) add('D104', d, '10:00', '14:00', 20);
  // D105: Mon-Sat 11:00-15:00, 30 min
  for (let d = 1; d <= 6; d++) add('D105', d, '11:00', '15:00', 30);
  await Schedule.insertMany(sched);

  // Sample leave: Dr. Ramesh on 2026-10-14 (Wednesday)
  await Leave.create({ doctorId: 'D101', date: '2026-10-14', reason: 'Conference' });
  await upgradeDoctorProfiles();
  console.log('Sample doctors, schedules and leave inserted');
}

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI missing. Create a .env file (see .env.example) with your MongoDB connection string.');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  await Appointment.init(); // make sure indexes (incl. the double booking one) exist
  await seed();
  console.log('MongoDB connected');
}

module.exports = { connectDb, nextSeq, Doctor, Schedule, Leave, Appointment, Counter };
