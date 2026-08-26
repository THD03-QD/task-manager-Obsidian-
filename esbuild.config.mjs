import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/main.js",
  format: "cjs",
  target: "es2018",
  platform: "browser",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  console.log("Build complete -> dist/main.js");
} else {
  await context.watch();
}
