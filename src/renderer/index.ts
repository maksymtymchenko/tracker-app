async function init() {
  const statusEl = document.getElementById('status') as HTMLDivElement;
  const userEl = document.getElementById('user') as HTMLDivElement;
  const versionEl = document.getElementById('version') as HTMLSpanElement;
  const statusBadge = document.getElementById('statusBadge') as HTMLSpanElement;

  // Ensure version text is bold even if template changes
  if (versionEl) {
    versionEl.style.fontWeight = '700';
  }

  try {
    const username = await window.tracker.getUsername();
    userEl.textContent = username || 'Unknown user';
    statusEl.textContent = 'Ready';
  } catch (e) {
    statusEl.textContent = 'Failed to load username';
    console.error('Failed to load username:', e);
  }

  try {
    const version = await window.tracker.getVersion();
    versionEl.textContent = `v${version}`;
  } catch (e) {
    versionEl.textContent = 'v?.?.?';
    console.error('Failed to load version:', e);
  }

  const updateBadge = (text: string) => {
    statusEl.textContent = text;
    statusBadge.textContent = text;
    // simple mapping to colorize badge
    // Increased size and padding to handle longer text like "Tracking active (1 pending)"
    const base = 'inline-flex items-center rounded-full px-3 py-1.5 text-sm whitespace-nowrap';
    if (/started/i.test(text) || /sent/i.test(text) || /active/i.test(text)) {
      statusBadge.className = `${base} bg-green-600 text-white`;
    } else if (/stopped/i.test(text) || /error/i.test(text) || /fail/i.test(text)) {
      statusBadge.className = `${base} bg-rose-600/15 text-rose-400`;
    } else {
      statusBadge.className = `${base} bg-slate-800 text-slate-300`;
    }
  };

  window.tracker.onStatus((s) => updateBadge(s));
}

init();

