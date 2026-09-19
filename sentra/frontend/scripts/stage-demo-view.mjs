// Puts the /demo-view static export into public/ for an ordinary build, and
// keeps it out of a pilot build. Runs as the first half of `npm run build`.
//
// demo-view-export/ is a demo (fixtures, demo mode baked in), built on the
// chat-ui-redesign branch by scripts/build-demo-view.sh. A dedicated research
// deployment must carry no demo surface (#193), and routing rules cannot
// promise that for static files: Vercel matches rewrites against the raw path
// but serves files by the decoded one, so /%64emo-view/index.html walks past any
// rule written for /demo-view. A pilot build therefore never has the files.
//
// public/demo-view is gitignored, so a fresh checkout has nothing there unless
// this step copies it in: a build that skips it ships no demo either.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function stageDemoView({ root, pilot }) {
  const source = join(root, "demo-view-export");
  const target = join(root, "public", "demo-view");
  rmSync(target, { recursive: true, force: true });
  if (pilot) return "left out of this pilot build";
  if (!existsSync(source)) return "no export to stage";
  cpSync(source, target, { recursive: true });
  return "staged into public/demo-view";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  console.log(`demo-view: ${stageDemoView({ root, pilot: process.env.NEXT_PUBLIC_PILOT_MODE === "1" })}`);
}
