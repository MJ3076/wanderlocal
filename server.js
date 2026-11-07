const express = require('express');
const Database = require('better-sqlite3');

const db = new Database('wanderlocal.db');
db.pragma('foreign_keys = ON');

// ---------- TABLES (from the ER diagram) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS cities (
  city_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  state TEXT
);
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT DEFAULT 'tourist'
);
CREATE TABLE IF NOT EXISTS places (
  place_id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id INTEGER REFERENCES cities(city_id),
  name TEXT NOT NULL,
  place_type TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  review_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  place_id INTEGER REFERENCES places(place_id),
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transport_types (
  transport_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_fare REAL,
  per_km REAL
);
CREATE TABLE IF NOT EXISTS fare_reports (
  fare_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  from_place_id INTEGER REFERENCES places(place_id),
  to_place_id INTEGER REFERENCES places(place_id),
  transport_id INTEGER REFERENCES transport_types(transport_id),
  amount_paid REAL,
  reported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------- SAMPLE DATA (only runs the first time) ----------
if (db.prepare('SELECT COUNT(*) AS c FROM cities').get().c === 0) {
  db.prepare('INSERT INTO cities (name, state) VALUES (?, ?)').run('Jaipur', 'Rajasthan');

  const addUser = db.prepare('INSERT INTO users (name, email, role) VALUES (?, ?, ?)');
  addUser.run('Demo Tourist', 'demo@wanderlocal.com', 'tourist');
  addUser.run('Admin', 'admin@wanderlocal.com', 'admin');

  const addPlace = db.prepare(
    'INSERT INTO places (city_id, name, place_type, latitude, longitude, description) VALUES (1, ?, ?, ?, ?, ?)'
  );
  addPlace.run('Hawa Mahal', 'sightseeing', 26.9239, 75.8267, 'Iconic pink sandstone palace with 953 windows.');
  addPlace.run('Amber Fort', 'sightseeing', 26.9855, 75.8513, 'Hilltop fort with royal courtyards and mirror work.');
  addPlace.run('City Palace', 'sightseeing', 26.9258, 75.8237, 'Royal palace complex in the old city.');
  addPlace.run('Jantar Mantar', 'sightseeing', 26.9247, 75.8246, 'Historic astronomical observatory.');
  addPlace.run('Nahargarh Fort', 'sightseeing', 26.9373, 75.8155, 'Fort with a sunset view over the city.');
  addPlace.run('Jal Mahal', 'sightseeing', 26.9534, 75.8461, 'Palace in the middle of Man Sagar Lake.');
  addPlace.run('Lassiwala', 'street_food', 26.9150, 75.8070, 'Famous clay-cup lassi on MI Road.');
  addPlace.run('Laxmi Misthan Bhandar', 'restaurant', 26.9190, 75.8244, 'Classic Rajasthani sweets and thali.');
  addPlace.run('Rawat Mishthan Bhandar', 'street_food', 26.9195, 75.7880, 'Known for pyaaz kachori and mawa kachori.');

  const addReview = db.prepare('INSERT INTO reviews (user_id, place_id, rating, comment) VALUES (1, ?, ?, ?)');
  addReview.run(1, 5, 'Beautiful at sunrise, go early.');
  addReview.run(2, 5, 'Worth the climb. Take a guide.');
  addReview.run(7, 4, 'Cold, creamy and cheap.');
  addReview.run(9, 5, 'Best kachori in the city.');

  const addTransport = db.prepare('INSERT INTO transport_types (name, base_fare, per_km) VALUES (?, ?, ?)');
  addTransport.run('Auto rickshaw', 30, 14);
  addTransport.run('E-rickshaw', 20, 9);
  addTransport.run('Shared cab', 15, 7);

  const addFare = db.prepare(
    'INSERT INTO fare_reports (user_id, from_place_id, to_place_id, transport_id, amount_paid) VALUES (1, ?, ?, ?, ?)'
  );
  addFare.run(1, 2, 1, 180);
  addFare.run(1, 2, 1, 160);
  addFare.run(1, 2, 1, 200);
  addFare.run(3, 9, 1, 150);
}

// ---------- HELPER: distance between two points (km) ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.static('public'));

// All places with average rating (JOIN + GROUP BY)
app.get('/api/places', (req, res) => {
  const type = req.query.type;
  let sql = `
    SELECT p.*, ROUND(AVG(r.rating), 1) AS avg_rating, COUNT(r.review_id) AS review_count
    FROM places p
    LEFT JOIN reviews r ON r.place_id = p.place_id`;
  const params = [];
  if (type) {
    sql += ' WHERE p.place_type = ?';
    params.push(type);
  }
  sql += ' GROUP BY p.place_id ORDER BY avg_rating DESC';
  res.json(db.prepare(sql).all(...params));
});

// Reviews of one place
app.get('/api/places/:id/reviews', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.rating, r.comment, r.created_at, u.name
       FROM reviews r JOIN users u ON u.user_id = r.user_id
       WHERE r.place_id = ? ORDER BY r.created_at DESC`
    )
    .all(req.params.id);
  res.json(rows);
});

// Add a review
app.post('/api/reviews', (req, res) => {
  const { place_id, rating, comment } = req.body;
  if (!place_id || !(rating >= 1 && rating <= 5)) {
    return res.status(400).json({ error: 'Invalid review' });
  }
  db.prepare('INSERT INTO reviews (user_id, place_id, rating, comment) VALUES (1, ?, ?, ?)').run(
    place_id,
    rating,
    comment || ''
  );
  res.json({ ok: true });
});

// Transport types
app.get('/api/transport', (req, res) => {
  res.json(db.prepare('SELECT * FROM transport_types').all());
});

// Report a fare you paid
app.post('/api/fares', (req, res) => {
  const { from_place_id, to_place_id, transport_id, amount_paid } = req.body;
  if (!from_place_id || !to_place_id || !transport_id || !(amount_paid > 0)) {
    return res.status(400).json({ error: 'Invalid fare report' });
  }
  db.prepare(
    'INSERT INTO fare_reports (user_id, from_place_id, to_place_id, transport_id, amount_paid) VALUES (1, ?, ?, ?, ?)'
  ).run(from_place_id, to_place_id, transport_id, amount_paid);
  res.json({ ok: true });
});

// Fare estimator
app.get('/api/fare-estimate', (req, res) => {
  const { from, to, transport } = req.query;
  const a = db.prepare('SELECT * FROM places WHERE place_id = ?').get(from);
  const b = db.prepare('SELECT * FROM places WHERE place_id = ?').get(to);
  const t = db.prepare('SELECT * FROM transport_types WHERE transport_id = ?').get(transport);
  if (!a || !b || !t) return res.status(400).json({ error: 'Invalid selection' });

  const km = haversine(a.latitude, a.longitude, b.latitude, b.longitude) * 1.3; // 1.3 = road factor
  const formulaFare = Math.round(t.base_fare + t.per_km * km);

  const r = db
    .prepare(
      `SELECT ROUND(AVG(amount_paid), 0) AS avg, COUNT(*) AS n FROM fare_reports
       WHERE transport_id = ?
       AND ((from_place_id = ? AND to_place_id = ?) OR (from_place_id = ? AND to_place_id = ?))`
    )
    .get(t.transport_id, a.place_id, b.place_id, b.place_id, a.place_id);

  res.json({
    distance_km: Number(km.toFixed(1)),
    formula_fare: formulaFare,
    reported_avg: r.n ? r.avg : null,
    reports: r.n,
  });
});

app.listen(3000, () => console.log('WanderLocal running at http://localhost:3000'));