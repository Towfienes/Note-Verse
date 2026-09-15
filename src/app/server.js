const { createApplication } = require("./src/application");

const application = createApplication();
application.server.listen(application.config.port, () => {
  console.log(`NoteVerse is running at ${application.config.baseUrl}`);
  if (application.config.demoMode) console.log("Demo mode is enabled.");
});

function shutdown() {
  for (const client of application.realtime.wss.clients) client.terminate();
  application.server.close(() => {
    application.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
