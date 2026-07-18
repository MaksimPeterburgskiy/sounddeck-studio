function createUpdateInstallLifecycle({ setWindowCloseAllowed, isShuttingDown }) {
  let installPending = false;

  function resetAfterFailure() {
    if (!installPending) return false;

    installPending = false;
    if (!isShuttingDown()) setWindowCloseAllowed(false);
    return true;
  }

  function requestInstall(quitAndInstall) {
    if (installPending) return false;

    installPending = true;
    setWindowCloseAllowed(true);
    try {
      quitAndInstall();
      // electron-updater emits some startup failures synchronously.
      return installPending;
    } catch (error) {
      resetAfterFailure();
      throw error;
    }
  }

  return { requestInstall, resetAfterFailure };
}

module.exports = { createUpdateInstallLifecycle };
