// Runs the unit tests.
//
// Node only learned to expand glob patterns in `--test` arguments in v21, and
// handing it a directory doesn't work either, so discover the files here and
// pass explicit paths. That works on every Node version, and on Windows, where
// the shell won't expand a glob for us.
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = join(__dirname, "unit");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error("No unit tests found in test/unit");
  process.exit(1);
}

const { status, error } = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
if (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(status === null ? 1 : status);
