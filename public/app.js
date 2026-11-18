// 静静前端入口。各页面的逻辑在 js/ 下按功能拆开：
//   core.js 状态 / 工具 / 接口    ui.js 图标与对话框    shell.js 导航 / 侧栏 / 主题
//   chat.js 对话    tasks.js 任务    memory.js 记忆    settings.js 设置外壳与表单分页
//   workers.js / plugins.js / automation.js / system.js 设置里的各个分页
//   sync.js 首屏快照与实时事件
import { $, state, api, toast, hideLogin, showLogin } from './js/core.js';
import { initTheme, switchView, parseHash, renderActivity, updateInstallStatus, nativeApp } from './js/shell.js';
import { renderChat } from './js/chat.js';
import { openTask } from './js/tasks.js';
import './js/memory.js';
import './js/settings.js';
import './js/workers.js';
import './js/plugins.js';
import './js/plugin-docs.js';
import './js/automation.js';
import './js/system.js';
import { applySnapshot, connectEvents, disconnectEvents, resync } from './js/sync.js';

// 桌面 App（原生窗口）调用的入口：点系统通知时打开任务，菜单「设置…」「前往」跳到对应页面。
window.jingjing = {
  desktop: nativeApp,
  openTask: (id) => openTask(id, { reveal: true }),
  // 经过 switchView，设置页有没保存的改动时同样会先问。支持 "settings/plugins" 这种二级位置。
  openView: (name) => {
    const [view, sub] = String(name || '').split('/');
    return switchView(view, { sub: sub || null });
  }
};
if (nativeApp) document.documentElement.classList.add('is-desktop');

async function boot() {
  initTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {});
  }
  updateInstallStatus();
  try {
    const status = await api('/api/auth/status');
    if (!status.authenticated) {
      showLogin();
      return;
    }
    hideLogin();
    const data = await api('/api/bootstrap');
    applySnapshot(data);
    connectEvents();
    const { view, sub } = parseHash();
    await switchView(view, { sub, force: true });
    if (state.view === 'chat') renderChat({ forceBottom: true });
    renderActivity();
  } catch (err) {
    toast(`启动失败：${err.message}`, 6000);
    $('#presence-sub').textContent = '连不上本地服务，确认 server.js 还在跑。';
  }
}

boot();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnectEvents();
  else {
    connectEvents();
    if (state.settings) resync().catch(() => {});
  }
});
