import type { FastifyInstance } from "fastify";
import {
  createFolder,
  deleteObject,
  deletePrefix,
  folderPrefix,
  getMetadata,
  getObjectStream,
  listBuckets,
  listObjects,
  moveObject,
  movePrefix,
  objectName,
  presignDownload,
  uploadObject
} from "./storage.js";
import { config } from "./config.js";
import { requireAdmin, requireUser } from "./auth.js";

function parentPrefix(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const parts = trimmed.split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

function joinKey(prefix: string, name: string): string {
  return `${folderPrefix(prefix)}${name.replace(/^\/+/, "")}`;
}

export async function registerApiRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async (request, reply) => {
    if (!(await requireUser(request, reply))) return;
    return {
      proxyDownloadsEnabled: config.storage.proxyDownloadsEnabled,
      defaultPresignSeconds: config.storage.defaultPresignSeconds,
      maxPresignSeconds: config.storage.maxPresignSeconds,
      maxUploadBytes: config.storage.maxUploadBytes ?? null
    };
  });

  app.get("/api/buckets", async (request, reply) => {
    if (!(await requireUser(request, reply))) return;
    const buckets = await listBuckets();
    return {
      buckets,
      defaultBucket: config.storage.defaultBucket ?? buckets[0] ?? ""
    };
  });

  app.get<{ Querystring: { bucket?: string; prefix?: string; continuationToken?: string } }>(
    "/api/objects",
    async (request, reply) => {
      if (!(await requireUser(request, reply))) return;
      if (!request.query.bucket) return reply.code(400).send({ error: "bucket is required" });
      return listObjects(request.query.bucket, request.query.prefix, request.query.continuationToken);
    }
  );

  app.get<{ Querystring: { bucket?: string; key?: string } }>("/api/metadata", async (request, reply) => {
    if (!(await requireUser(request, reply))) return;
    if (!request.query.bucket || !request.query.key) return reply.code(400).send({ error: "bucket and key are required" });
    return getMetadata(request.query.bucket, request.query.key);
  });

  app.post<{ Body: { bucket?: string; key?: string; expiresIn?: number } }>("/api/presign", async (request, reply) => {
    if (!(await requireUser(request, reply))) return;
    const { bucket, key, expiresIn } = request.body ?? {};
    if (!bucket || !key) return reply.code(400).send({ error: "bucket and key are required" });
    return presignDownload(bucket, key, expiresIn ?? config.storage.defaultPresignSeconds);
  });

  app.get<{ Querystring: { bucket?: string; key?: string } }>("/api/download", async (request, reply) => {
    if (!(await requireUser(request, reply))) return;
    if (!config.storage.proxyDownloadsEnabled) return reply.code(404).send({ error: "Proxy downloads are disabled" });
    if (!request.query.bucket || !request.query.key) return reply.code(400).send({ error: "bucket and key are required" });

    const object = await getObjectStream(request.query.bucket, request.query.key);
    reply.header("content-disposition", `attachment; filename="${objectName(request.query.key).replaceAll('"', "")}"`);
    if (object.contentType) reply.type(object.contentType);
    if (object.contentLength != null) reply.header("content-length", object.contentLength);
    if (object.etag) reply.header("etag", object.etag);
    if (object.lastModified) reply.header("last-modified", object.lastModified.toUTCString());
    return reply.send(object.body);
  });

  app.post("/api/upload", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    let bucket = "";
    let key = "";
    let uploadedKey = "";

    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "bucket") bucket = String(part.value ?? "");
        if (part.fieldname === "key") key = String(part.value ?? "");
        continue;
      }

      if (!bucket || !key) return reply.code(400).send({ error: "bucket and key fields must be sent before file" });
      const result = await uploadObject(bucket, key, part.file, part.filename, part.mimetype);
      uploadedKey = result.key;
    }

    if (!uploadedKey) return reply.code(400).send({ error: "file is required" });
    return { key: uploadedKey };
  });

  app.post<{ Body: { bucket?: string; prefix?: string } }>("/api/folders", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { bucket, prefix } = request.body ?? {};
    if (!bucket || !prefix) return reply.code(400).send({ error: "bucket and prefix are required" });
    return createFolder(bucket, prefix);
  });

  app.post<{ Body: { bucket?: string; type?: "file" | "folder"; fromKey?: string; toKey?: string } }>(
    "/api/move",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { bucket, type, fromKey, toKey } = request.body ?? {};
      if (!bucket || !type || !fromKey || !toKey) {
        return reply.code(400).send({ error: "bucket, type, fromKey, and toKey are required" });
      }
      return type === "folder" ? movePrefix(bucket, fromKey, toKey) : moveObject(bucket, fromKey, toKey);
    }
  );

  app.post<{ Body: { bucket?: string; type?: "file" | "folder"; key?: string; name?: string } }>(
    "/api/rename",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { bucket, type, key, name } = request.body ?? {};
      if (!bucket || !type || !key || !name) return reply.code(400).send({ error: "bucket, type, key, and name are required" });
      const destination = type === "folder" ? folderPrefix(joinKey(parentPrefix(key), name)) : joinKey(parentPrefix(key), name);
      return type === "folder" ? movePrefix(bucket, key, destination) : moveObject(bucket, key, destination);
    }
  );

  app.delete<{ Body: { bucket?: string; type?: "file" | "folder"; key?: string } }>("/api/objects", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { bucket, type, key } = request.body ?? {};
    if (!bucket || !type || !key) return reply.code(400).send({ error: "bucket, type, and key are required" });
    return type === "folder" ? deletePrefix(bucket, key) : deleteObject(bucket, key);
  });
}
