const markerPath = Bun.argv[2];
const pidPath = Bun.argv[3];

if (markerPath === undefined || pidPath === undefined) {
  throw new Error("Marker and PID paths are required");
}

const child = Bun.spawn(
  [process.execPath, fileURLToPath(import.meta.resolve("./process-tree-child.ts")), markerPath],
  {
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  },
);

await Bun.write(pidPath, String(child.pid));
setInterval(() => undefined, 1_000);
import { fileURLToPath } from "node:url";
