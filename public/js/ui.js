// 图标、对话框、确认框：界面上反复用到的小部件。
import { $, $$, toast } from './core.js';

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  retry: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
  edit: '<path d="M12 20h8.5"/><path d="M16.5 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z"/>',
  trash: '<path d="M4 6.5h16"/><path d="M9 6.5V4.5h6v2"/><path d="m18.5 6.5-.8 13a1 1 0 0 1-1 1H7.3a1 1 0 0 1-1-1l-.8-13"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2"/><path d="M15 9V5a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 5v8a1.5 1.5 0 0 0 1.5 1.5H9"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M20 20v-6a5 5 0 0 0-5-5H4"/>',
  flow: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v3a3 3 0 0 0 3 3h6.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.3"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.9L12 18.5l-1.8-5.8-5.7-1.9L10.2 9z"/>',
  gauge: '<path d="M12 14.5 16 10"/><path d="M3.6 18.5a9.5 9.5 0 1 1 16.8 0"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plug: '<path d="M9 2.5v5M15 2.5v5"/><path d="M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5v5"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9"/><path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
  activity: '<path d="M21.5 12h-4l-3 8.5-5-17-3 8.5h-4"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  external: '<path d="M14.5 3.5h6v6"/><path d="M10 14 20.5 3.5"/><path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H11"/>',
  wand: '<path d="m4 20 10-10"/><path d="m14 4 .8 2.2L17 7l-2.2.8L14 10l-.8-2.2L11 7l2.2-.8z"/><path d="m19 11 .5 1.5L21 13l-1.5.5L19 15l-.5-1.5L17 13l1.5-.5z"/>',
  upload: '<path d="M12 20V9M7.5 13 12 8.5l4.5 4.5M5 4.5h14"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1l2.6 2.6"/><path d="M20.5 3.5v5h-5"/>',
  test: '<path d="M9.5 3.5h5M10.5 3.5v6L5 19a1.3 1.3 0 0 0 1.1 2h11.8A1.3 1.3 0 0 0 19 19l-5.5-9.5v-6"/><path d="M7.5 15h9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L5.1 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h5l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>'
};

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* ------------------------------- 表单对话框 --------------------------- */

/**
 * 打开通用对话框。body 是表单 HTML，确定时把所有 [name] 字段收集成对象交给 onSubmit；
 * onSubmit 抛错就提示并保持打开。readonly 用于只读预览（只有「关闭」）。
 */
export function openDialog({ title, desc = '', body, onSubmit, okText = '确定', cancelText = '取消', wide = false, readonly = false, danger = false }) {
  const dialog = $('#dialog');
  dialog.classList.toggle('is-wide', wide);
  $('#dialog-title').textContent = title;
  $('#dialog-desc').textContent = desc;
  $('#dialog-body').innerHTML = body;
  const ok = $('#dialog-ok');
  ok.textContent = readonly ? '关闭' : okText;
  ok.classList.toggle('danger', danger);
  ok.disabled = false;
  const cancel = $('#dialog-cancel');
  cancel.hidden = readonly;
  cancel.textContent = cancelText;
  $('#dialog-form').onsubmit = async (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel' || readonly) { dialog.close(); return; }
    const values = {};
    $$('[name]', $('#dialog-body')).forEach((input) => {
      values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    ok.disabled = true;
    try {
      await onSubmit?.(values);
      dialog.close();
    } catch (err) {
      toast(err.message);
    } finally {
      ok.disabled = false;
    }
  };
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $('#dialog-body').querySelector('input:not([type=checkbox]):not([readonly]), textarea:not([readonly])')?.focus(), 60);
  return dialog;
}

/** 确认框，替代浏览器自带的 confirm()。返回 Promise<boolean>。 */
export function ask({ title, message = '', okText = '确定', cancelText = '取消', danger = false }) {
  const dialog = $('#confirm-dialog');
  if (!dialog?.showModal) return Promise.resolve(window.confirm([title, message].filter(Boolean).join('\n\n')));
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  const ok = $('#confirm-ok');
  ok.textContent = okText;
  ok.classList.toggle('danger', danger);
  $('#confirm-cancel').textContent = cancelText;
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
    setTimeout(() => ok.focus(), 30);
  });
}

export function anyDialogOpen() {
  return $$('dialog').some((d) => d.open);
}

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-dialog]');
  if (close) close.closest('dialog')?.close();
});

/** 按钮执行异步操作期间禁用，避免重复点击。 */
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button) button.disabled = false;
  }
}
