/**
 * "How it works" video (1 min 22 s, demo data).
 * Any element with [data-watch-video] opens it in a dialog. The file is only
 * downloaded when someone presses play — the page itself never loads it.
 */
const SRC = 'assets/video/how-it-works.mp4';

export function initHowTo() {
  const dlg = document.getElementById('videoDialog');
  const video = document.getElementById('howVideo');
  if (!dlg || !video) return;

  const open = () => {
    if (!video.getAttribute('src')) video.src = SRC; // first open only
    if (!dlg.open) dlg.showModal();
    video.play().catch(() => { /* autoplay with sound blocked: the controls are there */ });
  };
  const close = () => { video.pause(); if (dlg.open) dlg.close(); };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch-video]');
    if (!btn) return;
    e.preventDefault();
    btn.closest('dialog:not(#videoDialog)')?.close(); // e.g. from the Help dialog
    open();
  });
  document.getElementById('videoClose')?.addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // tap outside
  dlg.addEventListener('close', () => video.pause());
}
