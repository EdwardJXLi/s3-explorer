import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { lookup as lookupMime } from "mime-types";
import { Readable } from "node:stream";
import { config } from "./config.js";
import type { ExplorerEntry } from "./types.js";

const client = new S3Client({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  forcePathStyle: config.storage.forcePathStyle,
  credentials:
    config.storage.accessKeyId && config.storage.secretAccessKey
      ? {
          accessKeyId: config.storage.accessKeyId,
          secretAccessKey: config.storage.secretAccessKey,
          sessionToken: config.storage.sessionToken
        }
      : undefined
});

export function cleanKey(key: string): string {
  return key.replace(/^\/+/, "");
}

export function folderPrefix(prefix: string): string {
  const cleaned = cleanKey(prefix);
  if (!cleaned) return "";
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

export function objectName(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.split("/").filter(Boolean).pop() ?? trimmed;
}

export async function listBuckets(): Promise<string[]> {
  if (config.storage.buckets.length > 0) return config.storage.buckets;
  if (!config.storage.allowBucketList) return config.storage.defaultBucket ? [config.storage.defaultBucket] : [];

  const result = await client.send(new ListBucketsCommand({}));
  return (result.Buckets ?? [])
    .map((bucket) => bucket.Name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b));
}

export async function listObjects(bucket: string, prefix = "", continuationToken?: string) {
  const normalizedPrefix = folderPrefix(prefix);
  const result = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: normalizedPrefix,
      Delimiter: "/",
      MaxKeys: 200,
      ContinuationToken: continuationToken
    })
  );

  const folders: ExplorerEntry[] = (result.CommonPrefixes ?? [])
    .map((entry) => entry.Prefix)
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => ({
      type: "folder" as const,
      key: entry,
      name: objectName(entry)
    }));

  const files: ExplorerEntry[] = (result.Contents ?? [])
    .filter((entry) => entry.Key && entry.Key !== normalizedPrefix)
    .map((entry) => ({
      type: "file" as const,
      key: entry.Key!,
      name: objectName(entry.Key!),
      size: entry.Size ?? 0,
      lastModified: entry.LastModified?.toISOString(),
      etag: entry.ETag?.replaceAll('"', ""),
      storageClass: entry.StorageClass
    }));

  return {
    bucket,
    prefix: normalizedPrefix,
    entries: [...folders, ...files],
    nextContinuationToken: result.NextContinuationToken
  };
}

export async function getMetadata(bucket: string, key: string) {
  const result = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: cleanKey(key)
    })
  );

  return {
    key: cleanKey(key),
    contentType: result.ContentType,
    contentLength: result.ContentLength,
    lastModified: result.LastModified?.toISOString(),
    etag: result.ETag?.replaceAll('"', ""),
    cacheControl: result.CacheControl,
    contentDisposition: result.ContentDisposition,
    contentEncoding: result.ContentEncoding,
    storageClass: result.StorageClass,
    serverSideEncryption: result.ServerSideEncryption,
    versionId: result.VersionId,
    expires: result.Expires?.toISOString(),
    metadata: result.Metadata ?? {}
  };
}

export async function presignDownload(bucket: string, key: string, expiresIn: number) {
  const seconds = Math.max(60, Math.min(expiresIn, config.storage.maxPresignSeconds));
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: cleanKey(key)
  });
  return {
    url: await getSignedUrl(client, command, { expiresIn: seconds }),
    expiresIn: seconds
  };
}

export async function getObjectStream(bucket: string, key: string) {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: cleanKey(key)
    })
  );
  return {
    body: result.Body as Readable,
    contentType: result.ContentType,
    contentLength: result.ContentLength,
    etag: result.ETag,
    lastModified: result.LastModified
  };
}

export async function uploadObject(bucket: string, key: string, stream: Readable, filename?: string, contentType?: string) {
  const finalKey = cleanKey(key);
  const inferredType = contentType || (filename ? lookupMime(filename) || undefined : undefined);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: finalKey,
      Body: stream,
      ContentType: inferredType
    })
  );
  return { key: finalKey };
}

export async function createFolder(bucket: string, prefix: string) {
  const key = folderPrefix(prefix);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: ""
    })
  );
  return { key };
}

export async function deleteObject(bucket: string, key: string) {
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: [{ Key: cleanKey(key) }]
      }
    })
  );
}

async function listAllKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token
      })
    );
    for (const item of result.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    token = result.NextContinuationToken;
  } while (token);
  return keys;
}

export async function deletePrefix(bucket: string, prefix: string) {
  const finalPrefix = folderPrefix(prefix);
  const keys = await listAllKeys(bucket, finalPrefix);
  if (keys.length === 0) return { deleted: 0 };

  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true
        }
      })
    );
  }

  return { deleted: keys.length };
}

async function copyObject(bucket: string, fromKey: string, toKey: string) {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeURIComponent(`${bucket}/${fromKey}`).replaceAll("%2F", "/"),
      Key: toKey,
      MetadataDirective: "COPY"
    })
  );
}

export async function moveObject(bucket: string, fromKey: string, toKey: string) {
  const source = cleanKey(fromKey);
  const target = cleanKey(toKey);
  if (!source || !target || source === target) return { key: target };

  await copyObject(bucket, source, target);
  await deleteObject(bucket, source);
  return { key: target };
}

export async function movePrefix(bucket: string, fromPrefix: string, toPrefix: string) {
  const sourcePrefix = folderPrefix(fromPrefix);
  const targetPrefix = folderPrefix(toPrefix);
  if (!sourcePrefix || !targetPrefix || sourcePrefix === targetPrefix) return { moved: 0 };

  const keys = await listAllKeys(bucket, sourcePrefix);
  for (const key of keys) {
    const nextKey = `${targetPrefix}${key.slice(sourcePrefix.length)}`;
    await copyObject(bucket, key, nextKey);
  }
  await deletePrefix(bucket, sourcePrefix);
  return { moved: keys.length };
}
