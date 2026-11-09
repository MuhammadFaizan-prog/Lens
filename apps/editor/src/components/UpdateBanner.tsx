import { useEffect, useState } from "react";

/**
 * Windows #21: the desktop app's update state in the editor header (the recorder window is often
 * hidden, so a banner only there went unseen). Present only inside the desktop app (editor preload).
 */
interface UpdateUi {
  status: string;
  version?: string;
  percent?: number;
  message?: string;
}
interface Bridge {
  state(): Promise<UpdateUi>;
  check(): Promise<UpdateUi>;
  download(): Promise<UpdateUi>;
  install(): Promise<void>;
  onUpdate(fn: (s: UpdateUi) => void): void;
}

export function UpdateBanner() {
  const api = (window as unknown as { lensUpdates?: Bridge }).lensUpdates;
  const [u, setU] = useState<UpdateUi>({ status: "idle" });
  useEffect(() => {
    if (!api) return;
    void api.state().then(setU);
    api.onUpdate((s) => setU((p) => ({ ...p, ...s })));
  }, [api]);
  if (!api || !["available", "downloading", "downloaded", "error"].includes(u.status)) return null;
  const text =
    u.status === "available" ? `Update available v${u.version}` : u.status === "downloading" ? `Downloading v${u.version}… ${Math.round(u.percent ?? 0)}%` : u.status === "downloaded" ? `v${u.version} is ready` : `Update failed: ${u.message ?? "unknown error"}`;
  const label = u.status === "available" ? "Update" : u.status === "downloaded" ? "Restart to update" : u.status === "error" ? "Retry" : "Update";
  const act = () => {
    if (u.status === "available") void api.download();
    else if (u.status === "downloaded") void api.install();
    else void api.check();
  };
  return (
    <div className="update-banner" data-testid="update-banner" role="status">
      <span data-testid="update-banner-text">{text}</span>
      <button className="btn" data-testid="update-banner-btn" disabled={u.status === "downloading"} onClick={act}>
        {label}
      </button>
    </div>
  );
}
