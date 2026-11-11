
require('dotenv').config();

const express = require('express');
const sql = require('mssql');

// ---------- AZURE SQL CONFIGURATION ----------
const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false
  },
  connectionTimeout: 60000
};

// ---------- DATABASE CONNECTION ----------
const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log('Connected to Azure SQL Database');
    return pool;
  })
  .catch(err => {
    console.error('Database connection failed:', err.message);
    throw err;
  });

// ---------- DATABASE QUERY HELPER ----------
async function query(text, params = {}) {
  const pool = await poolPromise;
  const request = pool.request();

  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }

  const result = await request.query(text);
  return result.recordset;
}

// ---------- ERROR HANDLER ----------
const wrap = (fn) => (req, res) =>
  fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

// ---------- DISTANCE CALCULATION ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- EXPRESS APP ----------
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ---------- GET ALL PLACES ----------
app.get('/api/places', wrap(async (req, res) => {
  const type = req.query.type;

  let text = `
    SELECT
      p.place_id,
      p.city_id,
      p.name,
      p.place_type,
      p.latitude,
      p.longitude,
      p.description,
      ROUND(AVG(CAST(r.rating AS FLOAT)), 1) AS avg_rating,
      COUNT(r.review_id) AS review_count
    FROM places p
    LEFT JOIN reviews r ON r.place_id = p.place_id
  `;

  const params = {};

  if (type) {
    text += ' WHERE p.place_type = @type';
    params.type = type;
  }

  text += `
    GROUP BY
      p.place_id,
      p.city_id,
      p.name,
      p.place_type,
      p.latitude,
      p.longitude,
      p.description
    ORDER BY avg_rating DESC
  `;

  res.json(await query(text, params));
}));

// ---------- GET REVIEWS OF A PLACE ----------
app.get('/api/places/:id/reviews', wrap(async (req, res) => {
  const rows = await query(
    `SELECT r.rating, r.comment, r.created_at, u.name
     FROM reviews r
     JOIN users u ON u.user_id = r.user_id
     WHERE r.place_id = @id
     ORDER BY r.created_at DESC`,
    { id: Number(req.params.id) }
  );

  res.json(rows);
}));

// ---------- ADD A REVIEW ----------
app.post('/api/reviews', wrap(async (req, res) => {
  const { place_id, rating, comment } = req.body;

  if (!Number.isInteger(Number(place_id)) ||
      !(Number(rating) >= 1 && Number(rating) <= 5)) {
    return res.status(400).json({ error: 'Invalid review' });
  }

  await query(
    `INSERT INTO reviews (user_id, place_id, rating, comment)
     VALUES (1, @place_id, @rating, @comment)`,
    {
      place_id: Number(place_id),
      rating: Number(rating),
      comment: comment || ''
    }
  );

  res.json({ ok: true });
}));

// ---------- GET TRANSPORT TYPES ----------
app.get('/api/transport', wrap(async (req, res) => {
  res.json(await query('SELECT * FROM transport_types'));
}));

// ---------- REPORT A FARE ----------
app.post('/api/fares', wrap(async (req, res) => {
  const {
    from_place_id,
    to_place_id,
    transport_id,
    amount_paid
  } = req.body;

  if (
    !from_place_id ||
    !to_place_id ||
    !transport_id ||
    !(amount_paid > 0)
  ) {
    return res.status(400).json({ error: 'Invalid fare report' });
  }

  await query(
    `INSERT INTO fare_reports
     (user_id, from_place_id, to_place_id, transport_id, amount_paid)
     VALUES (1, @from_id, @to_id, @transport_id, @amount)`,
    {
      from_id: Number(from_place_id),
      to_id: Number(to_place_id),
      transport_id: Number(transport_id),
      amount: Number(amount_paid)
    }
  );

  res.json({ ok: true });
}));

// ---------- FARE ESTIMATOR ----------
app.get('/api/fare-estimate', wrap(async (req, res) => {
  const { from, to, transport } = req.query;

  if ([from, to, transport].some(
    v => !Number.isInteger(Number(v)) || !v
  )) {
    return res.status(400).json({ error: 'Invalid selection' });
  }

  const [a] = await query(
    'SELECT * FROM places WHERE place_id = @id',
    { id: Number(from) }
  );

  const [b] = await query(
    'SELECT * FROM places WHERE place_id = @id',
    { id: Number(to) }
  );

  const [t] = await query(
    'SELECT * FROM transport_types WHERE transport_id = @id',
    { id: Number(transport) }
  );

  if (!a || !b || !t) {
    return res.status(400).json({ error: 'Invalid selection' });
  }

  const km = haversine(
    a.latitude,
    a.longitude,
    b.latitude,
    b.longitude
  ) * 1.3;

  const formulaFare = Math.round(
    t.base_fare + t.per_km * km
  );

  const [r] = await query(
    `SELECT
       ROUND(AVG(amount_paid), 0) AS avg_fare,
       COUNT(*) AS report_count
     FROM fare_reports
     WHERE transport_id = @t
     AND (
       (from_place_id = @a AND to_place_id = @b)
       OR
       (from_place_id = @b AND to_place_id = @a)
     )`,
    {
      t: t.transport_id,
      a: a.place_id,
      b: b.place_id
    }
  );

  res.json({
    distance_km: Number(km.toFixed(1)),
    formula_fare: formulaFare,
    reported_avg: r.report_count ? Number(r.avg_fare) : null,
    reports: r.report_count
  });
}));

// ---------- START SERVER ----------
async function startServer() {
  try {
    await poolPromise;

    app.listen(process.env.PORT || 3000, () => {
  console.log('WanderLocal is running');
});
  } catch (err) {
    console.error('Unable to start server:', err.message);
    process.exit(1);
  }
}

startServer();
