import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAuthRoutes } from "./auth.js";
import { config, validateConfig } from "./config.js";
import { registerApiRoutes } from "./routes.js";

const problems = validateConfig();
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

const app = Fastify({
  logger: true,
  trustProxy: config.trustProxy
});

await app.register(cookie);
await app.register(multipart, {
  limits: {
    fileSize: config.storage.maxUploadBytes,
    files: 1
  }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const metadataStatus =
    typeof error === "object" &&
    error &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata &&
    "httpStatusCode" in error.$metadata
      ? Number(error.$metadata.httpStatusCode)
      : undefined;
  const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : metadataStatus;
  const message = error instanceof Error ? error.message : "Request failed";
  const status = statusCode && statusCode >= 400 ? statusCode : 500;
  reply.code(status).send({
    error: status === 500 ? "Unexpected server error" : message
  });
});

await registerAuthRoutes(app);
await registerApiRoutes(app);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, "../client");

await app.register(staticFiles, {
  root: clientRoot,
  prefix: "/",
  wildcard: false
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/")) {
    return reply.code(404).send({ error: "Not found" });
  }
  return reply.sendFile("index.html");
});

await app.listen({ host: config.host, port: config.port });
