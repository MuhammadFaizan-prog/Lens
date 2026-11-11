/**
 * Share link with bring-your-own storage (demand #13), editor side: the settings form talks to
 * /api/share/* (the keys go to the local server once, on Save, and never come back), and Share
 * uploads the current export (exporting first when there is none for this version of the project).
 */
import type { RenderPlan } from "@lens/engine";

export type ShareProvider = "s3" | "r2" | "supabase" | "custom";

export interface ShareSettings {
  provider: ShareProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  publicBaseUrl: string;
  pathStyle: boolean;
  linkDays: number;
}

export interface ShareConfigView {
  configured: boolean;
  settings: ShareSettings;
  keyHint: string | null;
  hasSecret: boolean;
  keysUnreadable: boolean;
  storage: { kind: "os-keychain" | "local-file"; path: string };
}

export interface ShareJobView {
  id: string;
  exportId: string;
  state: "running" | "done" | "error";
  stage: string;
  sent: number;
  total: number;
  url?: string;
  sha256?: string;
  keys?: { video: string; poster: string; page: string };
  error?: string;
}

export interface ShareState {
  config: ShareConfigView | null;
  /** What is in flight: "save" | "test" | "forget" | "export" | "upload". */
  busy: string | null;
  error: string | null;
  /** Last connection test passed. */
  tested: boolean;
  job: ShareJobView | null;
  copied: boolean;
}

export const EMPTY_SHARE: ShareState = { config: null, busy: null, error: null, tested: false, job: null, copied: false };

/** Provider presets: what the form pre-fills and how the bucket is addressed. */
export const PROVIDERS: Record<ShareProvider, { label: string; endpointHint: string; region: string; pathStyle: boolean; publicHint: string; note: string }> = {
  r2: {
    label: "Cloudflare R2",
    endpointHint: "https://<account-id>.r2.cloudflarestorage.com",
    region: "auto",
    pathStyle: true,
    publicHint: "https://pub-<id>.r2.dev or your custom domain",
    note: "Create an R2 API token with Object Read & Write on the bucket. For links that never expire, enable the bucket's public r2.dev URL or a custom domain and paste it as Public URL.",
  },
  s3: {
    label: "Amazon S3",
    endpointHint: "https://s3.<region>.amazonaws.com",
    region: "us-east-1",
    pathStyle: false,
    publicHint: "https://<bucket>.s3.<region>.amazonaws.com or a CloudFront URL",
    note: "Use an IAM key limited to s3:PutObject / s3:DeleteObject on this bucket. Without a public URL, links are presigned and expire (7 days at most).",
  },
  supabase: {
    label: "Supabase Storage",
    endpointHint: "https://<project-ref>.supabase.co/storage/v1/s3",
    region: "us-east-1",
    pathStyle: true,
    publicHint: "https://<project-ref>.supabase.co/storage/v1/object/public/<bucket>",
    note: "Project Settings → Storage → S3 access keys; the region is your project's region. Supabase may serve .html as plain text from its public URL: put a custom domain or CDN in front, or use presigned links.",
  },
  custom: {
    label: "Other S3-compatible (MinIO, Wasabi, B2…)",
    endpointHint: "https://s3.example.com",
    region: "us-east-1",
    pathStyle: true,
    publicHint: "https://files.example.com/<bucket>",
    note: "Any service that speaks the S3 API with Signature V4.",
  },
};

/** Chapters for the viewer page: project.chapters.items (source ms) mapped onto the output clock. */
export function viewerChapters(project: unknown, plan: RenderPlan | null): Array<{ t: number; title: string }> {
  const items = (project as { chapters?: { items?: Array<{ srcMs?: number; title?: string }> } } | null)?.chapters?.items;
  if (!plan || !Array.isArray(items) || !items.length) return [];
  const fps = plan.output.fps;
  const out: Array<{ t: number; title: string }> = [];
  for (const c of items) {
    if (typeof c?.srcMs !== "number" || typeof c.title !== "string" || !c.title.trim()) continue;
    const i = plan.frames.findIndex((f) => f.src >= c.srcMs! - 0.5);
    if (i < 0) continue;
    const t = i / fps;
    if (out.length && Math.abs(out[out.length - 1]!.t - t) < 1e-6) continue; // two chapters landing on one frame (cut away): keep the first
    out.push({ t, title: c.title.trim() });
  }
  return out;
}
