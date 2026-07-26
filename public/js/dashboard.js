// CmdForge dashboard — all user-controlled data is rendered with
// textContent / element creation (never innerHTML) to prevent XSS. [§6]
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { me: null, guilds: [], inviteUrl: '#', guild: null, roles: [], commands: [], editing: null };

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { location.href = '/'; throw new Error('unauthenticated'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, kind = 'ok') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function showLoader(on) { $('loader').classList.toggle('hidden', !on); }
  function showView(id) {
    $('viewServers').classList.add('hidden');
    $('viewGuild').classList.add('hidden');
    if (id) $(id).classList.remove('hidden');
  }

  // ---------- boot ----------
  async function boot() {
    try {
      state.me = await api('/api/me');
    } catch { return; }
    renderUser();
    if (state.me.demo) $('demoPill').classList.remove('hidden');
    await loadServers();
  }

  function renderUser() {
    const chip = $('userChip');
    chip.textContent = '';
    if (state.me.avatar) {
      const img = el('img'); img.src = state.me.avatar; img.alt = '';
      chip.appendChild(img);
    } else {
      chip.appendChild(el('div', 'avatar-fallback', (state.me.username || '?')[0].toUpperCase()));
    }
    chip.appendChild(el('span', null, state.me.global_name || state.me.username));
  }

  // ---------- servers view ----------
  async function loadServers() {
    showView(null); showLoader(true);
    try {
      const data = await api('/api/guilds');
      state.guilds = data.guilds; state.inviteUrl = data.inviteUrl;
      renderServers();
      showView('viewServers');
    } catch (e) { toast(e.message, 'err'); }
    showLoader(false);
  }

  function renderServers() {
    const grid = $('serverGrid');
    grid.textContent = '';
    if (!state.guilds.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('div', 'big', '🤷'));
      empty.appendChild(el('p', null, 'No servers found where you have Administrator or Manage Server permission.'));
      grid.appendChild(empty);
      return;
    }
    for (const g of state.guilds) {
      const card = el('div', 'server-card' + (g.botIn ? '' : ' no-bot'));
      const icon = el('div', 'guild-icon');
      if (g.icon) {
        const img = el('img'); img.src = `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`; img.alt = '';
        icon.appendChild(img);
      } else icon.textContent = initials(g.name);
      card.appendChild(icon);

      const info = el('div');
      info.appendChild(el('h3', null, g.name));
      info.appendChild(el('span', 'badge ' + (g.botIn ? 'badge-ok' : 'badge-invite'), g.botIn ? '✓ Bot active' : 'Bot not added'));
      card.appendChild(info);

      if (g.botIn) {
        card.addEventListener('click', () => openGuild(g.id));
      } else {
        const a = el('a', 'btn btn-sm invite-link', 'Invite bot');
        a.href = state.inviteUrl + (state.inviteUrl !== '#' ? `&guild_id=${g.id}` : '');
        a.target = '_blank'; a.rel = 'noopener';
        card.appendChild(a);
      }
      grid.appendChild(card);
    }
  }

  const initials = (name) => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  // ---------- guild view ----------
  async function openGuild(guildId) {
    showView(null); showLoader(true);
    try {
      const [info, cmds] = await Promise.all([
        api(`/api/guilds/${guildId}`),
        api(`/api/guilds/${guildId}/commands`),
      ]);
      state.guild = info.guild; state.roles = info.roles; state.commands = cmds.commands;

      $('guildName').textContent = info.guild.name;
      const gi = $('guildIcon');
      gi.textContent = '';
      if (info.guild.icon) {
        const img = el('img'); img.src = `https://cdn.discordapp.com/icons/${info.guild.id}/${info.guild.icon}.png?size=128`; img.alt = '';
        gi.appendChild(img);
      } else gi.textContent = initials(info.guild.name);

      const stats = $('guildStats');
      stats.textContent = '';
      const stat = (label, val) => {
        const s = el('span'); s.appendChild(el('b', null, String(val))); s.appendChild(document.createTextNode(' ' + label));
        return s;
      };
      if (info.memberCount != null) stats.appendChild(stat('members', info.memberCount));
      stats.appendChild(stat('commands', info.commandCount));
      stats.appendChild(stat('total uses', info.totalUses));

      renderCommands();
      switchTab('commands');
      showView('viewGuild');
    } catch (e) { toast(e.message, 'err'); showView('viewServers'); }
    showLoader(false);
  }

  function renderCommands() {
    const list = $('cmdList');
    list.textContent = '';
    if (!state.commands.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('div', 'big', '⌨️'));
      empty.appendChild(el('p', null, 'No custom commands yet. Hit "+ New Command" to make your first one!'));
      list.appendChild(empty);
      return;
    }
    for (const c of state.commands) {
      const card = el('div', 'cmd-card' + (c.enabled ? '' : ' disabled'));
      card.appendChild(el('span', 'cmd-name', '/' + c.name));
      card.appendChild(el('span', 'cmd-desc', c.description));

      const tags = el('div', 'cmd-tags');
      tags.appendChild(el('span', 'tag', c.response_type === 'embed' ? '🖼️ embed' : '💬 text'));
      const dLabel = { channel: '📢 public', ephemeral: '👁️ hidden', dm: '📬 DM' }[c.delivery];
      tags.appendChild(el('span', 'tag t-dm', dLabel));
      if (c.required_role_id) {
        const role = state.roles.find(r => r.id === c.required_role_id);
        tags.appendChild(el('span', 'tag t-role', '🔐 ' + (role ? '@' + role.name : 'role')));
      }
      if (c.req_min_messages > 0) tags.appendChild(el('span', 'tag t-req', `🏆 ${c.req_min_messages} msgs`));
      if (c.req_status_text) tags.appendChild(el('span', 'tag t-req', '✏️ status'));
      if (c.cooldown_seconds > 0) tags.appendChild(el('span', 'tag t-cd', `⏳ ${fmtCd(c.cooldown_seconds)}`));
      tags.appendChild(el('span', 'tag', `${c.uses} uses`));
      if (!c.enabled) tags.appendChild(el('span', 'tag', 'disabled'));
      card.appendChild(tags);

      const actions = el('div', 'cmd-actions');
      const editBtn = el('button', 'btn btn-sm', '✏️ Edit');
      editBtn.addEventListener('click', () => openModal(c));
      const delBtn = el('button', 'btn btn-sm btn-danger', '🗑️');
      delBtn.addEventListener('click', () => deleteCommand(c));
      actions.appendChild(editBtn); actions.appendChild(delBtn);
      card.appendChild(actions);

      list.appendChild(card);
    }
  }

  const fmtCd = (s) => s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;

  async function deleteCommand(c) {
    if (!confirm(`Delete /${c.name}? This can't be undone.`)) return;
    try {
      await api(`/api/guilds/${state.guild.id}/commands/${c.id}`, { method: 'DELETE' });
      state.commands = state.commands.filter(x => x.id !== c.id);
      renderCommands();
      toast(`Deleted /${c.name}`);
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- tabs ----------
  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('tabCommands').classList.toggle('hidden', tab !== 'commands');
    $('tabAudit').classList.toggle('hidden', tab !== 'audit');
    $('tabLeaderboard').classList.toggle('hidden', tab !== 'leaderboard');
    if (tab === 'audit') loadAudit();
    if (tab === 'leaderboard') loadLeaderboard();
  }

  async function loadAudit() {
    const list = $('auditList');
    list.textContent = 'Loading…';
    try {
      const { entries } = await api(`/api/guilds/${state.guild.id}/audit`);
      list.textContent = '';
      if (!entries.length) { list.appendChild(el('div', 'empty-state', 'No activity yet.')); return; }
      for (const e of entries) {
        const row = el('div', 'audit-row');
        const kind = e.action.split('.')[1] || 'update';
        row.appendChild(el('span', 'audit-act ' + kind, kind.toUpperCase()));
        row.appendChild(el('span', null, `${e.actor_tag || e.actor_id} — ${e.detail}`));
        row.appendChild(el('span', 'when', new Date(e.created_at + 'Z').toLocaleString()));
        list.appendChild(row);
      }
    } catch (err) { list.textContent = ''; toast(err.message, 'err'); }
  }

  async function loadLeaderboard() {
    const list = $('lbList');
    list.textContent = 'Loading…';
    try {
      const { top } = await api(`/api/guilds/${state.guild.id}/leaderboard`);
      list.textContent = '';
      if (!top.length) { list.appendChild(el('div', 'empty-state', 'No messages counted yet — the bot counts messages from the moment it joins.')); return; }
      top.forEach((r, i) => {
        const row = el('div', 'lb-row');
        row.appendChild(el('span', 'rank', `#${i + 1}`));
        row.appendChild(el('span', null, `User ${r.user_id}`));
        row.appendChild(el('span', 'count', `${r.count} messages`));
        list.appendChild(row);
      });
    } catch (err) { list.textContent = ''; toast(err.message, 'err'); }
  }

  // ---------- modal / form ----------
  const seg = (containerId) => ({
    get: () => document.querySelector(`#${containerId} button.on`)?.dataset.v,
    set: (v) => document.querySelectorAll(`#${containerId} button`).forEach(b => b.classList.toggle('on', b.dataset.v === v)),
  });
  const segType = seg('segType');
  const segDelivery = seg('segDelivery');

  document.querySelectorAll('#segType button, #segDelivery button').forEach(b => {
    b.addEventListener('click', () => {
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      if (b.parentElement.id === 'segType') updateTypeRows();
    });
  });

  function updateTypeRows() {
    const isEmbed = segType.get() === 'embed';
    $('rowEmbed').classList.toggle('hidden', !isEmbed);
    $('rowText').querySelector('span').textContent = isEmbed ? 'Message above the embed (optional)' : 'Response message';
  }

  function openModal(cmd = null) {
    state.editing = cmd;
    $('modalTitle').textContent = cmd ? `Edit /${cmd.name}` : 'New Command';
    $('formError').classList.add('hidden');

    // populate role select
    const sel = $('fRole');
    sel.textContent = '';
    const optAll = el('option', null, '@everyone'); optAll.value = '';
    sel.appendChild(optAll);
    for (const r of state.roles) {
      const o = el('option', null, '@' + r.name); o.value = r.id;
      sel.appendChild(o);
    }

    $('fName').value = cmd?.name || '';
    $('fDesc').value = cmd?.description || '';
    segType.set(cmd?.response_type || 'text');
    $('fText').value = cmd?.response_text || '';
    $('fETitle').value = cmd?.embed_title || '';
    $('fEDesc').value = cmd?.embed_description || '';
    $('fEColor').value = cmd?.embed_color || '#5865F2';
    $('fEImg').value = cmd?.embed_image || '';
    $('fEFooter').value = cmd?.embed_footer || '';
    segDelivery.set(cmd?.delivery || 'channel');
    sel.value = cmd?.required_role_id || '';
    $('fCooldown').value = cmd?.cooldown_seconds ?? 0;
    $('fMinMsg').value = cmd?.req_min_messages ?? 0;
    $('fStatus').value = cmd?.req_status_text || '';
    $('fEnabled').checked = cmd ? Boolean(cmd.enabled) : true;

    updateTypeRows();
    $('modalBackdrop').classList.remove('hidden');
    $('fName').focus();
  }

  function closeModal() { $('modalBackdrop').classList.add('hidden'); state.editing = null; }

  $('cmdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('fName').value.trim().toLowerCase(),
      description: $('fDesc').value.trim(),
      response_type: segType.get(),
      response_text: $('fText').value,
      embed_title: $('fETitle').value,
      embed_description: $('fEDesc').value,
      embed_color: $('fEColor').value,
      embed_image: $('fEImg').value.trim(),
      embed_footer: $('fEFooter').value,
      delivery: segDelivery.get(),
      required_role_id: $('fRole').value,
      cooldown_seconds: parseInt($('fCooldown').value, 10) || 0,
      req_min_messages: parseInt($('fMinMsg').value, 10) || 0,
      req_status_text: $('fStatus').value.trim(),
      enabled: $('fEnabled').checked,
    };
    const btn = $('saveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      let saved;
      if (state.editing) {
        saved = await api(`/api/guilds/${state.guild.id}/commands/${state.editing.id}`, { method: 'PUT', body });
        state.commands = state.commands.map(c => c.id === saved.command.id ? saved.command : c);
        toast(`Updated /${saved.command.name}`);
      } else {
        saved = await api(`/api/guilds/${state.guild.id}/commands`, { method: 'POST', body });
        state.commands.push(saved.command);
        state.commands.sort((a, b) => a.name.localeCompare(b.name));
        toast(`Created /${saved.command.name} 🎉`);
      }
      renderCommands();
      closeModal();
    } catch (err) {
      const fe = $('formError');
      fe.textContent = err.message;
      fe.classList.remove('hidden');
    }
    btn.disabled = false; btn.textContent = 'Save Command';
  });

  // ---------- global events ----------
  $('logoutBtn').addEventListener('click', async () => {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    location.href = '/';
  });
  $('brandHome').addEventListener('click', loadServers);
  $('backBtn').addEventListener('click', loadServers);
  $('newCmdBtn').addEventListener('click', () => openModal());
  $('modalClose').addEventListener('click', closeModal);
  $('cancelBtn').addEventListener('click', closeModal);
  $('modalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  boot();
})();
