async function init() {
  const statusEl = document.getElementById('status')!;
  const userEl = document.getElementById('user')!;
  const statusBadge = document.getElementById('statusBadge') as HTMLSpanElement;

  try {
    const username = await window.tracker.getUsername();
    userEl.textContent = username || 'Unknown user';
    statusEl.textContent = 'Ready';
  } catch (e) {
    statusEl.textContent = 'Failed to load username';
    console.error('Failed to load username:', e);
  }

  const updateBadge = (text: string) => {
    statusEl.textContent = text;
    statusBadge.textContent = text;
    // simple mapping to colorize badge
    const base = 'inline-flex items-center rounded-full px-2.5 py-1 text-xs';
    if (/started/i.test(text) || /sent/i.test(text)) {
      statusBadge.className = `${base} bg-emerald-600/15 text-emerald-400`;
    } else if (/stopped/i.test(text) || /error/i.test(text) || /fail/i.test(text)) {
      statusBadge.className = `${base} bg-rose-600/15 text-rose-400`;
    } else {
      statusBadge.className = `${base} bg-slate-800 text-slate-300`;
    }
  };

  window.tracker.onStatus((s) => updateBadge(s));
}

init();


