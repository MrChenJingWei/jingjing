// 自绘下拉选择器：替换页面里所有原生 <select> 的外观和交互（能搜索、键盘可用、深浅色一致）。
//
// 原生 <select> 仍然留在原处（视觉上隐藏），作为唯一的数据来源：
// - 别的代码照旧读写 select.value、重写 innerHTML 选项、监听 change，都不用改；
// - 选中时改 select.value 并派发 change / input 事件；
// - 选项、禁用、隐藏变化由 MutationObserver 同步；程序里直接赋值 value 由下面的 setter 补丁同步。
// 不接管：multiple、size > 1、带 data-native 的 select。
//
// 带 list 的 <input>（可以自己填、也可以从建议里选，比如「模型」）同样接管：去掉 list 不让浏览器弹原生建议，
// 右侧加一个箭头，输入时按内容过滤 <datalist> 里的建议。

const controls = new WeakMap();
const SEARCH_MIN = 7;
let current = null;

const CHEVRON = '<svg class="i sm xsel-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK = '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const SEARCH = '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------- 程序赋值时同步显示 ------------------------- */

function patch(proto, prop) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (!desc?.set) return;
  Object.defineProperty(proto, prop, {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(value) {
      desc.set.call(this, value);
      const select = this instanceof HTMLSelectElement ? this : this.closest?.('select');
      if (select) controls.get(select)?.sync();
    }
  });
}
patch(HTMLSelectElement.prototype, 'value');
patch(HTMLSelectElement.prototype, 'selectedIndex');
patch(HTMLOptionElement.prototype, 'selected');

/* --------------------------------- 接管 --------------------------------- */

function labelOf(select) {
  return select.getAttribute('aria-label')
    || select.labels?.[0]?.querySelector('span')?.textContent?.trim()
    || select.title
    || '';
}

export function enhance(select) {
  if (!(select instanceof HTMLSelectElement) || controls.has(select)) return;
  if (select.multiple || select.size > 1 || 'native' in select.dataset) return;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'xsel-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<span class="xsel-label"></span>${CHEVRON}`;
  select.classList.add('xsel-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(trigger);

  const ctrl = {
    select,
    trigger,
    sync() {
      const option = select.options[select.selectedIndex];
      const label = trigger.querySelector('.xsel-label');
      label.textContent = option ? option.textContent.trim() : '';
      label.classList.toggle('is-placeholder', !option || option.value === '');
      trigger.disabled = select.disabled;
      trigger.hidden = select.hidden;
      trigger.title = option?.textContent.trim() || select.title || '';
      const name = labelOf(select);
      if (name) trigger.setAttribute('aria-label', `${name}：${label.textContent}`);
      if (current?.ctrl === ctrl) renderList(current);
    }
  };
  controls.set(select, ctrl);

  new MutationObserver(() => ctrl.sync()).observe(select, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label', 'selected']
  });
  select.addEventListener('change', () => ctrl.sync());
  // 点 <label> 会把焦点交给（隐藏的）原生 select：转给按钮。
  select.addEventListener('focus', () => trigger.focus());

  trigger.addEventListener('click', () => {
    if (current?.ctrl === ctrl) close();
    else open(ctrl);
  });
  trigger.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open(ctrl);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // 直接打字：打开并把字放进搜索框。
      event.preventDefault();
      open(ctrl, event.key);
    }
  });
  ctrl.sync();
}

function enhanceAll(root) {
  if (root instanceof HTMLSelectElement) enhance(root);
  if (root instanceof HTMLInputElement) enhanceCombo(root);
  root.querySelectorAll?.('select').forEach(enhance);
  root.querySelectorAll?.('input[list]').forEach(enhanceCombo);
}

/* --------------------------------- 弹层 --------------------------------- */

function optionItems(select) {
  const items = [];
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      const options = [...child.children].filter((o) => o instanceof HTMLOptionElement && !o.hidden);
      if (options.length) items.push({ group: child.label });
      for (const option of options) items.push({ option, disabled: option.disabled || child.disabled });
    } else if (child instanceof HTMLOptionElement && !child.hidden) {
      items.push({ option: child, disabled: child.disabled });
    }
  }
  return items;
}

function highlight(text, query) {
  if (!query) return esc(text);
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return esc(text);
  return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + query.length))}</mark>${esc(text.slice(at + query.length))}`;
}

function renderList(state) {
  const { ctrl, list, query } = state;
  const q = query.trim().toLowerCase();
  const all = optionItems(ctrl.select);
  const visible = [];
  let pendingGroup = null;
  for (const item of all) {
    if (item.group !== undefined) { pendingGroup = item; continue; }
    const text = item.option.textContent.trim();
    if (q && !text.toLowerCase().includes(q) && !item.option.value.toLowerCase().includes(q)) continue;
    if (pendingGroup) { visible.push(pendingGroup); pendingGroup = null; }
    visible.push({ ...item, text });
  }
  state.items = visible.filter((item) => item.option && !item.disabled);
  if (!state.items.includes(state.items[state.active])) state.active = 0;
  if (state.active >= state.items.length) state.active = Math.max(0, state.items.length - 1);
  const selected = ctrl.select.options[ctrl.select.selectedIndex];
  list.innerHTML = visible.length
    ? visible.map((item) => {
      if (item.group !== undefined) return `<li class="xsel-group" role="presentation">${esc(item.group)}</li>`;
      const index = state.items.indexOf(item);
      const isSelected = item.option === selected;
      return `<li class="xsel-option ${isSelected ? 'is-selected' : ''} ${index === state.active ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''} ${item.option.value === '' ? 'is-empty' : ''}"
        role="option" id="xsel-opt-${index}" aria-selected="${isSelected}" ${item.disabled ? 'aria-disabled="true"' : `data-index="${index}"`}>
        <span class="xsel-text">${highlight(item.text, query.trim())}</span>${isSelected ? CHECK : ''}</li>`;
    }).join('')
    : '<li class="xsel-none">没有匹配的选项</li>';
  const active = list.querySelector('.is-active');
  if (active) {
    state.pop.querySelector('[role="listbox"]')?.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
}

function position(state) {
  const { trigger, } = state.ctrl;
  const { pop } = state;
  const rect = trigger.getBoundingClientRect();
  const narrow = window.innerWidth < 600;
  pop.classList.toggle('is-sheet', narrow);
  if (narrow) {
    Object.assign(pop.style, { left: '', top: '', width: '', maxHeight: '' });
    return;
  }
  const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 16);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const wanted = Math.min(340, pop.scrollHeight || 340);
  const up = below < Math.min(wanted, 220) && above > below;
  const maxHeight = Math.max(140, Math.min(340, up ? above : below));
  Object.assign(pop.style, {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    top: up ? `${Math.max(8, rect.top - Math.min(maxHeight, pop.scrollHeight) - 6)}px` : `${rect.bottom + 6}px`
  });
  pop.classList.toggle('is-up', up);
  // 祖先有 transform / filter 时 fixed 不再相对视口：按实际落点把偏差补回来。
  // 量的时候先去掉弹层自己的入场 transform，免得把它算成偏差。
  const transition = pop.style.transition;
  pop.style.transition = 'none';
  pop.style.transform = 'none';
  const actual = pop.getBoundingClientRect();
  pop.style.transform = '';
  pop.style.transition = transition;
  const dx = actual.left - parseFloat(pop.style.left);
  const dy = actual.top - parseFloat(pop.style.top);
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    pop.style.left = `${parseFloat(pop.style.left) - dx}px`;
    pop.style.top = `${parseFloat(pop.style.top) - dy}px`;
  }
}

function open(ctrl, initial = '') {
  close();
  const { select, trigger } = ctrl;
  if (select.disabled) return;
  const count = optionItems(select).filter((item) => item.option).length;
  const searchable = count >= SEARCH_MIN || initial;
  const pop = document.createElement('div');
  pop.className = 'xsel-pop';
  pop.innerHTML = `
    ${searchable ? `<label class="xsel-search">${SEARCH}<input type="text" placeholder="搜索…" autocomplete="off" spellcheck="false" aria-label="搜索选项" /></label>` : ''}
    <ul class="xsel-list" role="listbox" tabindex="-1"></ul>`;
  // 在打开的 <dialog> 里时挂到 dialog 上：dialog 在顶层，挂到 body 会被盖住。
  const host = select.closest('dialog[open]') || document.body;
  host.append(pop);
  const state = { ctrl, pop, list: pop.querySelector('.xsel-list'), input: pop.querySelector('input'), query: initial, items: [], active: 0 };
  current = state;
  renderList(state);
  const selectedIndex = state.items.findIndex((item) => item.option === select.options[select.selectedIndex]);
  if (selectedIndex >= 0) { state.active = selectedIndex; renderList(state); }
  position(state);
  trigger.setAttribute('aria-expanded', 'true');
  trigger.classList.add('is-open');
  if (state.input) {
    state.input.value = initial;
    state.input.focus();
    state.input.addEventListener('input', () => {
      state.query = state.input.value;
      state.active = 0;
      renderList(state);
      position(state);
    });
  } else {
    state.list.focus();
  }
  pop.addEventListener('keydown', (event) => onKey(state, event));
  pop.addEventListener('mousemove', (event) => {
    const li = event.target.closest('[data-index]');
    if (!li || Number(li.dataset.index) === state.active) return;
    state.list.querySelector('.is-active')?.classList.remove('is-active');
    li.classList.add('is-active');
    state.active = Number(li.dataset.index);
  });
  pop.addEventListener('mousedown', (event) => {
    // 不让点选项时输入框失焦。
    if (event.target.closest('.xsel-list')) event.preventDefault();
  });
  pop.addEventListener('click', (event) => {
    const li = event.target.closest('[data-index]');
    if (li) choose(state, Number(li.dataset.index));
  });
  requestAnimationFrame(() => pop.classList.add('is-in'));
}

function onKey(state, event) {
  const move = (delta) => {
    if (!state.items.length) return;
    state.active = (state.active + delta + state.items.length) % state.items.length;
    renderList(state);
  };
  switch (event.key) {
    case 'ArrowDown': event.preventDefault(); move(1); break;
    case 'ArrowUp': event.preventDefault(); move(-1); break;
    case 'Home': if (!state.input) { event.preventDefault(); state.active = 0; renderList(state); } break;
    case 'End': if (!state.input) { event.preventDefault(); state.active = state.items.length - 1; renderList(state); } break;
    case 'Enter': event.preventDefault(); if (state.items[state.active]) choose(state, state.active); break;
    case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); break;
    case 'Tab': close(); break;
    default:
      // 没有搜索框时按字母跳到下一个以它开头的选项。
      if (!state.input && event.key.length === 1) {
        const key = event.key.toLowerCase();
        const start = state.active + 1;
        for (let i = 0; i < state.items.length; i += 1) {
          const index = (start + i) % state.items.length;
          if (state.items[index].text.toLowerCase().startsWith(key)) { state.active = index; renderList(state); break; }
        }
      }
  }
}

function choose(state, index) {
  const item = state.items[index];
  if (!item) return;
  const { select } = state.ctrl;
  const changedValue = select.value !== item.option.value || select.options[select.selectedIndex] !== item.option;
  item.option.selected = true;
  close(true);
  if (changedValue) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

export function close(refocus = false) {
  if (!current) return;
  const { pop, ctrl } = current;
  current = null;
  ctrl.trigger.setAttribute('aria-expanded', 'false');
  ctrl.trigger.classList.remove('is-open');
  ctrl.input?.setAttribute('aria-expanded', 'false');
  pop.remove();
  const focusEl = ctrl.focusEl || ctrl.trigger;
  if (refocus && focusEl.isConnected) focusEl.focus();
}

/* ------------------------- 可输入的建议框（input + datalist） ------------------------- */

const combos = new WeakMap();

function comboOptions(input) {
  const list = document.getElementById(input.dataset.xlist || '');
  if (!list) return [];
  const seen = new Set();
  const out = [];
  for (const option of list.querySelectorAll('option')) {
    const value = option.value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, text: option.label && option.label !== value ? option.label : value });
  }
  return out;
}

export function enhanceCombo(input) {
  if (!(input instanceof HTMLInputElement) || combos.has(input) || !input.getAttribute('list') || 'native' in input.dataset) return;
  input.dataset.xlist = input.getAttribute('list');
  input.removeAttribute('list');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const wrap = document.createElement('span');
  wrap.className = 'xcombo';
  input.before(wrap);
  wrap.append(input);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'xcombo-toggle';
  toggle.tabIndex = -1;
  toggle.setAttribute('aria-label', '展开建议');
  toggle.innerHTML = CHEVRON;
  wrap.append(toggle);

  const ctrl = { input, trigger: wrap, focusEl: input, combo: true, sync() { if (current?.ctrl === ctrl) renderCombo(current); } };
  combos.set(input, ctrl);
  const list = document.getElementById(input.dataset.xlist);
  if (list) new MutationObserver(() => ctrl.sync()).observe(list, { childList: true, subtree: true, attributes: true });

  toggle.addEventListener('mousedown', (event) => event.preventDefault());
  toggle.addEventListener('click', () => {
    if (current?.ctrl === ctrl) close();
    else { input.focus(); openCombo(ctrl, { showAll: true }); }
  });
  input.addEventListener('input', () => {
    if (current?.ctrl === ctrl) {
      current.query = input.value;
      current.showAll = false;
      current.active = 0;
      renderCombo(current);
      position(current);
    } else if (comboOptions(input).length) {
      openCombo(ctrl, { showAll: false });
    }
  });
  input.addEventListener('keydown', (event) => {
    const open = current?.ctrl === ctrl;
    if (!open) {
      if (event.key === 'ArrowDown' || (event.key === 'ArrowUp' && event.altKey)) {
        event.preventDefault();
        openCombo(ctrl, { showAll: true });
      }
      return;
    }
    const state = current;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!state.items.length) return;
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length;
      renderCombo(state);
    } else if (event.key === 'Enter') {
      if (state.items[state.active] && state.items.length) {
        event.preventDefault();
        chooseCombo(state, state.active);
      } else {
        close();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (current?.ctrl === ctrl && !current.pop.contains(document.activeElement)) close();
  }, 120));
}

function renderCombo(state) {
  const { ctrl, list } = state;
  const all = comboOptions(ctrl.input);
  const q = state.showAll ? '' : String(state.query || '').trim().toLowerCase();
  state.items = q ? all.filter((item) => item.text.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)) : all;
  if (state.active >= state.items.length) state.active = 0;
  const value = ctrl.input.value;
  list.innerHTML = state.items.length
    ? state.items.map((item, index) => `
        <li class="xsel-option ${item.value === value ? 'is-selected' : ''} ${index === state.active ? 'is-active' : ''}" role="option" id="xcombo-opt-${index}" data-index="${index}" aria-selected="${item.value === value}">
          <span class="xsel-text">${highlight(item.text, q ? state.query.trim() : '')}</span>${item.value === value ? CHECK : ''}</li>`).join('')
    : `<li class="xsel-none">${all.length ? '没有匹配的建议，可以直接用你填的' : '还没有建议'}</li>`;
  const active = list.querySelector('.is-active');
  if (active) {
    ctrl.input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
}

function openCombo(ctrl, { showAll }) {
  close();
  const pop = document.createElement('div');
  pop.className = 'xsel-pop is-combo';
  pop.innerHTML = '<ul class="xsel-list" role="listbox" tabindex="-1"></ul>';
  (ctrl.input.closest('dialog[open]') || document.body).append(pop);
  const state = { ctrl, pop, list: pop.querySelector('.xsel-list'), query: ctrl.input.value, showAll, items: [], active: 0 };
  current = state;
  renderCombo(state);
  const selected = state.items.findIndex((item) => item.value === ctrl.input.value);
  if (selected >= 0) { state.active = selected; renderCombo(state); }
  position(state);
  ctrl.input.setAttribute('aria-expanded', 'true');
  ctrl.trigger.classList.add('is-open');
  pop.addEventListener('mousedown', (event) => event.preventDefault());
  pop.addEventListener('mousemove', (event) => {
    const li = event.target.closest('[data-index]');
    if (!li || Number(li.dataset.index) === state.active) return;
    state.list.querySelector('.is-active')?.classList.remove('is-active');
    li.classList.add('is-active');
    state.active = Number(li.dataset.index);
  });
  pop.addEventListener('click', (event) => {
    const li = event.target.closest('[data-index]');
    if (li) chooseCombo(state, Number(li.dataset.index));
  });
  requestAnimationFrame(() => pop.classList.add('is-in'));
}

function chooseCombo(state, index) {
  const item = state.items[index];
  if (!item) return;
  const { input } = state.ctrl;
  const changedValue = input.value !== item.value;
  input.value = item.value;
  close();
  input.setAttribute('aria-expanded', 'false');
  input.focus();
  if (changedValue) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 上面派发的 input 会重新打开建议：选完就收起。
  if (current?.ctrl === state.ctrl) close();
}

/* --------------------------------- 全局 --------------------------------- */

document.addEventListener('pointerdown', (event) => {
  if (!current) return;
  if (current.pop.contains(event.target) || current.ctrl.trigger.contains(event.target)) return;
  close();
}, true);
window.addEventListener('resize', () => { if (current) position(current); });
document.addEventListener('scroll', (event) => {
  if (!current || current.pop.contains(event.target)) return;
  if (!current.ctrl.trigger.isConnected) close();
  else position(current);
}, true);
// 对话框关闭时把它里面的弹层一起收掉。
document.addEventListener('close', () => { if (current && !current.pop.isConnected) current = null; else if (current && current.pop.closest('dialog:not([open])')) close(); }, true);

new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) if (node.nodeType === 1) enhanceAll(node);
    for (const node of record.removedNodes) {
      if (node.nodeType !== 1) continue;
      const selects = node instanceof HTMLSelectElement ? [node] : [...(node.querySelectorAll?.('select') || [])];
      for (const select of selects) {
        const ctrl = controls.get(select);
        if (!ctrl || select.isConnected) continue;
        if (current?.ctrl === ctrl) close();
        if (ctrl.trigger.isConnected && !ctrl.trigger.previousElementSibling?.isSameNode(select)) ctrl.trigger.remove();
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

enhanceAll(document);
