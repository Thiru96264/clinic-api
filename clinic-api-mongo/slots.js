const { Doctor, Schedule, Leave, Appointment } = require('./db');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// "Now" in India time, expressed with UTC getters (works on any server timezone)
function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function todayStr() {
  return nowIST().toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function isValidSlot(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
}

// Milliseconds from now until the appointment (both in IST frame)
function msUntil(date, slot) {
  return Date.parse(`${date}T${slot}:00Z`) - nowIST().getTime();
}

async function doctorExists(doctorId) {
  return !!(await Doctor.exists({ _id: doctorId }));
}

/**
 * Dynamic availability:
 *   schedule for that weekday
 *   - doctor leave on that date
 *   - active appointments (BOOKED / RESCHEDULED)
 *   - past time (when date is today)
 */
async function getFreeSlots(doctorId, date) {
  if (date < todayStr()) return [];

  if (await Leave.exists({ doctorId, date })) return [];

  const schedules = await Schedule.find({ doctorId, dayOfWeek: weekday(date) }).lean();
  if (schedules.length === 0) return [];

  const all = new Set();
  for (const s of schedules) {
    const end = toMin(s.endTime);
    for (let t = toMin(s.startTime); t + s.slotDuration <= end; t += s.slotDuration) {
      all.add(toHHMM(t));
    }
  }

  const booked = new Set(
    (await Appointment.find({ doctorId, date, active: true }).select('slot').lean()).map((a) => a.slot)
  );

  let nowMin = -1;
  if (date === todayStr()) {
    const n = nowIST();
    nowMin = n.getUTCHours() * 60 + n.getUTCMinutes();
  }

  return [...all].filter((t) => !booked.has(t) && toMin(t) > nowMin).sort();
}

module.exports = {
  todayStr,
  isValidDate,
  isValidSlot,
  msUntil,
  doctorExists,
  getFreeSlots,
};
