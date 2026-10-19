// Copy an extension folder to a temporary directory for a test run, leaving out the personal, git-ignored
// configs/profile.default.json, so a test never loads or seeds a real profile by accident. Pass `profile` to write a
// test profile in its place instead, which exercises the service worker's seeding path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const stageExtension = (extDir, { profile = null, tag = "ext" } = {}) => {
  const src = path.resolve(extDir);
  if (!fs.existsSync(path.join(src, "manifest.json"))) throw new Error(`no manifest.json in ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `autobot-${tag}-`));
  const personal = path.join(src, "configs", "profile.default.json");
  fs.cpSync(src, dir, { recursive: true, filter: (p) => path.resolve(p) !== personal });
  if (profile) fs.writeFileSync(path.join(dir, "configs", "profile.default.json"), JSON.stringify(profile, null, 2));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
