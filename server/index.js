const app = require('./app');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Surplus-to-Shelter running on http://localhost:${port}`);
});
