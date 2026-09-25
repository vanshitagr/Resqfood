const db = require('../server/db');
const app = require('../server/app');

module.exports = async (req, res) => {
  try {
    await db.init();
  } catch (err) {
    console.error('Database initialization failed:', err);
  }
  return app(req, res);
};
