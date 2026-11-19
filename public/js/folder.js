// 文件夹选择器：凡是要填路径的地方都不用手打。
// - <input data-folder>：显示成「文件夹图标 + 路径 + 选择…」，点开用主机的 Finder 选；
// - <textarea data-folder-list>：一行一个文件夹，显示成列表 + 「添加文件夹」，每行可以移除。
// 原来的输入框留在原处（隐藏），值照旧读写、照旧派发 input / change，别的代码不用改。
// 主机不是 macOS、或者在手机上用不了原生选择器时，可以点「手动填」退回输入框。
import { esc, toast, pickFolder } from './core.js';
import { icon } from './ui.js';

const fields = new WeakMap();

// 路径太长时保留结尾（最有用的是最后几级文件夹），开头用「…」代替。
function shortPath(path, max = 46) {
  const text = String(path || '').replace(/^\/Users\/[^/]+/, '~');
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

function emit(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function choose(button) {
  button.disabled = true;
  button.classList.add('is-busy');
  try {
    const data = await pickFolder();
    return data?.path || null;
  } catch (err) {
    if (/取消/.test(err.message)) return null;
    toast(/macOS/.test(err.message) ? '这台主机不能弹出文件夹选择器，点「手动填」直接输入路径。' : err.message, 3600);
    return null;
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
  }
}

/* ---------------------------------- 单个 ---------------------------------- */

function enhanceInput(input) {
  if (fields.has(input)) return;
  const box = document.createElement('div');
  box.className = 'folder-field';
  box.innerHTML = `
    <button type="button" class="folder-main" data-folder-pick>
      <span class="folder-icon">${icon('folder')}</span>
      <span class="folder-path"></span>
    </button>
    <button type="button" class="folder-act" data-folder-pick>选择…</button>
    <button type="button" class="folder-manual" data-folder-manual title="手动填写路径">${icon('edit', 'sm')}</button>`;
  input.after(box);
  input.classList.add('folder-native');
  const ctrl = {
    sync() {
      const value = input.value.trim();
      const label = box.querySelector('.folder-path');
      label.textContent = value ? shortPath(value) : (input.placeholder ? `还没选 · ${input.placeholder}` : '还没选文件夹');
      label.classList.toggle('is-empty', !value);
      box.title = value;
      box.classList.toggle('is-disabled', input.disabled);
    }
  };
  fields.set(input, ctrl);
  box.addEventListener('click', async (event) => {
    if (event.target.closest('[data-folder-manual]')) {
      box.classList.toggle('is-manual');
      input.classList.toggle('is-shown', box.classList.contains('is-manual'));
      if (box.classList.contains('is-manual')) input.focus();
      return;
    }
    const pick = event.target.closest('[data-folder-pick]');
    if (!pick || input.disabled) return;
    const path = await choose(pick);
    if (!path) return;
    input.value = path;
    ctrl.sync();
    emit(input);
  });
  input.addEventListener('input', () => ctrl.sync());
  input.addEventListener('change', () => ctrl.sync());
  ctrl.sync();
}

/* ---------------------------------- 多个 ---------------------------------- */

function enhanceList(textarea) {
  if (fields.has(textarea)) return;
  const box = document.createElement('div');
  box.className = `folder-list ${'folderPrimary' in textarea.dataset ? 'has-primary' : ''}`;
  textarea.after(box);
  textarea.classList.add('folder-native');
  const values = () => textarea.value.split('\n').map((line) => line.trim()).filter(Boolean);
  const write = (list) => {
    textarea.value = list.join('\n');
    ctrl.sync();
    emit(textarea);
  };
  const ctrl = {
    sync() {
      const list = values();
      box.innerHTML = `
        ${list.map((path, index) => `
          <div class="folder-row" title="${esc(path)}">
            <span class="folder-icon">${icon('folder')}</span>
            <span class="folder-path">${esc(shortPath(path))}</span>
            ${'folderPrimary' in textarea.dataset ? (index === 0 ? '<span class="folder-badge">主目录</span>' : `<button type="button" class="folder-promote" data-folder-promote="${index}" title="设为主目录">设为主目录</button>`) : ''}
            <button type="button" class="icon-btn xs" data-folder-remove="${index}" title="不再读取这个文件夹">${icon('x', 'sm')}</button>
          </div>`).join('')}
        <div class="folder-list-actions">
          <button type="button" class="folder-add" data-folder-add>${icon('plus', 'sm')}添加文件夹</button>
          <button type="button" class="folder-manual" data-folder-manual title="手动填写，一行一个">${icon('edit', 'sm')}手动填</button>
        </div>`;
    }
  };
  fields.set(textarea, ctrl);
  box.addEventListener('click', async (event) => {
    const remove = event.target.closest('[data-folder-remove]');
    if (remove) {
      const list = values();
      list.splice(Number(remove.dataset.folderRemove), 1);
      write(list);
      return;
    }
    const promote = event.target.closest('[data-folder-promote]');
    if (promote) {
      const list = values();
      const [picked] = list.splice(Number(promote.dataset.folderPromote), 1);
      write([picked, ...list]);
      return;
    }
    if (event.target.closest('[data-folder-manual]')) {
      textarea.classList.toggle('is-shown');
      if (textarea.classList.contains('is-shown')) textarea.focus();
      return;
    }
    const add = event.target.closest('[data-folder-add]');
    if (!add) return;
    const path = await choose(add);
    if (!path) return;
    const list = values();
    if (list.includes(path)) { toast('这个文件夹已经在列表里了。'); return; }
    write([...list, path]);
  });
  textarea.addEventListener('input', () => ctrl.sync());
  ctrl.sync();
}

/* ---------------------------------- 接管 ---------------------------------- */

// 程序直接赋值（比如设置页回填）时也同步显示。
for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  Object.defineProperty(proto, 'value', {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(value) {
      desc.set.call(this, value);
      fields.get(this)?.sync();
    }
  });
}

function enhanceAll(root) {
  if (!root.querySelectorAll) return;
  const nodes = [...root.querySelectorAll('input[data-folder], textarea[data-folder-list]')];
  if (root.matches?.('input[data-folder], textarea[data-folder-list]')) nodes.push(root);
  for (const el of nodes) {
    if (el.tagName === 'TEXTAREA') enhanceList(el);
    else enhanceInput(el);
  }
}

new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) enhanceAll(node);
}).observe(document.documentElement, { childList: true, subtree: true });
enhanceAll(document);
