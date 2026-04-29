import {
  Archive,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  Folder,
  FolderPlus,
  Home,
  LogOut,
  Menu,
  Moon,
  MoreVertical,
  Move,
  Pencil,
  Search,
  Sun,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Role = "viewer" | "admin";
type AuthMode = "none" | "simple" | "oidc";
type Theme = "light" | "dark";

interface User {
  email: string;
  name?: string;
  role: Role;
  provider: AuthMode;
}

interface Entry {
  type: "file" | "folder";
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  etag?: string;
  storageClass?: string;
}

interface AppConfig {
  proxyDownloadsEnabled: boolean;
  defaultPresignSeconds: number;
  maxPresignSeconds: number;
  maxUploadBytes: number | null;
}

interface BrandingConfig {
  name: string;
  iconUrl?: string;
  defaultTheme: Theme;
  version: string;
  showPoweredByFooter: boolean;
}

interface AuthConfig {
  mode: AuthMode;
  oidcLoginButtonText: string;
  loginSubtitle: string;
  app?: BrandingConfig;
}

type Modal =
  | { type: "rename"; entry: Entry; value: string }
  | { type: "move"; entry: Entry; value: string }
  | { type: "folder"; value: string }
  | { type: "metadata"; entry: Entry; metadata?: Record<string, unknown> }
  | { type: "presign"; entry: Entry; seconds: number; url?: string };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: options?.body instanceof FormData ? undefined : { "content-type": "application/json" },
    ...options
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof body === "string" ? body : body.error ?? "Request failed");
  return body as T;
}

function folderPrefix(prefix: string): string {
  const cleaned = prefix.replace(/^\/+/, "");
  if (!cleaned) return "";
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function parentPrefix(prefix: string): string {
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const parts = trimmed.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

function formatBytes(value = 0): string {
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value?: string): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function durationLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr`;
  return `${Math.round(seconds / 86400)} day`;
}

function readLocationState() {
  const params = new URLSearchParams(window.location.search);
  return {
    bucket: params.get("bucket") ?? "",
    prefix: folderPrefix(params.get("prefix") ?? "")
  };
}

function explorerUrl(bucket: string, prefix: string): string {
  const params = new URLSearchParams();
  if (bucket) params.set("bucket", bucket);
  if (prefix) params.set("prefix", folderPrefix(prefix));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function AppMark({ branding, size = 24 }: { branding: BrandingConfig; size?: number }) {
  if (branding.iconUrl) {
    return <img className="app-icon" src={branding.iconUrl} alt="" style={{ width: size, height: size }} />;
  }
  return <Archive size={size} />;
}

function PoweredByFooter({ enabled, version }: { enabled: boolean; version: string }) {
  if (!enabled) return null;
  return (
    <footer className="powered-footer">
      <span>Powered by</span>
      <a href="https://github.com/EdwardJXLi/S3Explorer" target="_blank" rel="noreferrer">
        S3Explorer
      </a>
      {version && <span>v{version}</span>}
    </footer>
  );
}

function LoginView({
  authMode,
  branding,
  oidcLoginButtonText,
  loginSubtitle,
  onLogin
}: {
  authMode: AuthMode;
  branding: BrandingConfig;
  oidcLoginButtonText: string;
  loginSubtitle: string;
  onLogin: (user: User) => void;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/simple/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div>
          <AppMark branding={branding} size={34} />
          <h1>{branding.name}</h1>
          <p>{loginSubtitle}</p>
        </div>

        {authMode === "oidc" ? (
          <a className="primary-button wide" href="/api/auth/oidc/login">
            {oidcLoginButtonText}
          </a>
        ) : (
          <form onSubmit={submit} className="login-form">
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete="current-password"
              />
            </label>
            {error && <div className="error-text">{error}</div>}
            <button className="primary-button wide" type="submit">
              Sign in
            </button>
          </form>
        )}
      </section>
      <PoweredByFooter enabled={branding.showPoweredByFooter} version={branding.version} />
    </main>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("theme");
    return stored === "dark" || stored === "light" ? stored : "light";
  });
  const [authMode, setAuthMode] = useState<AuthMode>("simple");
  const [oidcLoginButtonText, setOidcLoginButtonText] = useState("Continue with SSO");
  const [loginSubtitle, setLoginSubtitle] = useState("Sign in to browse and manage configured buckets.");
  const [branding, setBranding] = useState<BrandingConfig>({
    name: "S3 Explorer",
    defaultTheme: "light",
    version: "0.0.0",
    showPoweredByFooter: true
  });
  const [user, setUser] = useState<User | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [fileLinks, setFileLinks] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const suppressUrlSync = useRef(false);

  const isAdmin = user?.role === "admin";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = branding.name;
  }, [branding.name]);

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".more-menu")) {
        setOpenMenuKey(null);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, []);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const next = readLocationState();
      suppressUrlSync.current = true;
      if (next.bucket) setBucket(next.bucket);
      setPrefix(next.prefix);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [bucket]);

  useEffect(() => {
    setPathInput(prefix);
  }, [prefix]);

  useEffect(() => {
    if (!user || !bucket) return;
    const nextUrl = explorerUrl(bucket, prefix);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl === currentUrl) {
      suppressUrlSync.current = false;
      return;
    }

    if (suppressUrlSync.current) {
      window.history.replaceState(null, "", nextUrl);
      suppressUrlSync.current = false;
    } else {
      window.history.pushState(null, "", nextUrl);
    }
  }, [user, bucket, prefix]);

  useEffect(() => {
    if (user && bucket) void loadObjects(bucket, prefix);
  }, [user, bucket, prefix]);

  useEffect(() => {
    let cancelled = false;
    const files = entries.filter((entry) => entry.type === "file");
    setFileLinks({});
    if (!bucket || !appConfig || files.length === 0) return;

    if (appConfig.proxyDownloadsEnabled) {
      setFileLinks(
        Object.fromEntries(
          files.map((entry) => [
            entry.key,
            `/api/download?${new URLSearchParams({
              bucket,
              key: entry.key
            })}`
          ])
        )
      );
      return;
    }

    void Promise.all(
      files.map(async (entry) => {
        const result = await api<{ url: string; expiresIn: number }>("/api/presign", {
          method: "POST",
          body: JSON.stringify({
            bucket,
            key: entry.key,
            expiresIn: appConfig.defaultPresignSeconds
          })
        });
        return [entry.key, result.url] as const;
      })
    )
      .then((links) => {
        if (!cancelled) setFileLinks(Object.fromEntries(links));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to prepare file links");
      });

    return () => {
      cancelled = true;
    };
  }, [entries, bucket, appConfig]);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return needle ? sorted.filter((entry) => entry.name.toLowerCase().includes(needle)) : sorted;
  }, [entries, query]);

  async function bootstrap() {
    setLoading(true);
    try {
      const auth = await api<AuthConfig>("/api/auth/config");
      setAuthMode(auth.mode);
      setOidcLoginButtonText(auth.oidcLoginButtonText || "Continue with SSO");
      setLoginSubtitle(auth.loginSubtitle || "Sign in to browse and manage configured buckets.");
      if (auth.app) {
        setBranding(auth.app);
        if (!localStorage.getItem("theme")) setTheme(auth.app.defaultTheme);
      }
      const me = await api<{ user: User }>("/api/auth/me");
      setUser(me.user);
      await loadInitialData();
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadInitialData() {
    const [configResult, bucketResult] = await Promise.all([
      api<AppConfig>("/api/config"),
      api<{ buckets: string[]; defaultBucket: string }>("/api/buckets")
    ]);
    setAppConfig(configResult);
    setBuckets(bucketResult.buckets);
    const requested = readLocationState();
    const fallbackBucket = bucketResult.defaultBucket || bucketResult.buckets[0] || "";
    const nextBucket = requested.bucket && bucketResult.buckets.includes(requested.bucket) ? requested.bucket : fallbackBucket;
    const nextPrefix = requested.prefix;
    suppressUrlSync.current = true;
    setBucket((current) => current || nextBucket);
    setPrefix(nextPrefix);
  }

  async function loadObjects(nextBucket = bucket, nextPrefix = prefix, append = false, continuationToken?: string) {
    if (!nextBucket) return;
    setError("");
    setLoading(true);
    if (!append) setFileLinks({});
    try {
      const params = new URLSearchParams({ bucket: nextBucket, prefix: nextPrefix });
      if (continuationToken) params.set("continuationToken", continuationToken);
      const result = await api<{ entries: Entry[]; nextContinuationToken?: string }>(`/api/objects?${params}`);
      setEntries((current) => (append ? [...current, ...result.entries] : result.entries));
      setNextToken(result.nextContinuationToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load objects");
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await loadObjects(bucket, prefix);
  }

  async function presign(entry: Entry, seconds = appConfig?.defaultPresignSeconds ?? 300) {
    const result = await api<{ url: string; expiresIn: number }>("/api/presign", {
      method: "POST",
      body: JSON.stringify({ bucket, key: entry.key, expiresIn: seconds })
    });
    return result.url;
  }

  async function openEntry(entry: Entry) {
    setOpenMenuKey(null);
    if (entry.type === "folder") {
      setPrefix(entry.key);
      return;
    }
    const href = fileLinks[entry.key] || (await presign(entry));
    window.open(href, "_blank", "noopener,noreferrer");
  }

  async function uploadFile(file: File) {
    const form = new FormData();
    form.append("bucket", bucket);
    form.append("key", `${folderPrefix(prefix)}${file.name}`);
    form.append("file", file);
    await api<{ key: string }>("/api/upload", { method: "POST", body: form });
    setNotice(`Uploaded ${file.name}`);
    await refresh();
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    setUser(null);
  }

  async function submitModal() {
    if (!modal) return;
    if (modal.type === "folder") {
      await api("/api/folders", {
        method: "POST",
        body: JSON.stringify({ bucket, prefix: `${folderPrefix(prefix)}${modal.value}` })
      });
    }
    if (modal.type === "rename") {
      await api("/api/rename", {
        method: "POST",
        body: JSON.stringify({ bucket, type: modal.entry.type, key: modal.entry.key, name: modal.value })
      });
    }
    if (modal.type === "move") {
      await api("/api/move", {
        method: "POST",
        body: JSON.stringify({ bucket, type: modal.entry.type, fromKey: modal.entry.key, toKey: modal.value })
      });
    }
    setModal(null);
    await refresh();
  }

  async function deleteEntry(entry: Entry) {
    setOpenMenuKey(null);
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    await api("/api/objects", {
      method: "DELETE",
      body: JSON.stringify({ bucket, type: entry.type, key: entry.key })
    });
    await refresh();
  }

  async function showMetadata(entry: Entry) {
    const metadata =
      entry.type === "file"
        ? await api<Record<string, unknown>>(`/api/metadata?${new URLSearchParams({ bucket, key: entry.key })}`)
        : { key: entry.key, type: "folder prefix" };
    setModal({ type: "metadata", entry, metadata });
    setOpenMenuKey(null);
  }

  async function createPresignUrl() {
    if (!modal || modal.type !== "presign") return;
    const url = await presign(modal.entry, modal.seconds);
    setModal({ ...modal, url });
  }

  if (loading && !user) return <div className="loading-screen">Loading...</div>;
  if (!user) {
    return (
      <LoginView
        authMode={authMode}
        branding={branding}
        oidcLoginButtonText={oidcLoginButtonText}
        loginSubtitle={loginSubtitle}
        onLogin={(nextUser) => {
          setUser(nextUser);
          void loadInitialData();
        }}
      />
    );
  }

  const crumbs = prefix.split("/").filter(Boolean);
  const renderBucketItems = () =>
    buckets.map((item) => (
      <button
        key={item}
        className={item === bucket ? "bucket active" : "bucket"}
        onClick={() => {
          setBucket(item);
          setPrefix("");
          setMobileSidebarOpen(false);
        }}
      >
        <Archive size={16} />
        <span>{item}</span>
      </button>
    ));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <AppMark branding={branding} size={24} />
          <span>{branding.name}</span>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">Buckets</div>
          <div className="bucket-list">{renderBucketItems()}</div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label="Open bucket menu"
            aria-expanded={mobileSidebarOpen}
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="pathbar">
            <button className="crumb root" onClick={() => setPrefix("")}>
              <Home size={16} />
            </button>
            {bucket && <span className="mobile-bucket-name">{bucket}</span>}
            {crumbs.map((crumb, index) => {
              const nextPrefix = `${crumbs.slice(0, index + 1).join("/")}/`;
              return (
                <span className="crumb-pair" key={nextPrefix}>
                  <ChevronRight size={15} />
                  <button className="crumb" onClick={() => setPrefix(nextPrefix)}>
                    {crumb}
                  </button>
                </span>
              );
            })}
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="user-chip">
              <span>{user.name || user.email}</span>
              <strong>{user.role}</strong>
            </div>
            <button className="icon-button" onClick={logout} aria-label="Sign out">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <section className="toolbar">
          <form
            className="path-input"
            onSubmit={(event) => {
              event.preventDefault();
              setPrefix(folderPrefix(pathInput));
            }}
          >
            <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="Go to path" />
          </form>
          <label className="search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter current folder" />
          </label>
          <div className="toolbar-actions">
            <button className="secondary-button" onClick={() => setPrefix(parentPrefix(prefix))} disabled={!prefix}>
              Up
            </button>
            {isAdmin && (
              <>
                <button className="secondary-button" onClick={() => setModal({ type: "folder", value: "" })}>
                  <FolderPlus size={16} />
                  New folder
                </button>
                <button className="primary-button" onClick={() => fileInput.current?.click()}>
                  <Upload size={16} />
                  Upload
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void uploadFile(file);
                  }}
                />
              </>
            )}
          </div>
        </section>

        {error && <div className="banner error">{error}</div>}
        {notice && (
          <button className="banner notice" onClick={() => setNotice("")}>
            {notice}
          </button>
        )}

        <section className="file-surface">
          <div className="table-head">
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
            <span>Actions</span>
          </div>
          <div className="file-list">
            {visibleEntries.map((entry) => (
              <div
                className="file-row"
                data-entry-type={entry.type}
                key={`${entry.type}:${entry.key}`}
                onDoubleClick={() => void openEntry(entry)}
              >
                <button className="name-cell" onClick={() => void openEntry(entry)}>
                  {entry.type === "folder" ? <Folder size={20} /> : <File size={20} />}
                  <span>{entry.name}</span>
                </button>
                <span className="muted">{entry.type === "file" ? formatBytes(entry.size) : "-"}</span>
                <span className="muted">{formatDate(entry.lastModified)}</span>
                <div className="row-actions">
                  {entry.type === "file" && (
                    <>
                      <a
                        className="icon-button"
                        title="Open"
                        aria-label={`Open ${entry.name}`}
                        href={fileLinks[entry.key]}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                          setOpenMenuKey(null);
                          if (!fileLinks[entry.key]) event.preventDefault();
                        }}
                      >
                        <ExternalLink size={17} />
                      </a>
                      <a
                        className="icon-button"
                        title="Download"
                        aria-label={`Download ${entry.name}`}
                        href={fileLinks[entry.key]}
                        target="_blank"
                        rel="noreferrer"
                        download={entry.name}
                        onClick={(event) => {
                          setOpenMenuKey(null);
                          if (!fileLinks[entry.key]) event.preventDefault();
                        }}
                      >
                        <Download size={17} />
                      </a>
                    </>
                  )}
                  <div className="more-menu">
                    <button
                      className="icon-button"
                      title="More options"
                      aria-label={`More options for ${entry.name}`}
                      aria-expanded={openMenuKey === `${entry.type}:${entry.key}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuKey((current) =>
                          current === `${entry.type}:${entry.key}` ? null : `${entry.type}:${entry.key}`
                        );
                      }}
                    >
                      <MoreVertical size={17} />
                    </button>
                    {openMenuKey === `${entry.type}:${entry.key}` && (
                      <div className="menu-panel" role="menu">
                        {entry.type === "file" && (
                          <button
                            role="menuitem"
                            onClick={() => {
                              setModal({ type: "presign", entry, seconds: appConfig?.defaultPresignSeconds ?? 300 });
                              setOpenMenuKey(null);
                            }}
                          >
                            <Copy size={15} />
                            Presigned URL
                          </button>
                        )}
                        <button role="menuitem" onClick={() => void showMetadata(entry)}>
                          <Archive size={15} />
                          Metadata
                        </button>
                        {isAdmin && (
                          <>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setModal({ type: "rename", entry, value: entry.name });
                                setOpenMenuKey(null);
                              }}
                            >
                              <Pencil size={15} />
                              Rename
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setModal({ type: "move", entry, value: entry.key });
                                setOpenMenuKey(null);
                              }}
                            >
                              <Move size={15} />
                              Move
                            </button>
                            <button className="danger" role="menuitem" onClick={() => void deleteEntry(entry)}>
                              <Trash2 size={15} />
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {!loading && visibleEntries.length === 0 && <div className="empty-state">No objects in this folder.</div>}
            {loading && <div className="empty-state">Loading objects...</div>}
          </div>
          {nextToken && (
            <div className="load-more">
              <button className="secondary-button" onClick={() => void loadObjects(bucket, prefix, true, nextToken)}>
                Load more
              </button>
            </div>
          )}
        </section>
        <PoweredByFooter enabled={branding.showPoweredByFooter} version={branding.version} />
      </main>

      {mobileSidebarOpen && (
        <div className="mobile-sidebar-backdrop" onMouseDown={() => setMobileSidebarOpen(false)}>
          <aside className="mobile-sidebar-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mobile-sidebar-head">
              <div className="brand">
                <AppMark branding={branding} size={24} />
                <span>{branding.name}</span>
              </div>
              <button className="icon-button" aria-label="Close bucket menu" onClick={() => setMobileSidebarOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-heading">Buckets</div>
              <div className="bucket-list">{renderBucketItems()}</div>
            </div>
          </aside>
        </div>
      )}

      {modal && (
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            {modal.type === "metadata" ? (
              <>
                <h2>Metadata</h2>
                <pre>{JSON.stringify(modal.metadata, null, 2)}</pre>
                <button className="primary-button" onClick={() => setModal(null)}>
                  Done
                </button>
              </>
            ) : modal.type === "presign" ? (
              <>
                <h2>Presigned URL</h2>
                <div className="duration-grid">
                  {[300, 1800, 3600, 10800, 18000, 43200, 86400, 604800].map((seconds) => (
                    <button
                      key={seconds}
                      className={modal.seconds === seconds ? "chip active" : "chip"}
                      onClick={() => setModal({ ...modal, seconds })}
                    >
                      {durationLabel(seconds)}
                    </button>
                  ))}
                </div>
                <label>
                  Seconds
                  <input
                    type="number"
                    min={60}
                    max={appConfig?.maxPresignSeconds}
                    value={modal.seconds}
                    onChange={(event) => setModal({ ...modal, seconds: Number(event.target.value) })}
                  />
                </label>
                {modal.url && (
                  <div className="url-box">
                    <input readOnly value={modal.url} />
                    <button className="icon-button" onClick={() => void navigator.clipboard.writeText(modal.url ?? "")}>
                      <Copy size={17} />
                    </button>
                  </div>
                )}
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setModal(null)}>
                    Cancel
                  </button>
                  <button className="primary-button" onClick={() => void createPresignUrl()}>
                    Generate
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>{modal.type === "folder" ? "New folder" : modal.type === "rename" ? "Rename" : "Move"}</h2>
                <label>
                  {modal.type === "rename" ? "Name" : "Path"}
                  <input
                    autoFocus
                    value={modal.value}
                    onChange={(event) => setModal({ ...modal, value: event.target.value } as Modal)}
                  />
                </label>
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setModal(null)}>
                    Cancel
                  </button>
                  <button className="primary-button" onClick={() => void submitModal()} disabled={!modal.value.trim()}>
                    Save
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
