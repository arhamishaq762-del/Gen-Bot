// CmdForge dashboard — all user-controlled data is rendered with
// textContent / element creation (never innerHTML) to prevent XSS. [§6]
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {
    me: null, guilds: [], inviteUrl: '#', guild: null, roles: [],
    commands: [], editing: null, emojis: [], emojiTarget: null,
  };

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const svgIcon = (name, cls = 'ic') => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', cls);
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', `/icons.svg#${name}`);
    s.appendChild(u);
    return s;
  };
  const iconText = (name, text, cls) => {
    const span = el('span', cls);
    span.appendChild(svgIcon(name, 'ic ic-xs'));
    span.appendChild(document.createTextNode(' ' + text));
    return span;
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

  // Server logo: real icon if the server has one, otherwise the Discord logo mark
  function guildLogo(g, container) {
    container.textContent = '';
    if (g.icon) {
      const img = el('img');
      img.src = `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`;
      img.alt = '';
      container.appendChild(img);
    } else {
      container.appendChild(svgIcon('i-discord', 'ic logo-fallback'));
    }
  }

  // ---------- boot ----------
  async function boot() {
    try {
      state.me = await api('/api/me');
    } catch { return; }
    renderUser();
    if (state.me.demo) $('demoPill').classList.remove('hidden');
    api('/api/admin/is-admin').then(r => { if (r.admin) $('adminLink').classList.remove('hidden'); }).catch(() => {});
    api('/api/emojis').then(r => { state.emojis = r.emojis || []; }).catch(() => {});
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
      empty.appendChild(svgIcon('i-server', 'ic ic-big'));
      empty.appendChild(el('p', null, 'No servers found where you have Administrator or Manage Server permission.'));
      grid.appendChild(empty);
      return;
    }
    for (const g of state.guilds) {
      const card = el('div', 'server-card' + (g.botIn ? '' : ' no-bot'));
      const icon = el('div', 'guild-icon');
      guildLogo(g, icon);
      card.appendChild(icon);

      const info = el('div');
      info.appendChild(el('h3', null, g.name));
      const badge = el('span', 'badge ' + (g.botIn ? 'badge-ok' : 'badge-invite'));
      badge.appendChild(svgIcon(g.botIn ? 'i-check' : 'i-plus', 'ic ic-xs'));
      badge.appendChild(document.createTextNode(g.botIn ? ' Bot active' : ' Bot not added'));
      info.appendChild(badge);
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
      guildLogo(info.guild, $('guildIcon'));

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
      empty.appendChild(svgIcon('i-terminal', 'ic ic-big'));
      empty.appendChild(el('p', null, 'No custom commands yet. Hit "New Command" to make your first one!'));
      list.appendChild(empty);
      return;
    }
    for (const c of state.commands) {
      const card = el('div', 'cmd-card' + (c.enabled ? '' : ' disabled'));
      card.appendChild(el('span', 'cmd-name', '/' + c.name));
      card.appendChild(el('span', 'cmd-desc', c.description));

      const tags = el('div', 'cmd-tags');
      tags.appendChild(iconText(c.response_type === 'embed' ? 'i-image' : 'i-chat', c.response_type, 'tag'));
      const dInfo = { channel: ['i-broadcast', 'public'], ephemeral: ['i-eye', 'hidden'], dm: ['i-mail', 'DM'] }[c.delivery];
      tags.appendChild(iconText(dInfo[0], dInfo[1], 'tag t-dm'));
      if (c.required_role_id) {
        const role = state.roles.find(r => r.id === c.required_role_id);
        tags.appendChild(iconText('i-lock', role ? '@' + role.name : 'role', 'tag t-role'));
      }
      if (c.req_min_messages > 0) tags.appendChild(iconText('i-award', `${c.req_min_messages} msgs`, 'tag t-req'));
      if (c.req_status_text) tags.appendChild(iconText('i-edit', 'status', 'tag t-req'));
      if (c.cooldown_seconds > 0) tags.appendChild(iconText('i-clock', fmtCd(c.cooldown_seconds), 'tag t-cd'));
      tags.appendChild(el('span', 'tag', `${c.uses} uses`));
      if (!c.enabled) tags.appendChild(el('span', 'tag', 'disabled'));
      card.appendChild(tags);

      const actions = el('div', 'cmd-actions');
      const editBtn = el('button', 'btn btn-sm');
      editBtn.appendChild(svgIcon('i-edit', 'ic ic-xs'));
      editBtn.appendChild(document.createTextNode(' Edit'));
      editBtn.addEventListener('click', () => openModal(c));
      const delBtn = el('button', 'btn btn-sm btn-danger');
      delBtn.appendChild(svgIcon('i-trash', 'ic ic-xs'));
      delBtn.title = 'Delete';
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
      updatePreview();
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
    updatePreview();
    $('modalBackdrop').classList.remove('hidden');
    $('fName').focus();
  }

  function closeModal() {
    $('modalBackdrop').classList.add('hidden');
    hideEmojiPop();
    state.editing = null;
  }

  // ---------- live preview ----------
  // Renders <:name:id> custom emoji codes as real images from Discord's CDN,
  // substitutes placeholders, and mirrors delivery/requirement settings.
  function renderRich(target, text) {
    target.textContent = '';
    if (!text) return;
    const filled = text
      .replaceAll('{user}', `@${state.me?.global_name || state.me?.username || 'user'}`)
      .replaceAll('{username}', state.me?.username || 'user')
      .replaceAll('{server}', state.guild?.name || 'this server');
    const re = /<(a?):([a-zA-Z0-9_]{1,64}):(\d{5,25})>/g;
    let last = 0, m;
    while ((m = re.exec(filled)) !== null) {
      if (m.index > last) target.appendChild(document.createTextNode(filled.slice(last, m.index)));
      const img = el('img', 'pv-emoji');
      img.src = `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] === 'a' ? 'gif' : 'png'}?size=32`;
      img.alt = `:${m[2]}:`;
      img.title = `:${m[2]}:`;
      target.appendChild(img);
      last = m.index + m[0].length;
    }
    if (last < filled.length) target.appendChild(document.createTextNode(filled.slice(last)));
  }

  function updatePreview() {
    const isEmbed = segType.get() === 'embed';
    const name = $('fName').value.trim() || 'command';
    $('pvCmdName').textContent = '/' + name;
    $('pvUser').textContent = state.me?.username || 'username';
    $('pvTime').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    renderRich($('pvContent'), $('fText').value);

    const embedBox = $('pvEmbed');
    if (isEmbed) {
      embedBox.classList.remove('hidden');
      $('pvEmbedBar').style.background = $('fEColor').value;
      renderRich($('pvEmbedTitle'), $('fETitle').value);
      renderRich($('pvEmbedDesc'), $('fEDesc').value);
      const imgUrl = $('fEImg').value.trim();
      const img = $('pvEmbedImg');
      if (/^https:\/\/[^\s]+$/i.test(imgUrl)) { img.src = imgUrl; img.classList.remove('hidden'); }
      else img.classList.add('hidden');
      $('pvEmbedFooter').textContent = $('fEFooter').value;
    } else {
      embedBox.classList.add('hidden');
    }

    // flags row: delivery + requirements + cooldown
    const flags = $('pvFlags');
    flags.textContent = '';
    const delivery = segDelivery.get();
    if (delivery === 'ephemeral') flags.appendChild(iconText('i-eye', 'Only the user can see this', 'pv-flag'));
    if (delivery === 'dm') flags.appendChild(iconText('i-mail', 'Sent via direct message', 'pv-flag'));
    const role = $('fRole');
    if (role.value) flags.appendChild(iconText('i-lock', `Requires ${role.options[role.selectedIndex].text}`, 'pv-flag'));
    const minMsg = parseInt($('fMinMsg').value, 10) || 0;
    if (minMsg > 0) flags.appendChild(iconText('i-award', `Requires ${minMsg} messages`, 'pv-flag'));
    if ($('fStatus').value.trim()) flags.appendChild(iconText('i-edit', 'Requires status text', 'pv-flag'));
    const cd = parseInt($('fCooldown').value, 10) || 0;
    if (cd > 0) flags.appendChild(iconText('i-clock', `${fmtCd(cd)} cooldown`, 'pv-flag'));
  }

  // live update on every input in the form
  ['fName', 'fText', 'fETitle', 'fEDesc', 'fEColor', 'fEImg', 'fEFooter', 'fCooldown', 'fMinMsg', 'fStatus']
    .forEach(id => $(id).addEventListener('input', updatePreview));
  $('fRole').addEventListener('change', updatePreview);

  // ---------- custom emoji picker ----------
  function hideEmojiPop() { $('emojiPop').classList.add('hidden'); state.emojiTarget = null; }

  function renderEmojiGrid(filter = '') {
    const grid = $('emojiGrid');
    grid.textContent = '';
    const f = filter.toLowerCase();
    const items = state.emojis.filter(e => !f || e.name.toLowerCase().includes(f) || e.guild.toLowerCase().includes(f));
    if (!items.length) {
      grid.appendChild(el('div', 'emoji-empty', state.emojis.length ? 'No emojis match.' : 'No custom emojis found on the bot\'s servers.'));
      return;
    }
    // group by server
    const byGuild = new Map();
    for (const e of items) {
      if (!byGuild.has(e.guild)) byGuild.set(e.guild, []);
      byGuild.get(e.guild).push(e);
    }
    for (const [gName, list] of byGuild) {
      grid.appendChild(el('div', 'emoji-group', gName));
      const row = el('div', 'emoji-row');
      for (const e of list) {
        const btn = el('button', 'emoji-item');
        btn.type = 'button';
        btn.title = `:${e.name}: (${e.guild})`;
        const img = el('img');
        img.src = `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=32`;
        img.alt = `:${e.name}:`;
        img.loading = 'lazy';
        btn.appendChild(img);
        btn.addEventListener('click', () => insertEmoji(e));
        row.appendChild(btn);
      }
      grid.appendChild(row);
    }
  }

  function insertEmoji(e) {
    const ta = state.emojiTarget;
    if (!ta) return;
    const code = `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
    const start = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + code + ta.value.slice(ta.selectionEnd ?? start);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + code.length;
    updatePreview();
  }

  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pop = $('emojiPop');
      const target = $(btn.dataset.target);
      if (!pop.classList.contains('hidden') && state.emojiTarget === target) { hideEmojiPop(); return; }
      state.emojiTarget = target;
      $('emojiSearch').value = '';
      renderEmojiGrid();
      pop.classList.remove('hidden');
      const r = btn.getBoundingClientRect();
      const popW = 320;
      pop.style.left = Math.max(8, Math.min(window.innerWidth - popW - 8, r.right - popW)) + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
      $('emojiSearch').focus();
    });
  });
  $('emojiSearch').addEventListener('input', (e) => renderEmojiGrid(e.target.value));
  $('emojiPop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', hideEmojiPop);

  // ---------- save ----------
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
        toast(`Created /${saved.command.name}`);
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('emojiPop').classList.contains('hidden')) hideEmojiPop();
      else closeModal();
    }
  });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  boot();
})();
