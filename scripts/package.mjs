import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "release", "digup");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
await writeFile(
  path.join(destination, "package.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await cp(path.join(root, "assets"), path.join(destination, "assets"), {
  recursive: true,
  verbatimSymlinks: true,
});
for (const file of ["LICENSE", "NOTICE", "README.md"]) {
  await cp(path.join(root, file), path.join(destination, file));
}
for (const file of await readdir(path.join(root, "dist"))) {
  if (file.endsWith(".js"))
    await cp(path.join(root, "dist", file), path.join(destination, file));
}
console.log(`Import into Tinycast: ${destination}`);
