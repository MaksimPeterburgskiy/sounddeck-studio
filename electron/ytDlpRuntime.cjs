function ytDlpRuntimeOptions(execPath, env = process.env) {
  // Electron supplies Node on every desktop platform, including Windows.
  // Select it explicitly: yt-dlp only enables Deno by default. Keep the path
  // as one spawn argument so installed/portable paths with spaces work.
  return {
    args: ["--no-js-runtimes", "--js-runtimes", `node:${execPath}`],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" }
  };
}

module.exports = { ytDlpRuntimeOptions };
