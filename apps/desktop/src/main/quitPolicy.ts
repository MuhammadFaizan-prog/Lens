/**
 * The two quit decisions main.ts makes, kept pure so the update flow can be unit-tested
 * (test/updater.test.ts):
 *  - the recorder window's "close" hides it to the tray, except while the app is quitting, and in
 *    particular while it quits for an update (fix/updater-014: hiding instead of closing would keep
 *    Lens.exe alive while the installer waits to replace it);
 *  - "before-quit" is cancelled only for the one quit electron-updater queued when the update
 *    installer then failed to start.
 */
export interface QuitFlags {
  quitting: boolean;
  quittingForUpdate: boolean;
}

export function hideToTrayOnClose(f: QuitFlags, isCurrentRecorder: boolean): boolean {
  return isCurrentRecorder && !f.quitting && !f.quittingForUpdate;
}

export function cancelQuit(cancelQueuedQuit: boolean): boolean {
  return cancelQueuedQuit;
}
