// Runs before the page draws, so a saved theme shows without a flash of the other one.
// With no saved choice, the page follows the system theme.
try {
  const theme = localStorage.getItem('companion-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be blocked; the system theme still applies.
}
