// CmdForge admin panel — XSS-safe DOM rendering (textContent only)
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
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

  async function api(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/'; throw new Error('unauthenticated'); }
    if (res.status === 404) { location.href = '/dashboard'; throw new Error('not admin'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast err';
    setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function statCard(iconName, label, value) {
    const c = el('div', 'stat-card');
    const ic = el('div', 'stat-ic');
    ic.appendChild(svgIcon(iconName));
    c.appendChild(ic);
    const box = el('div');
    box.appendChild(el('div', 'stat-val', String(value)));
    box.appendChild(el('div', 'stat-lbl', label));
    c.appendChild(box);
    return c;
  }

  function guildLogo(g, cls = 'guild-icon guild-icon-sm') {
    const icon = el('div', cls);
    if (g.icon) {
      const img = el('img');
      img.src = `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`;
      img.alt = '';
      icon.appendChild(img);
    } else {
      icon.appendChild(svgIcon('i-discord', 'ic logo-fallback'));
    }
    return icon;
  }

  function table(headers, rows) {
    const t = el('table');
    const thead = el('thead');
    const trh = el('tr');
    headers.forEach(h => trh.appendChild(el('th', null, h)));
    thead.appendChild(trh);
    t.appendChild(thead);
    const tbody = el('tbody');
    rows.forEach(cells => {
      const tr = el('tr');
      cells.forEach(c => {
        const td = el('td');
        if (c instanceof Node) td.appendChild(c); else td.textContent = String(c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    return t;
  }

  async function boot() {
    try {
      const me = await api('/api/me');
      const chip = $('userChip');
      if (me.avatar) { const img = el('img'); img.src = me.avatar; img.alt = ''; chip.appendChild(img); }
      else chip.appendChild(el('div', 'avatar-fallback', (me.username || '?')[0].toUpperCase()));
      chip.appendChild(el('span', null, me.global_name || me.username));

      const data = await api('/api/admin/overview');
      $('loader').classList.add('hidden');

      // stat cards
      const cards = $('statCards');
      cards.appendChild(statCard('i-server', 'Servers', data.totals.guilds));
      cards.appendChild(statCard('i-terminal', 'Commands', data.totals.commands));
      cards.appendChild(statCard('i-activity', 'Command uses', data.totals.uses));
      cards.appendChild(statCard('i-chat', 'Messages counted', data.totals.messagesCounted));
      cards.appendChild(statCard('i-clipboard', 'Audit entries', data.totals.auditEntries));

      // servers table
      const sRows = data.guilds.map(g => {
        const nameCell = el('div', 'cell-flex');
        nameCell.appendChild(guildLogo(g));
        nameCell.appendChild(el('span', null, g.name));
        return [nameCell, g.memberCount ?? '—', g.commandCount, g.totalUses];
      });
      $('serverTable').appendChild(table(['Server', 'Members', 'Commands', 'Uses'], sRows));

      // top commands
      const guildName = (id) => data.guilds.find(g => g.id === id)?.name || id;
      const tRows = data.topCommands.map(c => [
        el('span', 'cmd-name', '/' + c.name), guildName(c.guild_id), c.uses,
      ]);
      $('topTable').appendChild(
        tRows.length ? table(['Command', 'Server', 'Uses'], tRows) : el('div', 'empty-state', 'No commands created yet.')
      );

      // recent activity
      const list = $('activityList');
      if (!data.recentAudit.length) list.appendChild(el('div', 'empty-state', 'No activity yet.'));
      for (const e of data.recentAudit) {
        const row = el('div', 'audit-row');
        const kind = e.action.split('.')[1] || 'update';
        row.appendChild(el('span', 'audit-act ' + kind, kind.toUpperCase()));
        row.appendChild(el('span', null, `${e.actor_tag || e.actor_id} — ${e.detail} (${guildName(e.guild_id)})`));
        row.appendChild(el('span', 'when', new Date(e.created_at + 'Z').toLocaleString()));
        list.appendChild(row);
      }
    } catch (err) {
      $('loader').classList.add('hidden');
      toast(err.message);
    }
  }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('tabServers').classList.toggle('hidden', t.dataset.tab !== 'servers');
    $('tabTop').classList.toggle('hidden', t.dataset.tab !== 'top');
    $('tabActivity').classList.toggle('hidden', t.dataset.tab !== 'activity');
  }));
  $('logoutBtn').addEventListener('click', async () => {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    location.href = '/';
  });
  $('brandHome').addEventListener('click', () => location.href = '/dashboard');

  boot();
})();
