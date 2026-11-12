/**
 * "Send feedback" dialog: reviews, suggestions and problem reports.
 * Any element with [data-feedback] opens it. Messages go to the site owner only
 * (lib/feedback.js) and are read on the Users page.
 */
import { sendFeedback } from './account.js';
import { toast } from './ui.js';

let signedIn = false;

/** Called by main.js once we know whether someone is signed in. */
export function setFeedbackUser(user) {
  signedIn = !!user;
  const row = document.getElementById('feedbackEmailRow');
  if (row) row.hidden = signedIn; // signed-in users get replies at their account email
}

export function initFeedback() {
  const dlg = document.getElementById('feedbackDialog');
  const form = document.getElementById('feedbackForm');
  if (!dlg || !form) return;
  const err = document.getElementById('feedbackError');
  const sendBtn = document.getElementById('feedbackSend');

  const open = (kind) => {
    err.hidden = true;
    if (kind) {
      const r = form.querySelector(`input[name="kind"][value="${kind}"]`);
      if (r) r.checked = true;
    }
    if (!dlg.open) dlg.showModal();
    setTimeout(() => document.getElementById('feedbackMessage')?.focus(), 50);
  };
  const close = () => { if (dlg.open) dlg.close(); };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feedback]');
    if (!btn) return;
    e.preventDefault();
    btn.closest('dialog:not(#feedbackDialog)')?.close();
    open(btn.dataset.feedback);
  });
  document.getElementById('feedbackClose')?.addEventListener('click', close);
  document.getElementById('feedbackCancel')?.addEventListener('click', close);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const message = String(fd.get('message') || '').trim();
    if (message.length < 3) {
      err.textContent = 'Please write a few words.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      await sendFeedback({
        kind: fd.get('kind'),
        rating: fd.get('rating') ? Number(fd.get('rating')) : null,
        message,
        email: signedIn ? '' : String(fd.get('email') || '').trim(),
        website: fd.get('website') || '',
        page: (location.hash || '#').slice(1, 40),
      });
      form.reset();
      close();
      toast('Thank you! Your feedback was sent.');
    } catch (ex) {
      err.textContent = ex?.message || 'Could not send. Please try again.';
      err.hidden = false;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  });
}
