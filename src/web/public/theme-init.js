(() => {
  try {
    const theme = localStorage.getItem('chronicle-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch {
    // System theme remains the safe default when storage is unavailable.
  }
})();
