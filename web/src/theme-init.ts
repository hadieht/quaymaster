// Runs before first paint (separate module so the strict CSP needs no inline script).
const stored = localStorage.getItem('qm-theme');
const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);
