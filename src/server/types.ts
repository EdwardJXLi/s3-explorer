export type Role = "viewer" | "admin";

export interface AuthUser {
  email: string;
  name?: string;
  role: Role;
  provider: "none" | "simple" | "oidc";
}

export interface ObjectEntry {
  type: "file";
  key: string;
  name: string;
  size: number;
  lastModified?: string;
  etag?: string;
  storageClass?: string;
}

export interface FolderEntry {
  type: "folder";
  key: string;
  name: string;
}

export type ExplorerEntry = ObjectEntry | FolderEntry;
