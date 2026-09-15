const { loadConfig } = require("../src/config");
const { createDatabase, seedDemoData } = require("../src/database");

const config = loadConfig();
if (!config.demoMode) {
  console.error("Refusing to seed demo accounts unless DEMO_MODE=true.");
  process.exitCode = 1;
} else {
  const db = createDatabase(config);
  const created = seedDemoData(db);
  db.close();
  console.log(
    created ? "Demo accounts and notes created." : "Demo accounts already exist; nothing changed.",
  );
}
