const fs = require("fs");
const path = require("path");

// Looks next to the executable first (so a packaged binary picks up the config
// sitting beside it), then cwd, then the repo.
function resolveConfigFile(name) {
  const candidates = [
    path.join(path.dirname(process.execPath), name),
    path.join(process.cwd(), name),
    path.join(__dirname, "..", name),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

module.exports = { resolveConfigFile };
