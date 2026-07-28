import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const assetsDirectory = new URL("../dist/assets/", import.meta.url);
const files = await readdir(assetsDirectory);

await Promise.all(
  files
    .filter((file) => file.endsWith(".js"))
    .map(async (file) => {
      const path = fileURLToPath(new URL(file, assetsDirectory));
      const source = await readFile(path, "utf8");
      const result = await transform(source, {
        target: "chrome69",
        format: "esm",
        minify: true,
        legalComments: "none",
      });
      await writeFile(path, result.code);
    }),
);
