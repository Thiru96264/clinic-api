# Clinic Appointment API (MongoDB version)

Doctor appointment booking REST API: dynamic availability (date + doctor), book, view, cancel, reschedule.
Stack: Node.js + Express + MongoDB (Mongoose).

Same endpoints, request bodies, responses and error codes as the SQLite version, so Inferno / Prism setup does not change.

## 1. MongoDB Atlas setup (free, no install)

1. Go to mongodb.com/atlas and sign up (Google login works).
2. Create a project, then **Create a cluster** and choose the **free (M0)** tier. Any nearby region is fine (Mumbai is good).
3. **Database Access** (left menu) > **Add New Database User**.
   Username `clinicuser`, set a password (avoid special characters like `@ : /` to keep the connection string simple). Role: **Read and write to any database**.
4. **Network Access** > **Add IP Address**. For lab / demo choose **Allow access from anywhere** (`0.0.0.0/0`). Lab network and hosting (Render) both use changing IPs, so this is the easy option.
5. **Database** (or Clusters) > **Connect** > **Drivers** > copy the connection string. It looks like:
   `mongodb+srv://clinicuser:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. Replace `<password>` with your password and add the database name `clinic` before the `?`:
   `mongodb+srv://clinicuser:YourPassword@cluster0.xxxxx.mongodb.net/clinic?retryWrites=true&w=majority`

You do **not** create collections or documents by hand. The API creates them on first run.

## 2. Run locally

```bash
npm install
```

Copy `.env.example` to `.env` (in PowerShell: `copy .env.example .env`) and put your connection string:

```
MONGODB_URI=mongodb+srv://clinicuser:YourPassword@cluster0.xxxxx.mongodb.net/clinic?retryWrites=true&w=majority
```

```bash
npm start
```

Expected output:

```
Sample doctors, schedules and leave inserted     (first run only)
MongoDB connected
Clinic API (MongoDB) running on port 3000
```

Then open `http://localhost:3000/health` and
`http://localhost:3000/doctors/available?date=2026-10-12&specialization=Cardiology`.

## 3. See your data

In Atlas: **Database > Browse Collections > clinic**. You will see:

| Collection | Content |
|---|---|
| `doctors` | id, name, specialization |
| `schedules` | weekly working hours per doctor |
| `leaves` | doctor leave dates |
| `appointments` | all bookings (status BOOKED / RESCHEDULED / CANCELLED) |
| `counters` | running number used for APT1001, APT1002 ... |

To add a doctor or leave day, use **Insert Document** in Atlas (or edit the seed in `db.js` and drop the `doctors` collection to re-seed).

## Environment variables

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | **Required.** Atlas connection string |
| `PORT` | Server port (default 3000) |
| `API_KEY` | If set, every request except `/health` must send header `x-api-key: <key>` |

## Endpoints

| Method | Path | Used by |
|---|---|---|
| GET | `/health` | Check |
| GET | `/specializations` | Inferno |
| GET | `/doctors/available?date=YYYY-MM-DD&specialization=Cardiology` | Inferno |
| GET | `/doctors/:id/slots?date=YYYY-MM-DD` | Inferno |
| GET | `/appointments/:id?phone=XXXXXXXXXX` | Inferno |
| POST | `/appointments` | Prism Booking Agent |
| POST | `/appointments/:id/cancel` | Prism Cancel Agent |
| PUT | `/appointments/:id/reschedule` | Prism Reschedule Agent |

Book body: `{ "doctorId": "D101", "date": "2026-10-12", "slot": "10:30", "patientName": "Ravi", "phone": "9876543210", "reason": "Fever" }`
Cancel body: `{ "phone": "9876543210", "reason": "Not available" }`
Reschedule body: `{ "phone": "9876543210", "newDate": "2026-10-13", "newSlot": "11:00" }`

Errors return `{ success: false, code, message }`. Codes: `INVALID_DATE`, `PAST_DATE`, `INVALID_SLOT`, `INVALID_PHONE`, `INVALID_NAME`, `INVALID_ID`, `DOCTOR_NOT_FOUND`, `NOT_FOUND`, `SLOT_UNAVAILABLE` (409), `ALREADY_CANCELLED` (409), `SAME_SLOT`, `TOO_LATE` (422).

## How availability works

```
schedule slots for that weekday
  - doctor leave on that date
  - active appointments
  - past time (when date = today, India time)
```

Double booking is blocked twice: an availability re-check at booking time, and a unique partial index on `(doctorId, date, slot)` for active appointments.

## Troubleshooting

| Message | Fix |
|---|---|
| `MONGODB_URI missing` | `.env` file illa, or file name thappu (`.env`, not `.env.txt`) |
| `Server selection timed out` / `ECONNREFUSED` | Atlas Network Access la `0.0.0.0/0` add pannunga. Lab network la mongodb.net block aana, mobile hotspot try pannunga |
| `bad auth` / `Authentication failed` | Password thappu, illa connection string la `<password>` replace aagala. Password la special character irundha URL-encode pannunga |
| Data fresh ah venum | Atlas la `appointments` collection la documents delete pannunga |

## Publish (Render etc.)

- Build command: `npm install`, Start command: `npm start`
- Environment variables: `MONGODB_URI` (and `API_KEY` if you want a key)
- Data is stored in Atlas, so it stays safe across restarts and redeploys.
- Quick check after publishing: `GET <your-url>/health`
