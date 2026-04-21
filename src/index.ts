import { env } from "./config/env.js";
import { buildServer } from "./server.js";

async function start(): Promise<void> {
  const app = await buildServer();

  try {
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
}

void start();
