// Contexts (tabs) per browser process. Below ~3 the browser overhead dominates,
// above ~5 a renderer crash takes out too much and the tabs fight for CPU.
const CONTEXTS_PER_BROWSER = 4;

module.exports = { CONTEXTS_PER_BROWSER };
