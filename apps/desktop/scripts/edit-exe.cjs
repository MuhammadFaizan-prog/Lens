// electron-builder afterPack hook (scripts/dist-win.mjs): writes the Lens icon and version info into
// Lens.exe. electron-builder normally does this with rcedit, which on Linux needs wine; that step is off
// (signAndEditExecutable: false), so without this hook Lens.exe kept Electron's atom icon and
// "Electron" version strings (0.1.0). resedit edits the PE resources in pure JS on any host.
// The icon is the same multi-size .ico the installer uses (LENS_ICON, set by dist-win.mjs).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const LANG = 1033; // en-US
const CODEPAGE = 1200; // UTF-16

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const ResEdit = await import("resedit");
  const info = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const iconFile = process.env.LENS_ICON;
  if (!iconFile || !fs.existsSync(iconFile)) throw new Error(`edit-exe: LENS_ICON not found (${iconFile})`);

  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);

  // icon: replace every icon group (Electron ships one, id 1) with ours; Windows shows the first group
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(iconFile));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const ids = groups.length ? groups.map((g) => ({ id: g.id, lang: g.lang })) : [{ id: 1, lang: LANG }];
  for (const { id, lang } of ids)
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map((i) => i.data));

  // version info: product / file description / company / version (Explorer, Task Manager, taskbar tooltip)
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const v = vi ?? ResEdit.Resource.VersionInfo.createEmpty();
  const [maj, min, pat] = info.version.split(/[.-]/).map((n) => Number(n) || 0);
  v.setFileVersion(maj, min, pat, 0, LANG);
  v.setProductVersion(maj, min, pat, 0, LANG);
  const langs = v.getAllLanguagesForStringValues();
  for (const l of langs.length ? langs : [{ lang: LANG, codepage: CODEPAGE }]) {
    v.setStringValues(l, {
      ProductName: info.productName,
      FileDescription: info.productName,
      CompanyName: info.companyName ?? "MuhammadFaizan-prog",
      LegalCopyright: info.copyright,
      FileVersion: info.version,
      ProductVersion: info.version,
      InternalName: info.productFilename,
      OriginalFilename: `${info.productFilename}.exe`,
    });
  }
  v.outputToResourceEntries(res.entries);

  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log(`  • Lens.exe resources edited  icon=${path.basename(iconFile)} (${ico.icons.length} sizes) version=${info.version}`);
};
