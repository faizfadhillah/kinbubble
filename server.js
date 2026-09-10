'use strict';
const app = require('./app');
const db = require('./db');
const PORT = process.env.PORT || 3000;
db.ready().then(() => app.listen(PORT, () => console.log(`KinBubble running on http://localhost:${PORT}  (db: ${db.dialect})`)))
  .catch(err => { console.error('Database init failed:', err); process.exit(1); });
