/* ==========================================================
   Familien-App – app.js
   Vanilla JS, keine Frameworks. Firebase Firestore (compat SDK)
   für die geräteübergreifende Synchronisierung.
   ========================================================== */

const ADMIN_NAME = 'Alex';
const DAILY_MENUS = ['kalender', 'tasks', 'chat', 'konto', 'ideen'];
const MENU_LABELS = { kalender: 'Kalender', tasks: 'Aufgaben', chat: 'Chat', konto: 'Konto', ideen: 'Ideen' };
const DEFAULT_ORDER = ['bonus', 'konto', 'essen', 'wichtig', 'krankHeute', 'krankStatistik', 'termine', 'spiele', 'letzterSieg'];
const DEFAULT_PALETTE = ['#74AFC6', '#86B96C', '#DA8578', '#A692C4', '#E3A857', '#5FA8A0'];

// ---------- Firebase init ----------
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const AUTH_EMAIL_DOMAIN = '@familienapp.local'; // interne, nicht echte Adresse – nur für Firebase Auth nötig
const FieldValue = firebase.firestore.FieldValue;

// ---------- Local state ----------
let usersMap = {};        // lowercase name -> user doc data (incl. id)
let usersLoaded = false;
let currentUser = null;   // { id/name, ...colors }
let currentScreen = 'home';
let homeOrder = DEFAULT_ORDER.slice();
let importantText = '';
let todayMealText = '';
let dailyActivityData = null;
let unsubscribers = [];

const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const isAdmin = (name) => name === ADMIN_NAME;

const euro = (n) => {
  const v = Number(n || 0);
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2).replace('.', ',') + ' €';
};

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function confirmModal(title, text, confirmLabel = 'Löschen') {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-box">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(text)}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="modal-cancel">Abbrechen</button>
            <button class="btn btn-danger" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    root.querySelector('#modal-cancel').onclick = () => { root.innerHTML = ''; resolve(false); };
    root.querySelector('#modal-confirm').onclick = () => { root.innerHTML = ''; resolve(true); };
  });
}

// ==========================================================
// LOGIN / IDENTITY
// ==========================================================

function userColor(userData, kind /* 'color' | 'border' */) {
  if (!userData) return null;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const field = kind + (theme === 'dark' ? 'Dark' : 'Light');
  return userData[field] || null;
}

function subscribeUsers() {
  db.collection('users').onSnapshot((snap) => {
    const map = {};
    snap.forEach((doc) => { map[doc.id.toLowerCase()] = { id: doc.id, ...doc.data() }; });
    usersMap = map;
    usersLoaded = true;

    // Keep currentUser fresh (colors etc. may change live from Admin)
    if (currentUser && map[currentUser.id.toLowerCase()]) {
      currentUser = map[currentUser.id.toLowerCase()];
    }

    if (currentUser) {
      renderTaskAssigneeOptions();
      renderAdminUsers();
      applyUserTheme();
      renderShopping();
      renderTasks();
      renderHomeSickToday();
      renderHomeSickStats();
      if (isAdmin(currentUser.name)) renderAdminSickCalendars();
      renderGym();
      renderSpezialKalender();
      renderLoginLogs();
      renderAdminTournaments();
      renderGames();
      renderHomeGames();
      renderHomeLastWin();
      subscribeAllTransactions();
    }
    tryResolveLogin();
  });
}

// pendingAuthUser: undefined = not yet known, null = signed out, object = signed in
let pendingAuthUser;

auth.onAuthStateChanged((user) => {
  pendingAuthUser = user;
  tryResolveLogin();
});

function tryResolveLogin() {
  if (currentUser || !usersLoaded || pendingAuthUser === undefined) return;
  if (!pendingAuthUser) { showLogin(); return; }
  const name = pendingAuthUser.email.split('@')[0];
  const match = usersMap[name.toLowerCase()];
  if (match) {
    loginAs(match);
  } else {
    auth.signOut(); // Auth-Konto ohne passenden Nutzer-Eintrag – zur Sicherheit abmelden
  }
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-shell').style.display = 'none';
}

async function handleLoginSubmit() {
  const nameInput = document.getElementById('login-name-input');
  const passInput = document.getElementById('login-password-input');
  const errEl = document.getElementById('login-error');
  const name = nameInput.value.trim();
  const password = passInput.value;
  errEl.textContent = '';
  if (!usersLoaded) { errEl.textContent = 'Einen Moment, Daten werden geladen...'; return; }
  if (!name || !password) { errEl.textContent = 'Bitte Name und Passwort eingeben.'; return; }

  const existing = usersMap[name.toLowerCase()];
  const email = name.toLowerCase() + AUTH_EMAIL_DOMAIN;

  if (!existing && name.toLowerCase() !== ADMIN_NAME.toLowerCase()) {
    errEl.textContent = 'Dieser Name ist nicht bekannt. Bitte wende dich an Alex.';
    return;
  }

  // Try a normal sign-in first (covers everyone who already has a password set).
  try {
    await auth.signInWithEmailAndPassword(email, password);
    return; // success
  } catch (signInErr) {
    // fall through: maybe this name (existing OR the very first "Alex") has no
    // Auth account yet — createUserWithEmailAndPassword below will tell us
    // authoritatively whether that's true or whether it's just a wrong password.
  }

  if (password.length < 6) { errEl.textContent = 'Bitte ein Passwort mit mind. 6 Zeichen vergeben (Ersteinrichtung).'; return; }
  try {
    await auth.createUserWithEmailAndPassword(email, password);
    if (!existing) {
      const data = defaultUserColors(0);
      await db.collection('users').doc(ADMIN_NAME).set({ name: ADMIN_NAME, ...data, createdAt: FieldValue.serverTimestamp() });
    }
  } catch (createErr) {
    if (createErr.code === 'auth/email-already-in-use') {
      errEl.textContent = 'Falscher Name oder falsches Passwort.';
    } else {
      errEl.textContent = 'Fehler: ' + createErr.message;
    }
  }
}

function defaultUserColors(index) {
  const c = DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
  return { colorLight: c, borderLight: c, colorDark: c, borderDark: c };
}

function loginAs(userData) {
  currentUser = userData;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'block';
  document.getElementById('settings-item-admin').style.display = isAdmin(currentUser.name) ? '' : 'none';
  document.getElementById('settings-item-spezialkalender').style.display = isAdmin(currentUser.name) ? '' : 'none';
  startAppListeners();
  showScreen('home');
}

function logout() {
  auth.signOut().then(() => location.reload());
}

// ==========================================================
// THEME (dark / light)
// ==========================================================

function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  applyUserTheme();
}

function applyUserTheme() {
  // Re-render pieces whose colors depend on the active theme
  renderChat(lastChatDocs);
  renderIdeas(lastIdeaDocs);
  renderKonto();
  renderAdminUsers();
}

function initDarkModePreference() {
  const cached = localStorage.getItem('familienapp_darkmode');
  applyTheme(cached === 'light' ? 'light' : 'dark'); // default = dark
  document.getElementById('darkmode-toggle').checked = (cached !== 'light');

  db.collection('settings').doc(currentUser.name).onSnapshot((doc) => {
    if (doc.exists) {
      const data = doc.data();
      const dark = data.darkMode !== false;
      applyTheme(dark ? 'dark' : 'light');
      document.getElementById('darkmode-toggle').checked = dark;
      localStorage.setItem('familienapp_darkmode', dark ? 'dark' : 'light');
      lastSeenChat = data.lastSeenChat || 0;
      lastSeenIdeas = data.lastSeenIdeas || 0;
      lastSeenTasks = data.lastSeenTasks || 0;
      renderNavBadges();
    }
  });
}

// ---------- Ungelesen-Anzeige (Chat / Ideen / Aufgaben) ----------
let lastSeenChat = 0;
let lastSeenIdeas = 0;
let lastSeenTasks = 0;

function markChatSeen() {
  lastSeenChat = Date.now();
  db.collection('settings').doc(currentUser.name).set({ lastSeenChat }, { merge: true });
  renderNavBadges();
}

function markIdeasSeen() {
  lastSeenIdeas = Date.now();
  db.collection('settings').doc(currentUser.name).set({ lastSeenIdeas }, { merge: true });
  renderNavBadges();
}

function markTasksSeen() {
  lastSeenTasks = Date.now();
  db.collection('settings').doc(currentUser.name).set({ lastSeenTasks }, { merge: true });
  renderNavBadges();
}

function renderNavBadges() {
  const hasUnreadChat = (lastChatDocs || []).some((m) =>
    !m.system && m.author !== currentUser.name && m.createdAt && m.createdAt.toDate && m.createdAt.toDate().getTime() > lastSeenChat
  );
  const hasUnreadIdeas = (lastIdeaDocs || []).some((i) =>
    i.author !== currentUser.name && i.createdAt && i.createdAt.toDate && i.createdAt.toDate().getTime() > lastSeenIdeas
  );
  const hasUnreadTasks = (lastTaskDocs || []).some((t) =>
    t.assignedTo === currentUser.name && t.createdAt && t.createdAt.toDate && t.createdAt.toDate().getTime() > lastSeenTasks
  );
  document.getElementById('nav-badge-chat').classList.toggle('show', hasUnreadChat);
  document.getElementById('nav-badge-ideen').classList.toggle('show', hasUnreadIdeas);
  document.getElementById('settings-badge-ideen').classList.toggle('show', hasUnreadIdeas);
  document.getElementById('nav-badge-tasks').classList.toggle('show', hasUnreadTasks);
}

document.getElementById('darkmode-toggle').addEventListener('change', (e) => {
  const dark = e.target.checked;
  applyTheme(dark ? 'dark' : 'light');
  localStorage.setItem('familienapp_darkmode', dark ? 'dark' : 'light');
  db.collection('settings').doc(currentUser.name).set({ darkMode: dark }, { merge: true });
});


// ==========================================================
// NAVIGATION
// ==========================================================

function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === name || ((name === 'admin' || name === 'birthdays' || name === 'spezial' || name === 'ideen') && b.dataset.target === 'settings')));

  if (name === 'home') {
    logHomeView();
    maybeShowBirthdayConfetti();
  }
  if (name === 'aktuell') {
    const chatPanelActive = document.getElementById('aktuell-panel-chat').classList.contains('active');
    if (chatPanelActive) {
      scrollChatToBottom();
      markChatSeen();
      markMenuVisited('chat');
    }
    renderMonthCalendar();
    if (document.getElementById('aktuell-panel-gym').classList.contains('active')) {
      onGymTabOpened();
    }
  }
  if (name === 'ideen') {
    markIdeasSeen();
  }
  if (name === 'tasks') {
    markTasksSeen();
  }

  if (name === 'games') {
    resetGamesView();
    renderGames();
  } else {
    suLeave();
  }
  updateGamesBadge();

  if (DAILY_MENUS.includes(name)) {
    markMenuVisited(name);
  }
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showScreen(btn.dataset.target));
});

document.getElementById('login-submit-btn').addEventListener('click', handleLoginSubmit);
document.getElementById('login-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLoginSubmit(); });
document.getElementById('login-password-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLoginSubmit(); });

// ==========================================================
// DAILY ACTIVITY / 50-CENT BONUS
// ==========================================================

function dailyDocRef() {
  return db.collection('dailyActivity').doc(currentUser.name + '_' + todayStr());
}

function subscribeDailyActivity() {
  return dailyDocRef().onSnapshot((doc) => {
    dailyActivityData = doc.exists ? doc.data() : { menus: {}, chatSent: false, bonusGiven: false };
    renderHomeChecklist();
  });
}

async function markMenuVisited(menuKey) {
  const ref = dailyDocRef();
  await ref.set({ menus: { [menuKey]: true } }, { merge: true });
  await maybeAwardBonus();
}

async function markChatSent() {
  const ref = dailyDocRef();
  await ref.set({ chatSent: true }, { merge: true });
  await maybeAwardBonus();
}

async function maybeAwardBonus() {
  const snap = await dailyDocRef().get();
  const data = snap.exists ? snap.data() : {};
  if (data.bonusGiven) return;
  const allMenus = DAILY_MENUS.every((m) => data.menus && data.menus[m]);
  if (allMenus && data.chatSent) {
    await dailyDocRef().set({ bonusGiven: true }, { merge: true });
    const todayLabel = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    await addTransaction(currentUser.name, 0.5, `Tages-Bonus (${todayLabel})`, true);
    toast('🎉 50 Cent Tages-Bonus erhalten!');
  }
}

function renderHomeChecklist() {
  const el = document.getElementById('home-checklist-content');
  if (!dailyActivityData) { el.innerHTML = ''; return; }
  if (dailyActivityData.bonusGiven) {
    el.innerHTML = `<div class="checklist-done-banner">🎉 Heute schon erhalten!</div>`;
    return;
  }
  const chips = DAILY_MENUS.map((m) => {
    const visited = !!(dailyActivityData.menus && dailyActivityData.menus[m]);
    return `<span class="chip ${visited ? 'visited' : ''}">${visited ? '✓' : '○'} ${MENU_LABELS[m]}</span>`;
  }).join('');
  const chatChip = `<span class="chip ${dailyActivityData.chatSent ? 'visited' : ''}">${dailyActivityData.chatSent ? '✓' : '○'} Nachricht geschrieben</span>`;
  el.innerHTML = `<div class="chip-row">${chips}${chatChip}</div>`;
}

// ==========================================================
// HOME SCREEN (greeting, balance, meal, important)
// ==========================================================

function renderHomeGreeting() {
  document.getElementById('home-greeting').textContent = `Hallo ${currentUser.name}!`;
  const d = new Date();
  document.getElementById('home-date').textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderHomeOrder() {
  const container = document.getElementById('home-orderable');
  homeOrder.forEach((key) => {
    const card = document.getElementById('home-card-' + key);
    if (card) container.appendChild(card);
  });
}

function renderHomeMeal() {
  const card = document.getElementById('home-card-essen');
  if (todayMealText) {
    card.style.display = '';
    document.getElementById('home-meal-text').textContent = todayMealText;
  } else {
    card.style.display = 'none';
  }
}

function renderHomeImportant() {
  const card = document.getElementById('home-card-wichtig');
  if (importantText && importantText.trim()) {
    card.style.display = '';
    document.getElementById('home-important-text').textContent = importantText;
  } else {
    card.style.display = 'none';
  }
}

function renderHomeBalance() {
  db.collection('accounts').doc(currentUser.name).onSnapshot((doc) => {
    const balance = doc.exists ? (doc.data().balance || 0) : 0;
    const el = document.getElementById('home-balance');
    el.textContent = balance.toFixed(2).replace('.', ',') + ' €';
    el.className = 'balance-value ' + (balance < 0 ? 'negative' : balance > 0 ? 'positive' : '');
  });
}

// ==========================================================
// EINKAUFEN (shopping list)
// ==========================================================

let lastShoppingDocs = [];

function subscribeShopping() {
  return db.collection('shopping').orderBy('createdAt', 'asc').onSnapshot((snap) => {
    lastShoppingDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderShopping();
  });
}

function renderShopping() {
  const el = document.getElementById('shopping-list');
  if (!lastShoppingDocs.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">🛒</span>Die Einkaufsliste ist leer.</div>`;
    return;
  }
  const groups = {};
  lastShoppingDocs.forEach((item) => {
    const key = item.addedBy || 'Unbekannt';
    (groups[key] = groups[key] || []).push(item);
  });
  let html = '';
  Object.keys(groups).forEach((user) => {
    const userData = usersMap[user.toLowerCase()];
    const color = userData ? userColor(userData, 'color') : null;
    html += `<div class="list-group-title" style="${color ? `color:${color}` : ''}">${escapeHtml(user)}</div>`;
    groups[user].forEach((item) => {
      html += `
        <div class="list-item ${item.checked ? 'done' : ''}">
          <div class="item-check ${item.checked ? 'checked' : ''}" data-id="${item.id}" data-checked="${item.checked ? '1' : '0'}">${item.checked ? '✓' : ''}</div>
          <div class="item-text">${escapeHtml(item.text)}</div>
        </div>`;
    });
  });
  el.innerHTML = html;
  el.querySelectorAll('.item-check').forEach((chk) => {
    chk.addEventListener('click', () => {
      const id = chk.dataset.id;
      const newVal = chk.dataset.checked !== '1';
      db.collection('shopping').doc(id).update({ checked: newVal });
    });
  });
}

document.getElementById('shopping-add-btn').addEventListener('click', addShoppingItem);
document.getElementById('shopping-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addShoppingItem(); });

function addShoppingItem() {
  const input = document.getElementById('shopping-input');
  const text = input.value.trim();
  if (!text) return;
  db.collection('shopping').add({ text, addedBy: currentUser.name, checked: false, createdAt: FieldValue.serverTimestamp() });
  input.value = '';
}

document.getElementById('shopping-delete-checked-btn').addEventListener('click', async () => {
  const checkedItems = lastShoppingDocs.filter((i) => i.checked);
  if (!checkedItems.length) { toast('Keine erledigten Einträge zum Löschen.'); return; }
  const ok = await confirmModal('Erledigte löschen?', `${checkedItems.length} abgehakte Einträge werden endgültig gelöscht.`);
  if (!ok) return;
  const batch = db.batch();
  checkedItems.forEach((i) => batch.delete(db.collection('shopping').doc(i.id)));
  await batch.commit();
  toast('Erledigte Einträge gelöscht.');
});

// ==========================================================
// AUFGABEN (tasks)
// ==========================================================

let lastTaskDocs = [];

function subscribeTasks() {
  return db.collection('tasks').orderBy('createdAt', 'asc').onSnapshot((snap) => {
    lastTaskDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTasks();
    if (currentScreen === 'tasks') {
      markTasksSeen();
    } else {
      renderNavBadges();
    }
  });
}

function renderTaskAssigneeOptions() {
  const select = document.getElementById('task-assignee-select');
  if (!select) return;
  const names = Object.values(usersMap).map((u) => u.name).sort();
  select.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

function renderTasks() {
  const el = document.getElementById('tasks-list');
  if (!lastTaskDocs.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">✅</span>Keine Aufgaben offen.</div>`;
    return;
  }
  const sortedTasks = lastTaskDocs.slice().sort((a, b) => {
    const da = a.dueDate || '9999-99-99';
    const db_ = b.dueDate || '9999-99-99';
    return da < db_ ? -1 : da > db_ ? 1 : 0;
  });
  const today = todayStr();
  el.innerHTML = sortedTasks.map((t) => {
    const assigneeData = usersMap[(t.assignedTo || '').toLowerCase()];
    const assigneeColor = assigneeData ? userColor(assigneeData, 'color') : null;
    const borderColor = assigneeData ? userColor(assigneeData, 'border') : null;
    const isOverdue = t.dueDate && !t.done && t.dueDate < today;
    const isDueToday = t.dueDate === today && !t.done;
    const dueLabel = t.dueDate ? new Date(t.dueDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    return `
    <div class="list-item ${t.done ? 'done' : ''} ${isDueToday ? 'due-today' : ''}" style="${borderColor ? `border-color:${borderColor}` : ''}">
      <div class="item-check ${t.done ? 'checked' : ''}" data-id="${t.id}" data-checked="${t.done ? '1' : '0'}">${t.done ? '✓' : ''}</div>
      <div style="flex:1;">
        <div class="item-text">${escapeHtml(t.text)}</div>
        <div class="item-meta">für <span style="${assigneeColor ? `color:${assigneeColor};font-weight:600;` : ''}">${escapeHtml(t.assignedTo || '–')}</span>${t.dueDate ? `<span class="task-due ${isOverdue ? 'overdue' : ''}">${isOverdue ? '⚠️ ' : '📅 '}${dueLabel}</span>` : ''}</div>
      </div>
      ${isAdmin(currentUser.name) ? `<button class="btn-icon" data-delete-id="${t.id}" title="Löschen">🗑️</button>` : ''}
    </div>`;
  }).join('');

  el.querySelectorAll('.item-check').forEach((chk) => {
    chk.addEventListener('click', () => {
      db.collection('tasks').doc(chk.dataset.id).update({ done: chk.dataset.checked !== '1' });
    });
  });
  el.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmModal('Aufgabe löschen?', 'Diese Aufgabe wird endgültig entfernt.');
      if (ok) db.collection('tasks').doc(btn.dataset.deleteId).delete();
    });
  });
}

document.getElementById('task-add-btn').addEventListener('click', addTask);
document.getElementById('task-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });

function addTask() {
  const input = document.getElementById('task-input');
  const select = document.getElementById('task-assignee-select');
  const dueInput = document.getElementById('task-due-input');
  const text = input.value.trim();
  if (!text) return;
  db.collection('tasks').add({
    text, assignedTo: select.value || currentUser.name, done: false,
    dueDate: dueInput.value || null,
    createdBy: currentUser.name, createdAt: FieldValue.serverTimestamp()
  });
  input.value = '';
  dueInput.value = '';
}

// ==========================================================
// GERICHTE (dish/recipe reference list)
// ==========================================================

let lastDishDocs = [];
let dishEditingId = null;

function subscribeDishes() {
  return db.collection('dishes').orderBy('text', 'asc').onSnapshot((snap) => {
    lastDishDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDishes();
  });
}

function renderDishes() {
  const el = document.getElementById('dishes-list');
  if (!lastDishDocs.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">🍽️</span>Noch keine Gerichte eingetragen.</div>`;
    return;
  }
  el.innerHTML = lastDishDocs.map((d) => {
    if (d.id === dishEditingId) {
      return `
        <div class="list-item">
          <input type="text" class="dish-edit-input" data-edit-input="${d.id}" value="${escapeHtml(d.text)}" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);">
          <button class="btn-icon" data-save-dish="${d.id}" title="Speichern">✓</button>
          <button class="btn-icon" data-cancel-dish="1" title="Abbrechen">✕</button>
        </div>`;
    }
    return `
      <div class="list-item">
        <div class="item-text" style="flex:1;">${escapeHtml(d.text)}</div>
        <button class="btn-icon" data-edit-dish="${d.id}" title="Bearbeiten">✏️</button>
        ${isAdmin(currentUser.name) ? `<button class="btn-icon" data-delete-dish="${d.id}" title="Löschen">🗑️</button>` : ''}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-edit-dish]').forEach((btn) => {
    btn.addEventListener('click', () => { dishEditingId = btn.dataset.editDish; renderDishes(); });
  });
  el.querySelectorAll('[data-cancel-dish]').forEach((btn) => {
    btn.addEventListener('click', () => { dishEditingId = null; renderDishes(); });
  });
  el.querySelectorAll('[data-save-dish]').forEach((btn) => {
    btn.addEventListener('click', () => saveDishEdit(btn.dataset.saveDish));
  });
  el.querySelectorAll('[data-edit-input]').forEach((input) => {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDishEdit(input.dataset.editInput); });
  });
  el.querySelectorAll('[data-delete-dish]').forEach((btn) => {
    btn.addEventListener('click', () => deleteDish(btn.dataset.deleteDish));
  });
}

function saveDishEdit(id) {
  const input = document.querySelector(`[data-edit-input="${CSS.escape(id)}"]`);
  const text = input.value.trim();
  if (!text) return;
  db.collection('dishes').doc(id).update({ text });
  dishEditingId = null;
}

async function deleteDish(id) {
  const ok = await confirmModal('Gericht löschen?', 'Dieses Gericht wird endgültig aus der Liste entfernt.');
  if (ok) db.collection('dishes').doc(id).delete();
}

document.getElementById('dish-add-btn').addEventListener('click', addDish);
document.getElementById('dish-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDish(); });

function addDish() {
  const input = document.getElementById('dish-input');
  const text = input.value.trim();
  if (!text) return;
  db.collection('dishes').add({ text, createdBy: currentUser.name, createdAt: FieldValue.serverTimestamp() });
  input.value = '';
}

// ==========================================================
// CUSTOM LISTEN — jeder legt eigene Listen an, mit Besitzer,
// optionaler Freigabe an andere Nutzer (nur Ansicht) und
// Kommentaren von Betrachtern.
// ==========================================================

function ratingOptionsHtml(selected) {
  let html = '';
  for (let i = 1; i <= 10; i++) {
    html += `<option value="${i}" ${i === selected ? 'selected' : ''}>${i}</option>`;
  }
  return html;
}

let customListsRaw = [];
let activeCustomListId = null;
let activeCustomIsOwner = false;
let activeCustomEntries = [];
let activeCustomComments = [];
let activeCustomEntryUnsub = null;
let activeCustomCommentUnsub = null;
let activeCustomEditingEntryId = null;
let activeCustomSort = 'name-asc';

// One-time migration: the three original admin-only lists (Gaming/Spiele/Serien)
// become normal Custom Listen owned by Alex, carrying over their old entries.
async function migrateNerdListsOnce() {
  const seeds = [
    { id: 'gaming', title: 'Gaming' },
    { id: 'spiele', title: 'Spiele' },
    { id: 'serien', title: 'Serien' }
  ];
  for (const seed of seeds) {
    try {
      const ref = db.collection('customLists').doc(seed.id);
      const docSnap = await ref.get();
      if (docSnap.exists) continue;
      await ref.set({ title: seed.title, owner: ADMIN_NAME, sharedWith: [], createdAt: FieldValue.serverTimestamp() });
      const oldEntriesSnap = await db.collection('nerdEntries').where('category', '==', seed.id).get();
      if (!oldEntriesSnap.empty) {
        const batch = db.batch();
        oldEntriesSnap.forEach((d) => {
          const data = d.data();
          batch.set(ref.collection('entries').doc(), {
            name: data.name, rating: data.rating, createdAt: data.createdAt || FieldValue.serverTimestamp()
          });
        });
        await batch.commit();
      }
    } catch (err) {
      console.error('Migration fehlgeschlagen für', seed.id, err);
    }
  }
}

function subscribeCustomLists() {
  return db.collection('customLists').onSnapshot((snap) => {
    customListsRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCustomLists();
  });
}

function renderCustomLists() {
  const mineEl = document.getElementById('custom-my-lists');
  const sharedEl = document.getElementById('custom-shared-lists');
  if (!mineEl || !sharedEl) return;

  const mine = customListsRaw.filter((l) => l.owner.toLowerCase() === currentUser.name.toLowerCase());
  const shared = customListsRaw.filter((l) =>
    l.owner.toLowerCase() !== currentUser.name.toLowerCase() &&
    (l.sharedWith || []).some((n) => n.toLowerCase() === currentUser.name.toLowerCase())
  );

  mineEl.innerHTML = mine.length ? mine.map((l) => `
    <div class="custom-list-card">
      <div class="item-text">${escapeHtml(l.title)}</div>
      <button class="btn btn-secondary btn-small" data-open-list="${l.id}">Öffnen</button>
      <button class="btn-icon" data-delete-list="${l.id}" title="Liste löschen">🗑️</button>
    </div>`).join('') : `<div class="empty-state"><span class="emoji">📋</span>Noch keine eigene Liste.</div>`;

  sharedEl.innerHTML = shared.length ? shared.map((l) => {
    const ownerData = usersMap[l.owner.toLowerCase()];
    const ownerColor = ownerData ? userColor(ownerData, 'color') : null;
    return `
    <div class="custom-list-card">
      <div style="flex:1;">
        <div class="item-text">${escapeHtml(l.title)}</div>
        <div class="item-meta">von <span style="${ownerColor ? `color:${ownerColor};font-weight:600;` : ''}">${escapeHtml(l.owner)}</span></div>
      </div>
      <button class="btn btn-secondary btn-small" data-open-list="${l.id}">Öffnen</button>
    </div>`;
  }).join('') : `<div class="empty-state"><span class="emoji">👀</span>Noch nichts mit dir geteilt.</div>`;

  document.querySelectorAll('[data-open-list]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const list = customListsRaw.find((l) => l.id === btn.dataset.openList);
      if (list) openCustomListModal(list);
    });
  });
  document.querySelectorAll('[data-delete-list]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCustomList(btn.dataset.deleteList));
  });
}

document.querySelectorAll('[data-custom-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-custom-view]').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('custom-view-mine').style.display = btn.dataset.customView === 'mine' ? '' : 'none';
    document.getElementById('custom-view-shared').style.display = btn.dataset.customView === 'shared' ? '' : 'none';
  });
});

document.getElementById('custom-add-list-btn').addEventListener('click', addCustomList);
document.getElementById('custom-new-list-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomList(); });

function addCustomList() {
  const input = document.getElementById('custom-new-list-input');
  const title = input.value.trim();
  if (!title) return;
  db.collection('customLists').add({ title, owner: currentUser.name, sharedWith: [], createdAt: FieldValue.serverTimestamp() });
  input.value = '';
}

async function deleteCustomList(listId) {
  const ok = await confirmModal('Liste löschen?', 'Die komplette Liste inkl. aller Einträge und Kommentare wird endgültig gelöscht.');
  if (!ok) return;
  const ref = db.collection('customLists').doc(listId);
  const [entriesSnap, commentsSnap] = await Promise.all([ref.collection('entries').get(), ref.collection('comments').get()]);
  const batch = db.batch();
  entriesSnap.forEach((d) => batch.delete(d.ref));
  commentsSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();
  if (activeCustomListId === listId) closeCustomListModal();
  toast('Liste gelöscht.');
}

function openCustomListModal(list) {
  activeCustomListId = list.id;
  activeCustomIsOwner = list.owner.toLowerCase() === currentUser.name.toLowerCase();
  activeCustomEditingEntryId = null;
  activeCustomSort = 'name-asc';
  activeCustomEntries = [];
  activeCustomComments = [];

  if (activeCustomEntryUnsub) activeCustomEntryUnsub();
  if (activeCustomCommentUnsub) activeCustomCommentUnsub();

  activeCustomEntryUnsub = db.collection('customLists').doc(list.id).collection('entries').onSnapshot((snap) => {
    activeCustomEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (activeCustomListId === list.id) renderCustomModalBody(list);
  });
  activeCustomCommentUnsub = db.collection('customLists').doc(list.id).collection('comments').orderBy('createdAt', 'asc').onSnapshot((snap) => {
    activeCustomComments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (activeCustomListId === list.id) renderCustomModalBody(list);
  });

  renderCustomModalBody(list);
}

function closeCustomListModal() {
  if (activeCustomEntryUnsub) { activeCustomEntryUnsub(); activeCustomEntryUnsub = null; }
  if (activeCustomCommentUnsub) { activeCustomCommentUnsub(); activeCustomCommentUnsub = null; }
  activeCustomListId = null;
  document.getElementById('modal-root').innerHTML = '';
}

function renderCustomModalBody(list) {
  const root = document.getElementById('modal-root');
  const isOwner = activeCustomIsOwner;

  const entries = activeCustomEntries.slice().sort((a, b) => {
    if (activeCustomSort === 'name-asc') return a.name.localeCompare(b.name);
    if (activeCustomSort === 'name-desc') return b.name.localeCompare(a.name);
    if (activeCustomSort === 'rating-desc') return b.rating - a.rating;
    if (activeCustomSort === 'rating-asc') return a.rating - b.rating;
    return 0;
  });

  const entriesHtml = entries.length ? entries.map((item) => {
    if (isOwner && item.id === activeCustomEditingEntryId) {
      return `
        <div class="list-item">
          <input type="text" data-custom-edit-name="${item.id}" value="${escapeHtml(item.name)}" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);">
          <select data-custom-edit-rating="${item.id}">${ratingOptionsHtml(item.rating)}</select>
          <button class="btn-icon" data-custom-save-entry="${item.id}" title="Speichern">✓</button>
          <button class="btn-icon" data-custom-cancel-entry="1" title="Abbrechen">✕</button>
        </div>`;
    }
    return `
      <div class="list-item">
        <div class="item-text" style="flex:1;">${escapeHtml(item.name)}</div>
        <span class="task-due">${item.rating}/10</span>
        ${isOwner ? `
          <button class="btn-icon" data-custom-edit-entry="${item.id}" title="Bearbeiten">✏️</button>
          <button class="btn-icon" data-custom-delete-entry="${item.id}" title="Löschen">🗑️</button>` : ''}
      </div>`;
  }).join('') : `<div class="empty-state"><span class="emoji">📋</span>Noch keine Einträge.</div>`;

  const addRowHtml = isOwner ? `
    <div class="add-bar">
      <input type="text" id="custom-entry-name-input" placeholder="Name...">
      <select id="custom-entry-rating-input">${ratingOptionsHtml(5)}</select>
      <button class="btn btn-primary btn-small" id="custom-entry-add-btn">+</button>
    </div>` : '';

  const shareHtml = isOwner ? `
    <div class="appt-form-group" style="margin-top:16px;">
      <label>Freigeben für</label>
      ${Object.values(usersMap).filter((u) => u.name.toLowerCase() !== currentUser.name.toLowerCase()).map((u) => {
        const checked = (list.sharedWith || []).some((n) => n.toLowerCase() === u.name.toLowerCase());
        const uColor = userColor(u, 'color');
        return `
          <div class="custom-share-row">
            <label style="${uColor ? `color:${uColor};font-weight:600;` : ''}">${escapeHtml(u.name)}</label>
            <input type="checkbox" data-share-user="${escapeHtml(u.name)}" ${checked ? 'checked' : ''}>
          </div>`;
      }).join('')}
    </div>` : (() => {
      const ownerData = usersMap[list.owner.toLowerCase()];
      const ownerColor = ownerData ? userColor(ownerData, 'color') : null;
      return `<div class="section-note" style="margin-top:16px;">Besitzer: <span style="${ownerColor ? `color:${ownerColor};font-weight:600;` : ''}">${escapeHtml(list.owner)}</span></div>`;
    })();

  const commentsHtml = activeCustomComments.length ? activeCustomComments.map((c) => {
    const authorData = usersMap[(c.author || '').toLowerCase()];
    const textColor = authorData ? userColor(authorData, 'color') : null;
    const borderColor = authorData ? userColor(authorData, 'border') : null;
    return `
    <div class="custom-comment" style="${borderColor ? `border:2px solid ${borderColor};` : ''}">
      <div class="comment-head">
        <span class="comment-author" style="${textColor ? `color:${textColor};` : ''}">${escapeHtml(c.author)}</span>
        <span class="comment-time">${formatTime(c.createdAt)}</span>
      </div>
      <div class="comment-text">${escapeHtml(c.text)}</div>
      ${isOwner ? `<button class="btn-icon" data-delete-comment="${c.id}" style="margin-top:4px;" title="Löschen">🗑️</button>` : ''}
    </div>`;
  }).join('') : `<div class="section-note">Noch keine Kommentare.</div>`;

  const addCommentHtml = !isOwner ? `
    <div class="add-bar">
      <input type="text" id="custom-comment-input" placeholder="Kommentar schreiben...">
      <button class="btn btn-primary btn-small" id="custom-comment-add-btn">+</button>
    </div>` : '';

  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box" style="max-width:440px;width:92%;text-align:left;max-height:88vh;overflow-y:auto;">
        <h3>${escapeHtml(list.title)}</h3>
        <div class="list-toolbar" style="justify-content:flex-start;gap:8px;margin-top:10px;">
          <label style="font-size:0.82rem;color:var(--text-muted);align-self:center;">Sortieren:</label>
          <select class="custom-sort-select" id="custom-sort-select">
            <option value="name-asc" ${activeCustomSort === 'name-asc' ? 'selected' : ''}>Name A–Z</option>
            <option value="name-desc" ${activeCustomSort === 'name-desc' ? 'selected' : ''}>Name Z–A</option>
            <option value="rating-desc" ${activeCustomSort === 'rating-desc' ? 'selected' : ''}>Bewertung hoch → niedrig</option>
            <option value="rating-asc" ${activeCustomSort === 'rating-asc' ? 'selected' : ''}>Bewertung niedrig → hoch</option>
          </select>
        </div>
        <div style="margin-top:10px;">${entriesHtml}</div>
        ${addRowHtml}
        ${shareHtml}
        <h3 style="margin-top:18px;font-size:1rem;">Kommentare</h3>
        <div style="margin-top:8px;">${commentsHtml}</div>
        ${addCommentHtml}
        <div class="modal-actions" style="margin-top:18px;">
          <button class="btn btn-secondary" id="custom-modal-close-btn">Schließen</button>
        </div>
      </div>
    </div>`;

  document.getElementById('custom-modal-close-btn').addEventListener('click', closeCustomListModal);
  document.getElementById('custom-sort-select').addEventListener('change', (e) => {
    activeCustomSort = e.target.value;
    renderCustomModalBody(list);
  });

  if (isOwner) {
    document.querySelectorAll('[data-custom-edit-entry]').forEach((btn) => {
      btn.addEventListener('click', () => { activeCustomEditingEntryId = btn.dataset.customEditEntry; renderCustomModalBody(list); });
    });
    document.querySelectorAll('[data-custom-cancel-entry]').forEach((btn) => {
      btn.addEventListener('click', () => { activeCustomEditingEntryId = null; renderCustomModalBody(list); });
    });
    document.querySelectorAll('[data-custom-save-entry]').forEach((btn) => {
      btn.addEventListener('click', () => saveCustomEntryEdit(list, btn.dataset.customSaveEntry));
    });
    document.querySelectorAll('[data-custom-delete-entry]').forEach((btn) => {
      btn.addEventListener('click', () => deleteCustomEntry(list, btn.dataset.customDeleteEntry));
    });
    const addBtn = document.getElementById('custom-entry-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => addCustomEntry(list));
    const nameInput = document.getElementById('custom-entry-name-input');
    if (nameInput) nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomEntry(list); });

    document.querySelectorAll('[data-share-user]').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const username = cb.dataset.shareUser;
        const ref = db.collection('customLists').doc(list.id);
        if (e.target.checked) ref.update({ sharedWith: FieldValue.arrayUnion(username) });
        else ref.update({ sharedWith: FieldValue.arrayRemove(username) });
      });
    });
    document.querySelectorAll('[data-delete-comment]').forEach((btn) => {
      btn.addEventListener('click', () => deleteCustomComment(list, btn.dataset.deleteComment));
    });
  } else {
    const addCommentBtn = document.getElementById('custom-comment-add-btn');
    if (addCommentBtn) addCommentBtn.addEventListener('click', () => addCustomComment(list));
    const commentInput = document.getElementById('custom-comment-input');
    if (commentInput) commentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomComment(list); });
  }
}

function saveCustomEntryEdit(list, entryId) {
  const nameInput = document.querySelector(`[data-custom-edit-name="${CSS.escape(entryId)}"]`);
  const ratingSelect = document.querySelector(`[data-custom-edit-rating="${CSS.escape(entryId)}"]`);
  const name = nameInput.value.trim();
  if (!name) return;
  const rating = parseInt(ratingSelect.value, 10);
  db.collection('customLists').doc(list.id).collection('entries').doc(entryId).update({ name, rating });
  activeCustomEditingEntryId = null;
}

async function deleteCustomEntry(list, entryId) {
  const ok = await confirmModal('Eintrag löschen?', 'Dieser Eintrag wird endgültig entfernt.');
  if (ok) db.collection('customLists').doc(list.id).collection('entries').doc(entryId).delete();
}

function addCustomEntry(list) {
  const nameInput = document.getElementById('custom-entry-name-input');
  const ratingSelect = document.getElementById('custom-entry-rating-input');
  const name = nameInput.value.trim();
  if (!name) return;
  const rating = parseInt(ratingSelect.value, 10);
  db.collection('customLists').doc(list.id).collection('entries').add({ name, rating, createdAt: FieldValue.serverTimestamp() });
  nameInput.value = '';
}

function addCustomComment(list) {
  const input = document.getElementById('custom-comment-input');
  const text = input.value.trim();
  if (!text) return;
  db.collection('customLists').doc(list.id).collection('comments').add({ author: currentUser.name, text, createdAt: FieldValue.serverTimestamp() });
  input.value = '';
}

async function deleteCustomComment(list, commentId) {
  const ok = await confirmModal('Kommentar löschen?', 'Dieser Kommentar wird endgültig entfernt.');
  if (ok) db.collection('customLists').doc(list.id).collection('comments').doc(commentId).delete();
}

// ==========================================================
// CHAT
// ==========================================================

function scrollChatToBottom() {
  const attempt = () => {
    const target = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    window.scrollTo(0, target);
    document.documentElement.scrollTop = target;
    document.body.scrollTop = target;
  };
  attempt();
  requestAnimationFrame(attempt);
  requestAnimationFrame(() => requestAnimationFrame(attempt));
  setTimeout(attempt, 60);
  setTimeout(attempt, 150);
  setTimeout(attempt, 350);
}

let lastChatDocs = [];

function isChatVisible() {
  return currentScreen === 'aktuell' && document.getElementById('aktuell-panel-chat').classList.contains('active');
}

function subscribeChat() {
  return db.collection('chat').orderBy('createdAt', 'asc').limitToLast(200).onSnapshot((snap) => {
    lastChatDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderChat(lastChatDocs);
    if (isChatVisible()) {
      scrollChatToBottom();
      markChatSeen();
    } else {
      renderNavBadges();
    }
  });
}

function formatTime(ts) {
  if (!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function renderChat(docs) {
  const el = document.getElementById('chat-scroll');
  if (!docs || !docs.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">💬</span>Noch keine Nachrichten.</div>`;
    return;
  }
  el.innerHTML = docs.map((m) => {
    if (m.system) {
      const snap = m.ideaSnapshot;
      return `
        <div class="chat-msg system" data-toggle="${m.id}">
          <div>${escapeHtml(m.text)}</div>
          ${snap ? `<div class="idea-snapshot">„${escapeHtml(snap.text)}" — ${escapeHtml(snap.author)}</div>` : ''}
          <div class="msg-time">${formatTime(m.createdAt)}</div>
        </div>`;
    }
    const author = usersMap[(m.author || '').toLowerCase()];
    const textColor = author ? userColor(author, 'color') : null;
    const borderColor = author ? userColor(author, 'border') : null;
    const styleAttr = [
      textColor ? `--msg-text-color:${textColor}` : '',
      borderColor ? `--msg-border-color:${borderColor}` : ''
    ].filter(Boolean).join(';');
    return `
      <div class="chat-msg" style="${styleAttr}">
        <div class="msg-author">${escapeHtml(m.author)}</div>
        <div>${escapeHtml(m.text)}</div>
        <div class="msg-time">${formatTime(m.createdAt)}</div>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-toggle]').forEach((node) => {
    node.addEventListener('click', () => node.classList.toggle('open'));
  });
}

document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  await db.collection('chat').add({
    text, author: currentUser.name, system: false, createdAt: FieldValue.serverTimestamp()
  });
  input.value = '';
  await markChatSent();
}

async function postSystemMessage(text, ideaSnapshot) {
  await db.collection('chat').add({
    text, system: true, ideaSnapshot: ideaSnapshot || null, createdAt: FieldValue.serverTimestamp()
  });
}

// ==========================================================
// KALENDER (Termine) — großer Monatskalender mit Serien
// ==========================================================

const GENERAL_COLORS = { brown: '#8B5E3C', purple: '#8E5FA6', darkgreen: '#2E6B3E', orange: '#E08A3C', gray: '#8A8F8F' };

let appointmentsRaw = [];
let calendarViewYear = new Date().getFullYear();
let calendarViewMonth = new Date().getMonth(); // 0-indexed

function subscribeAppointments() {
  return db.collection('appointments').onSnapshot((snap) => {
    appointmentsRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHomeTermine();
    if (currentScreen === 'aktuell') renderMonthCalendar();
  });
}

function buildMultiColorBackground(colors) {
  if (!colors.length) return '#8A8F8F';
  if (colors.length === 1) return colors[0];
  const step = 100 / colors.length;
  const stops = [];
  colors.forEach((c, i) => {
    stops.push(`${c} ${Math.round(i * step)}%`);
    stops.push(`${c} ${Math.round((i + 1) * step)}%`);
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function colorsForOccurrence(o) {
  if (o.userNames && o.userNames.length) {
    return o.userNames.map((n) => {
      const u = usersMap[n.toLowerCase()];
      return u ? (userColor(u, 'color') || '#8A8F8F') : '#8A8F8F';
    });
  }
  return [GENERAL_COLORS[o.generalColor] || '#8A8F8F'];
}

function formatDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(aStr, bStr) {
  return Math.round((parseDateStr(bStr) - parseDateStr(aStr)) / 86400000);
}
function addDaysToDateStr(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return formatDateStr(d);
}

// Returns the start-date (string) of the occurrence covering dateObj, or null if none.
function getOccurrenceStartForDate(appt, dateObj) {
  const anchorObj = parseDateStr(appt.date);
  const endObj = parseDateStr(appt.endDate || appt.date);
  const durationDays = Math.round((endObj - anchorObj) / 86400000);

  if (!appt.recurrence) {
    return (dateObj >= anchorObj && dateObj <= endObj) ? appt.date : null;
  }

  const interval = appt.recurrence.interval || 1;
  const freq = appt.recurrence.freq;

  if (freq === 'monthly') {
    if (dateObj < anchorObj) return null;
    if (dateObj.getDate() !== anchorObj.getDate()) return null;
    const monthsDiff = (dateObj.getFullYear() - anchorObj.getFullYear()) * 12 + (dateObj.getMonth() - anchorObj.getMonth());
    if (monthsDiff < 0 || monthsDiff % interval !== 0) return null;
    return formatDateStr(dateObj);
  }

  if (freq === 'yearly') {
    if (dateObj < anchorObj) return null;
    if (dateObj.getDate() !== anchorObj.getDate() || dateObj.getMonth() !== anchorObj.getMonth()) return null;
    const yearsDiff = dateObj.getFullYear() - anchorObj.getFullYear();
    if (yearsDiff < 0 || yearsDiff % interval !== 0) return null;
    return formatDateStr(dateObj);
  }

  const cycleDays = interval * (freq === 'weekly' ? 7 : 1);
  const diffDays = Math.round((dateObj - anchorObj) / 86400000);
  if (diffDays < 0) return null;
  const remainder = diffDays % cycleDays;
  if (remainder > durationDays) return null;
  return addDaysToDateStr(formatDateStr(dateObj), -remainder);
}

// ---------- Gesetzliche Feiertage RLP + Hessen (automatisch berechnet) ----------
function computeEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Bundesweite Feiertage gelten in RLP UND Hessen; nur Allerheiligen ist RLP-exklusiv.
const HOLIDAY_TEMPLATES = [
  { title: 'Neujahr', states: ['RLP', 'Hessen'], fixed: '01-01' },
  { title: 'Karfreitag', states: ['RLP', 'Hessen'], easterOffset: -2 },
  { title: 'Ostermontag', states: ['RLP', 'Hessen'], easterOffset: 1 },
  { title: 'Tag der Arbeit', states: ['RLP', 'Hessen'], fixed: '05-01' },
  { title: 'Christi Himmelfahrt', states: ['RLP', 'Hessen'], easterOffset: 39 },
  { title: 'Pfingstmontag', states: ['RLP', 'Hessen'], easterOffset: 50 },
  { title: 'Fronleichnam', states: ['RLP', 'Hessen'], easterOffset: 60 },
  { title: 'Tag der Deutschen Einheit', states: ['RLP', 'Hessen'], fixed: '10-03' },
  { title: 'Allerheiligen', states: ['RLP'], fixed: '11-01' },
  { title: '1. Weihnachtstag', states: ['RLP', 'Hessen'], fixed: '12-25' },
  { title: '2. Weihnachtstag', states: ['RLP', 'Hessen'], fixed: '12-26' }
];

function getRLPHolidays(year) {
  const easter = computeEasterSunday(year);
  const off = (n) => { const d = new Date(easter); d.setDate(d.getDate() + n); return formatDateStr(d); };
  return HOLIDAY_TEMPLATES.map((t) => ({
    date: t.fixed ? `${year}-${t.fixed}` : off(t.easterOffset),
    title: t.states.length === 1 ? `${t.title} (Nur ${t.states[0]})` : t.title
  }));
}

let holidayCache = {};
function getRLPHolidaysCached(year) {
  if (!holidayCache[year]) holidayCache[year] = getRLPHolidays(year);
  return holidayCache[year];
}

// ---------- Schulferien RLP + Hessen ----------
// Diese Termine werden jährlich vom jeweiligen Kultusministerium neu festgelegt
// und lassen sich (anders als Feiertage) nicht berechnen. Stand: Schuljahre 2025/26
// und 2026/27 – bitte in ca. 1-2 Jahren um weitere Schuljahre ergänzen.
const FERIEN_COLOR = '#D98BB0';
const SCHOOL_HOLIDAYS = [
  { state: 'RLP', title: 'Weihnachtsferien', start: '2025-12-22', end: '2026-01-07' },
  { state: 'RLP', title: 'Osterferien', start: '2026-03-30', end: '2026-04-10' },
  { state: 'RLP', title: 'Sommerferien', start: '2026-06-29', end: '2026-08-07' },
  { state: 'RLP', title: 'Herbstferien', start: '2026-10-05', end: '2026-10-16' },
  { state: 'RLP', title: 'Weihnachtsferien', start: '2026-12-23', end: '2027-01-08' },

  { state: 'Hessen', title: 'Weihnachtsferien', start: '2025-12-22', end: '2026-01-10' },
  { state: 'Hessen', title: 'Osterferien', start: '2026-03-30', end: '2026-04-10' },
  { state: 'Hessen', title: 'Sommerferien', start: '2026-06-29', end: '2026-08-07' },
  { state: 'Hessen', title: 'Herbstferien', start: '2026-10-05', end: '2026-10-17' },
  { state: 'Hessen', title: 'Weihnachtsferien', start: '2026-12-23', end: '2027-01-12' }
];

function getOccurrencesForDate(dateStr) {
  const dateObj = parseDateStr(dateStr);
  const results = [];
  appointmentsRaw.forEach((appt) => {
    const startKey = getOccurrenceStartForDate(appt, dateObj);
    if (startKey === null) return;
    const exception = appt.exceptions && appt.exceptions[startKey];
    if (exception === 'DELETED') return;
    const merged = exception && typeof exception === 'object' ? { ...appt, ...exception } : appt;
    const mergedEnd = merged.endDate || merged.date;
    results.push({
      apptId: appt.id,
      occurrenceStart: startKey,
      occurrenceEnd: addDaysToDateStr(startKey, daysBetween(merged.date, mergedEnd)),
      title: merged.title,
      allDay: !!merged.allDay,
      time: merged.time || null,
      durationMinutes: merged.durationMinutes || null,
      userNames: merged.userNames || [],
      generalColor: merged.generalColor || null,
      notes: merged.notes || '',
      isRecurring: !!appt.recurrence,
      isSpanning: mergedEnd !== merged.date
    });
  });

  getRLPHolidaysCached(dateObj.getFullYear()).forEach((h) => {
    if (h.date === dateStr) {
      results.push({
        apptId: null, occurrenceStart: dateStr, occurrenceEnd: dateStr, title: h.title,
        allDay: true, time: null, durationMinutes: null, userNames: [], generalColor: 'brown',
        isRecurring: true, isSpanning: false, isHoliday: true
      });
    }
  });

  birthdaysRaw.forEach((b) => {
    const birthObj = parseDateStr(b.date);
    if (dateObj >= birthObj && dateObj.getMonth() === birthObj.getMonth() && dateObj.getDate() === birthObj.getDate()) {
      const age = dateObj.getFullYear() - birthObj.getFullYear();
      const title = b.isOriginal ? `🎂 ${b.name} wird ${age}` : `🎂 ${b.name}`;
      results.push({
        apptId: null, occurrenceStart: dateStr, occurrenceEnd: dateStr, title,
        allDay: true, time: null, durationMinutes: null, userNames: [], generalColor: null,
        isRecurring: true, isSpanning: false, isBirthday: true
      });
    }
  });

  SCHOOL_HOLIDAYS.forEach((f) => {
    if (dateStr >= f.start && dateStr <= f.end) {
      results.push({
        apptId: null, occurrenceStart: f.start, occurrenceEnd: f.end, title: `${f.state} – ${f.title}`,
        allDay: true, time: null, durationMinutes: null, userNames: [], generalColor: null,
        isRecurring: false, isSpanning: f.start !== f.end, isFerien: true
      });
    }
  });

  results.sort((a, b) => {
    const aTop = a.allDay || a.isSpanning;
    const bTop = b.allDay || b.isSpanning;
    if (aTop && !bTop) return -1;
    if (!aTop && bTop) return 1;
    return (a.time || '99:99').localeCompare(b.time || '99:99');
  });
  return results;
}

function renderMonthCalendar() {
  const grid = document.getElementById('month-cal-grid');
  const titleEl = document.getElementById('cal-month-title');
  if (!grid) return;
  titleEl.textContent = `${MONTH_LABELS_DE[calendarViewMonth]} ${calendarViewYear}`;
  const firstDay = new Date(calendarViewYear, calendarViewMonth, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
  const today = todayStr();

  let html = '';
  for (let i = 0; i < startOffset; i++) html += `<div class="month-cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calendarViewYear}-${String(calendarViewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const occ = getOccurrencesForDate(dateStr);
    const isToday = dateStr === today;
    const bars = occ.map((o) => {
      const bg = o.isFerien ? FERIEN_COLOR : (o.isBirthday ? BIRTHDAY_COLOR : buildMultiColorBackground(colorsForOccurrence(o)));
      let label = o.title;
      if (o.isSpanning && !o.allDay) label = '↔ ' + label;
      else if (!o.allDay && !o.isSpanning) label = `${o.time || ''} ${label}`;
      const tooltip = o.notes ? `${label} — ${o.notes}` : label;
      const clickAttrs = (o.isHoliday || o.isFerien)
        ? ''
        : (o.isBirthday ? `data-birthday-info="${escapeHtml(label)}"` : `data-appt-id="${o.apptId}" data-appt-date="${o.occurrenceStart}"`);
      const specialClass = o.isHoliday ? 'holiday' : (o.isFerien ? 'ferien' : (o.isBirthday ? 'birthday' : ''));
      return `<div class="appt-bar ${(o.allDay || o.isSpanning) ? 'allday' : ''} ${specialClass}" style="background:${bg}" ${clickAttrs} title="${escapeHtml(tooltip)}">${escapeHtml(label)}</div>`;
    }).join('');
    html += `<div class="month-cal-cell ${isToday ? 'today' : ''}" data-cal-day="${dateStr}">
      <div class="month-cal-daynum">${day}</div>
      ${bars}
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('[data-appt-id]').forEach((bar) => {
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      const appt = appointmentsRaw.find((a) => a.id === bar.dataset.apptId);
      if (appt) safeOpenAppointmentModal(appt, bar.dataset.apptDate);
    });
  });
  grid.querySelectorAll('[data-cal-day]').forEach((cell) => {
    cell.addEventListener('click', () => safeOpenAppointmentModal(null, cell.dataset.calDay));
  });
  grid.querySelectorAll('[data-birthday-info]').forEach((bar) => {
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      showInfoModal('🎂 Geburtstag', bar.dataset.birthdayInfo);
    });
  });
}

function showInfoModal(title, text) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
        <div class="modal-actions">
          <button class="btn btn-primary" id="info-modal-close-btn" style="width:100%;">OK</button>
        </div>
      </div>
    </div>`;
  document.getElementById('info-modal-close-btn').addEventListener('click', () => { root.innerHTML = ''; });
}

document.getElementById('cal-prev-btn').addEventListener('click', () => {
  calendarViewMonth--;
  if (calendarViewMonth < 0) { calendarViewMonth = 11; calendarViewYear--; }
  renderMonthCalendar();
});
document.getElementById('cal-next-btn').addEventListener('click', () => {
  calendarViewMonth++;
  if (calendarViewMonth > 11) { calendarViewMonth = 0; calendarViewYear++; }
  renderMonthCalendar();
});
function safeOpenAppointmentModal(existingAppt, dateStr) {
  try {
    openAppointmentModal(existingAppt, dateStr);
  } catch (err) {
    console.error(err);
    toast('Fehler beim Öffnen: ' + err.message);
  }
}

window.handleAddAppointmentClick = () => safeOpenAppointmentModal(null, todayStr());
document.getElementById('add-appointment-btn').addEventListener('click', window.handleAddAppointmentClick);

function askSeriesScope(actionLabel, callback) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box">
        <h3>Serientermin ${escapeHtml(actionLabel)}</h3>
        <p>Soll das für die ganze Serie gelten, oder nur für diesen einen Termin?</p>
        <div class="modal-actions" style="flex-direction:column;gap:8px;">
          <button class="btn btn-secondary" id="scope-single-btn">Nur diesen Termin</button>
          <button class="btn btn-primary" id="scope-series-btn">Ganze Serie</button>
        </div>
      </div>
    </div>`;
  document.getElementById('scope-single-btn').onclick = () => callback('single');
  document.getElementById('scope-series-btn').onclick = () => callback('series');
}

function openAppointmentModal(existingAppt, dateStr) {
  const root = document.getElementById('modal-root');
  const isEdit = !!existingAppt;

  let displayData = isEdit
    ? { ...existingAppt }
    : { title: '', date: dateStr, endDate: dateStr, allDay: false, time: '18:00', durationMinutes: 60, userNames: [], generalColor: 'gray' };

  if (isEdit && existingAppt.recurrence) {
    // dateStr here is the occurrence's own start date (computed by the calendar renderer)
    const templateDuration = daysBetween(existingAppt.date, existingAppt.endDate || existingAppt.date);
    displayData.date = dateStr;
    displayData.endDate = addDaysToDateStr(dateStr, templateDuration);
    const ex = existingAppt.exceptions && existingAppt.exceptions[dateStr];
    if (ex && typeof ex === 'object') displayData = { ...displayData, ...ex };
  }
  if (!displayData.endDate) displayData.endDate = displayData.date;

  const usersListHtml = Object.values(usersMap).map((u) => {
    const selected = (displayData.userNames || []).some((n) => n.toLowerCase() === u.name.toLowerCase());
    const color = userColor(u, 'color') || '#888';
    return `<button type="button" class="appt-user-chip ${selected ? 'selected' : ''}" data-user-chip="${escapeHtml(u.name)}" style="color:${color}">${escapeHtml(u.name)}</button>`;
  }).join('');

  const colorSwatchesHtml = Object.entries(GENERAL_COLORS).map(([key, hex]) => `
    <div class="appt-color-swatch ${displayData.generalColor === key ? 'selected' : ''}" data-color-swatch="${key}" style="background:${hex}"></div>
  `).join('');

  const currentFreq = existingAppt && existingAppt.recurrence ? existingAppt.recurrence.freq : '';
  const currentInterval = existingAppt && existingAppt.recurrence ? (existingAppt.recurrence.interval || 1) : 1;

  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box" style="max-width:420px;width:92%;text-align:left;max-height:85vh;overflow-y:auto;">
        <h3>${isEdit ? 'Termin bearbeiten' : 'Neuer Termin'}</h3>
        <div class="appt-form-group">
          <label>Titel</label>
          <input type="text" id="appt-title-input" value="${escapeHtml(displayData.title || '')}" placeholder="z.B. Zahnarzt">
        </div>
        <div class="appt-inline-row">
          <div class="appt-form-group">
            <label>Startdatum</label>
            <input type="date" id="appt-date-input" value="${displayData.date || dateStr}">
          </div>
          <div class="appt-form-group">
            <label>Enddatum</label>
            <input type="date" id="appt-enddate-input" value="${displayData.endDate}">
          </div>
        </div>
        <div class="section-note" style="margin-top:-4px;">Für einen eintägigen Termin einfach dasselbe Datum bei Start und Ende lassen.</div>
        <div class="appt-form-group">
          <label><input type="checkbox" id="appt-allday-input" ${displayData.allDay ? 'checked' : ''}> Ganztägig</label>
        </div>
        <div class="appt-inline-row" id="appt-time-row" style="${displayData.allDay ? 'display:none;' : ''}">
          <div class="appt-form-group">
            <label>Uhrzeit</label>
            <input type="time" id="appt-time-input" value="${displayData.time || '18:00'}">
          </div>
          <div class="appt-form-group">
            <label>Dauer (Min.)</label>
            <input type="number" id="appt-duration-input" value="${displayData.durationMinutes || 60}" min="5" step="5">
          </div>
        </div>
        <div class="appt-form-group">
          <label>Für wen (bis zu 4)? Ohne Auswahl → allgemeiner Termin mit Farbe</label>
          <div class="appt-user-chip-row" id="appt-user-chips">${usersListHtml}</div>
        </div>
        <div class="appt-form-group" id="appt-color-group" style="${(displayData.userNames || []).length ? 'display:none;' : ''}">
          <label>Farbe (allgemeiner Termin)</label>
          <div class="appt-color-swatch-row" id="appt-color-swatches">${colorSwatchesHtml}</div>
        </div>
        <div class="appt-form-group">
          <label>Wiederholung</label>
          <div class="appt-inline-row">
            <select id="appt-recurrence-freq-select">
              <option value="">Keine Wiederholung</option>
              <option value="daily" ${currentFreq === 'daily' ? 'selected' : ''}>Tag(e)</option>
              <option value="weekly" ${currentFreq === 'weekly' ? 'selected' : ''}>Woche(n)</option>
              <option value="monthly" ${currentFreq === 'monthly' ? 'selected' : ''}>Monat(e)</option>
              <option value="yearly" ${currentFreq === 'yearly' ? 'selected' : ''}>Jahr(e)</option>
            </select>
            <input type="number" id="appt-recurrence-interval-input" min="1" value="${currentInterval}" style="max-width:80px;" title="alle wie viele Einheiten">
          </div>
          <div class="section-note" style="margin-top:6px;">Beispiel: "Woche(n)" + "2" = alle 2 Wochen. Bei mehrtägigen Terminen wiederholt sich der ganze Zeitraum.</div>
        </div>
        <div class="appt-form-group">
          <label>Notizen (optional)</label>
          <textarea id="appt-notes-input" class="important-input" style="min-height:70px;" placeholder="z.B. Adresse, was mitbringen, Ansprechpartner...">${escapeHtml(displayData.notes || '')}</textarea>
        </div>
        <div class="modal-actions" style="margin-top:16px;flex-wrap:wrap;">
          ${isEdit && isAdmin(currentUser.name) ? `<button class="btn btn-danger" id="appt-delete-btn">Löschen</button>` : ''}
          <button class="btn btn-secondary" id="appt-cancel-btn">Abbrechen</button>
          <button class="btn btn-primary" id="appt-save-btn">Speichern</button>
        </div>
      </div>
    </div>`;

  const selectedUsers = new Set(displayData.userNames || []);
  let selectedColor = displayData.generalColor || 'gray';

  document.getElementById('appt-allday-input').addEventListener('change', (e) => {
    document.getElementById('appt-time-row').style.display = e.target.checked ? 'none' : '';
  });
  document.getElementById('appt-date-input').addEventListener('change', (e) => {
    const endInput = document.getElementById('appt-enddate-input');
    if (endInput.value < e.target.value) endInput.value = e.target.value;
  });
  root.querySelectorAll('[data-user-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const name = chip.dataset.userChip;
      if (selectedUsers.has(name)) {
        selectedUsers.delete(name);
        chip.classList.remove('selected');
      } else {
        if (selectedUsers.size >= 4) { toast('Maximal 4 Personen pro Termin.'); return; }
        selectedUsers.add(name);
        chip.classList.add('selected');
      }
      document.getElementById('appt-color-group').style.display = selectedUsers.size ? 'none' : '';
    });
  });
  root.querySelectorAll('[data-color-swatch]').forEach((sw) => {
    sw.addEventListener('click', () => {
      selectedColor = sw.dataset.colorSwatch;
      root.querySelectorAll('[data-color-swatch]').forEach((s2) => s2.classList.toggle('selected', s2 === sw));
    });
  });

  document.getElementById('appt-cancel-btn').addEventListener('click', () => { root.innerHTML = ''; });

  document.getElementById('appt-save-btn').addEventListener('click', async () => {
    const title = document.getElementById('appt-title-input').value.trim();
    if (!title) { toast('Bitte einen Titel eingeben.'); return; }
    const newDate = document.getElementById('appt-date-input').value;
    let newEndDate = document.getElementById('appt-enddate-input').value || newDate;
    if (newEndDate < newDate) newEndDate = newDate;
    const allDay = document.getElementById('appt-allday-input').checked;
    const time = allDay ? null : document.getElementById('appt-time-input').value;
    const durationMinutes = allDay ? null : (parseInt(document.getElementById('appt-duration-input').value, 10) || null);
    const userNames = Array.from(selectedUsers);
    const generalColor = userNames.length ? null : selectedColor;
    const freqVal = document.getElementById('appt-recurrence-freq-select').value;
    const intervalVal = Math.max(1, parseInt(document.getElementById('appt-recurrence-interval-input').value, 10) || 1);
    const recurrence = freqVal ? { freq: freqVal, interval: intervalVal } : null;
    const fields = { title, date: newDate, endDate: newEndDate, allDay, time, durationMinutes, userNames, generalColor, notes: document.getElementById('appt-notes-input').value.trim() };

    if (!isEdit) {
      await db.collection('appointments').add({ ...fields, recurrence, exceptions: {}, createdBy: currentUser.name, createdAt: FieldValue.serverTimestamp() });
      root.innerHTML = '';
      toast('Termin gespeichert.');
      return;
    }

    if (existingAppt.recurrence) {
      askSeriesScope('bearbeiten', async (scope) => {
        if (scope === 'series') {
          await db.collection('appointments').doc(existingAppt.id).update({ ...fields, recurrence });
        } else {
          const exceptions = { ...(existingAppt.exceptions || {}) };
          exceptions[dateStr] = fields;
          await db.collection('appointments').doc(existingAppt.id).update({ exceptions });
        }
        root.innerHTML = '';
        toast('Termin gespeichert.');
      });
    } else {
      await db.collection('appointments').doc(existingAppt.id).update({ ...fields, recurrence });
      root.innerHTML = '';
      toast('Termin gespeichert.');
    }
  });

  if (isEdit && isAdmin(currentUser.name)) {
    document.getElementById('appt-delete-btn').addEventListener('click', () => {
      if (existingAppt.recurrence) {
        askSeriesScope('löschen', async (scope) => {
          if (scope === 'series') {
            await db.collection('appointments').doc(existingAppt.id).delete();
          } else {
            const exceptions = { ...(existingAppt.exceptions || {}) };
            exceptions[dateStr] = 'DELETED';
            await db.collection('appointments').doc(existingAppt.id).update({ exceptions });
          }
          root.innerHTML = '';
          toast('Termin gelöscht.');
        });
      } else {
        (async () => {
          const ok = await confirmModal('Termin löschen?', 'Dieser Termin wird endgültig gelöscht.');
          if (ok) {
            await db.collection('appointments').doc(existingAppt.id).delete();
            root.innerHTML = '';
            toast('Termin gelöscht.');
          }
        })();
      }
    });
  }
}

function renderHomeTermine() {
  const card = document.getElementById('home-card-termine');
  const occ = getOccurrencesForDate(todayStr());
  if (!occ.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const el = document.getElementById('home-termine-content');
  el.innerHTML = occ.map((o) => {
    const bg = buildMultiColorBackground(colorsForOccurrence(o));
    const timeLabel = o.allDay ? 'Ganztägig' : (o.time || '');
    const noteHtml = o.notes ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-left:24px;">${escapeHtml(o.notes)}</div>` : '';
    return `<div class="termine-row"><span class="termine-dot" style="background:${bg}"></span><span class="termine-time">${escapeHtml(timeLabel)}</span><span>${escapeHtml(o.title)}</span></div>${noteHtml}`;
  }).join('');
}

// ==========================================================
// IDEEN
// ==========================================================

let lastIdeaDocs = [];

function subscribeIdeas() {
  return db.collection('ideas').orderBy('createdAt', 'asc').onSnapshot((snap) => {
    lastIdeaDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => !i.deleted);
    renderIdeas(lastIdeaDocs);
    if (currentScreen === 'ideen') {
      markIdeasSeen();
    } else {
      renderNavBadges();
    }
  });
}

function renderIdeas(docs) {
  const el = document.getElementById('ideen-list');
  if (!docs || !docs.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">💡</span>Noch keine Ideen eingereicht.</div>`;
    return;
  }
  el.innerHTML = docs.slice().reverse().map((idea) => {
    const votes = idea.votes || {};
    const ups = Object.entries(votes).filter(([, v]) => v === 'up');
    const downs = Object.entries(votes).filter(([, v]) => v === 'down');
    const myVote = votes[currentUser.name];
    const canVote = idea.author !== currentUser.name;
    const author = usersMap[(idea.author || '').toLowerCase()];
    const color = author ? userColor(author, 'color') : null;

    return `
      <div class="idea-card">
        <div class="idea-head">
          <span class="idea-author" style="${color ? `color:${color}` : ''}">${escapeHtml(idea.author)}</span>
          <span class="idea-time">${formatTime(idea.createdAt)}</span>
        </div>
        <div class="idea-text">${escapeHtml(idea.text)}</div>
        ${idea.accepted ? '<span class="idea-accepted-badge">✓ Angenommen</span>' : ''}
        <div class="idea-actions">
          ${canVote ? `
            <button class="vote-btn ${myVote === 'up' ? 'active-up' : ''}" data-vote="up" data-id="${idea.id}">👍</button>
            <button class="vote-btn ${myVote === 'down' ? 'active-down' : ''}" data-vote="down" data-id="${idea.id}">👎</button>
          ` : ''}
          <span class="vote-count">👍 ${ups.length} · 👎 ${downs.length}</span>
        </div>
        ${(ups.length || downs.length) ? `<div class="voter-list">${[...ups, ...downs].map(([n, v]) => `${v === 'up' ? '👍' : '👎'} ${escapeHtml(n)}`).join(', ')}</div>` : ''}
        ${isAdmin(currentUser.name) ? `
          <div class="idea-admin-row">
            <button class="btn btn-secondary btn-small" data-accept="${idea.id}" ${idea.accepted ? 'disabled' : ''}>✓ Annehmen (1 €)</button>
            <button class="btn btn-danger btn-small" data-delete-idea="${idea.id}">Löschen</button>
          </div>` : ''}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-vote]').forEach((btn) => {
    btn.addEventListener('click', () => voteIdea(btn.dataset.id, btn.dataset.vote));
  });
  el.querySelectorAll('[data-accept]').forEach((btn) => {
    btn.addEventListener('click', () => acceptIdea(btn.dataset.accept));
  });
  el.querySelectorAll('[data-delete-idea]').forEach((btn) => {
    btn.addEventListener('click', () => deleteIdea(btn.dataset.deleteIdea));
  });
}

document.getElementById('idea-add-btn').addEventListener('click', addIdea);
document.getElementById('idea-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addIdea(); });

function addIdea() {
  const input = document.getElementById('idea-input');
  const text = input.value.trim();
  if (!text) return;
  db.collection('ideas').add({
    text, author: currentUser.name, votes: {}, accepted: false, deleted: false, createdAt: FieldValue.serverTimestamp()
  });
  input.value = '';
}

async function voteIdea(ideaId, direction) {
  const idea = lastIdeaDocs.find((i) => i.id === ideaId);
  if (!idea) return;
  const votes = { ...(idea.votes || {}) };
  const hadVoteBefore = !!votes[currentUser.name];
  votes[currentUser.name] = direction;
  await db.collection('ideas').doc(ideaId).update({ votes });
  if (!hadVoteBefore) {
    await addTransaction(currentUser.name, 0.1, `Bewertung: „${truncate(idea.text)}"`, true);
  }
}

function truncate(s, n = 30) { return s.length > n ? s.slice(0, n) + '…' : s; }

async function acceptIdea(ideaId) {
  const idea = lastIdeaDocs.find((i) => i.id === ideaId);
  if (!idea || idea.accepted) return;
  await db.collection('ideas').doc(ideaId).update({ accepted: true });
  await addTransaction(idea.author, 1, `Angenommene Idee: „${truncate(idea.text)}"`, true);
  toast('Idee angenommen, 1 € gutgeschrieben.');
}

async function deleteIdea(ideaId) {
  const idea = lastIdeaDocs.find((i) => i.id === ideaId);
  if (!idea) return;
  const ok = await confirmModal('Idee löschen?', 'Diese Idee wird endgültig entfernt. Im Chat erscheint ein Hinweis.');
  if (!ok) return;
  await db.collection('ideas').doc(ideaId).update({ deleted: true });
  await postSystemMessage(
    `Idee von ${idea.author}, ${formatTime(idea.createdAt)} wurde vom Admin gelöscht.`,
    { text: idea.text, author: idea.author }
  );
  toast('Idee gelöscht.');
}

// ==========================================================
// KONTO
// ==========================================================

let accountBalances = {};
let accountTx = {};

function subscribeAccounts() {
  const subs = [];
  subs.push(db.collection('accounts').onSnapshot((snap) => {
    snap.forEach((doc) => { accountBalances[doc.id] = doc.data().balance || 0; });
    renderKonto();
  }));
  return subs;
}

function subscribeAllTransactions() {
  // one listener per known user's last-5 transactions; re-run when user list changes size
  Object.values(usersMap).forEach((u) => {
    if (accountTx[u.name] !== undefined) return; // already subscribed
    accountTx[u.name] = [];
    const unsub = db.collection('accounts').doc(u.name).collection('transactions')
      .orderBy('createdAt', 'desc').limit(5)
      .onSnapshot((snap) => {
        accountTx[u.name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderKonto();
      });
    unsubscribers.push(unsub);
  });
}

async function addTransaction(userName, amount, reason, auto = false) {
  const accRef = db.collection('accounts').doc(userName);
  await accRef.set({ balance: FieldValue.increment(amount) }, { merge: true });
  await accRef.collection('transactions').add({ amount, reason, auto, createdAt: FieldValue.serverTimestamp() });
}

function renderKonto() {
  const el = document.getElementById('konto-list');
  const names = Object.values(usersMap).map((u) => u.name).sort();
  if (!names.length) { el.innerHTML = ''; return; }

  el.innerHTML = names.map((name) => {
    const userData = usersMap[name.toLowerCase()];
    const color = userData ? userColor(userData, 'color') : null;
    const balance = accountBalances[name] || 0;
    const tx = accountTx[name] || [];
    return `
      <div class="account-card" style="${color ? `--user-color:${color}` : ''}">
        <div class="account-head">
          <span class="account-name">${escapeHtml(name)}</span>
          <span class="account-balance ${balance < 0 ? 'negative' : ''}">${balance.toFixed(2).replace('.', ',')} €</span>
        </div>
        ${tx.length ? tx.map((t) => `
          <div class="tx-row">
            <span class="tx-reason">${escapeHtml(t.reason || '')}</span>
            <span class="tx-amount ${t.amount >= 0 ? 'positive' : 'negative'}">${euro(t.amount)}</span>
          </div>`).join('') : '<div class="tx-row"><span class="tx-reason">Noch keine Buchungen</span></div>'}
        ${isAdmin(currentUser.name) ? `
          <div class="admin-tx-form">
            <input type="text" placeholder="Grund (z.B. Taschengeld)" data-reason-for="${escapeHtml(name)}">
            <input type="number" step="0.01" class="amount-input" placeholder="±€" data-amount-for="${escapeHtml(name)}">
            <button class="btn btn-primary btn-small" data-booking-for="${escapeHtml(name)}">OK</button>
          </div>` : ''}
      </div>`;
  }).join('');

  if (isAdmin(currentUser.name)) {
    el.querySelectorAll('[data-booking-for]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.bookingFor;
        const reasonInput = el.querySelector(`[data-reason-for="${CSS.escape(name)}"]`);
        const amountInput = el.querySelector(`[data-amount-for="${CSS.escape(name)}"]`);
        const amount = parseFloat(amountInput.value);
        const reason = reasonInput.value.trim();
        if (isNaN(amount) || !reason) { toast('Bitte Betrag und Grund angeben.'); return; }
        await addTransaction(name, amount, reason, false);
        reasonInput.value = ''; amountInput.value = '';
        toast('Buchung gespeichert.');
      });
    });
  }
}

// ==========================================================
// WICHTIG (meals + important note) — Admin only
// ==========================================================

let mealsMap = {};

function subscribeMeals() {
  return db.collection('meals').onSnapshot((snap) => {
    mealsMap = {};
    snap.forEach((doc) => { mealsMap[doc.id] = doc.data().text; });
    todayMealText = mealsMap[todayStr()] || '';
    renderHomeMeal();
    if (isAdmin(currentUser.name)) renderMealList();
  });
}

function subscribeImportant() {
  return db.collection('config').doc('important').onSnapshot((doc) => {
    importantText = doc.exists ? (doc.data().text || '') : '';
    renderHomeImportant();
    if (isAdmin(currentUser.name)) {
      document.getElementById('important-text-input').value = importantText;
    }
  });
}

function renderMealList() {
  const el = document.getElementById('meal-list');
  const dates = Object.keys(mealsMap).sort();
  if (!dates.length) { el.innerHTML = '<div class="empty-state">Noch nichts eingetragen.</div>'; return; }
  el.innerHTML = dates.map((date) => `
    <div class="meal-list-row">
      <span>${new Date(date).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
      <span>${escapeHtml(mealsMap[date])}</span>
      <button class="btn-icon" data-delete-meal="${date}">🗑️</button>
    </div>`).join('');
  el.querySelectorAll('[data-delete-meal]').forEach((btn) => {
    btn.addEventListener('click', () => db.collection('meals').doc(btn.dataset.deleteMeal).delete());
  });
}

document.getElementById('meal-save-btn').addEventListener('click', async () => {
  const date = document.getElementById('meal-date-input').value;
  const text = document.getElementById('meal-text-input').value.trim();
  if (!date || !text) { toast('Bitte Datum und Text angeben.'); return; }
  try {
    await db.collection('meals').doc(date).set({ text });
    document.getElementById('meal-text-input').value = '';
    toast('Gespeichert.');
  } catch (err) {
    console.error(err);
    toast('Fehler beim Speichern: ' + err.message);
  }
});

document.getElementById('important-save-btn').addEventListener('click', () => {
  const text = document.getElementById('important-text-input').value.trim();
  db.collection('config').doc('important').set({ text });
  toast('Gespeichert.');
});

// ==========================================================
// GEBURTSTAGE — automatisch jedes Jahr im Kalender (hellblau)
// ==========================================================

const BIRTHDAY_COLOR = '#8EC6E6';
let birthdaysRaw = [];
let birthdayEditingId = null;

function subscribeBirthdays() {
  return db.collection('birthdays').onSnapshot((snap) => {
    birthdaysRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAdminBirthdays();
    renderHomeTermine();
    if (currentScreen === 'aktuell') renderMonthCalendar();
    if (currentScreen === 'home') maybeShowBirthdayConfetti();
  });
}

function todaysBirthdays() {
  const t = parseDateStr(todayStr());
  return birthdaysRaw.filter((b) => {
    const bd = parseDateStr(b.date);
    return bd.getMonth() === t.getMonth() && bd.getDate() === t.getDate();
  });
}

function maybeShowBirthdayConfetti() {
  if (!todaysBirthdays().length) return;
  const flagKey = 'confettiShown_' + todayStr();
  if (sessionStorage.getItem(flagKey)) return;
  sessionStorage.setItem(flagKey, '1');
  launchConfetti();
}

function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);
  const colors = ['#E3A857', '#74AFC6', '#86B96C', '#DA8578', '#A692C4', '#8EC6E6'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = (Math.random() * 0.5) + 's';
    piece.style.animationDuration = (2.5 + Math.random() * 1.5) + 's';
    piece.style.transform = `rotate(${Math.round(Math.random() * 360)}deg)`;
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 4500);
}

function renderAdminBirthdays() {
  const el = document.getElementById('admin-birthday-list');
  if (!el) return;
  if (!birthdaysRaw.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">🎂</span>Noch keine Geburtstage eingetragen.</div>`;
    return;
  }
  const sorted = birthdaysRaw.slice().sort((a, b) => {
    const da = parseDateStr(a.date);
    const db_ = parseDateStr(b.date);
    const monthDayA = da.getMonth() * 100 + da.getDate();
    const monthDayB = db_.getMonth() * 100 + db_.getDate();
    return monthDayA - monthDayB;
  });
  el.innerHTML = sorted.map((b) => {
    const dateLabel = new Date(b.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (b.id === birthdayEditingId) {
      return `
        <div class="list-item">
          <input type="text" data-bday-edit-name="${b.id}" value="${escapeHtml(b.name)}" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);">
          <input type="date" data-bday-edit-date="${b.id}" value="${b.date}" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:var(--text);">
          <label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;color:var(--text-muted);white-space:nowrap;">
            <input type="checkbox" data-bday-edit-original="${b.id}" ${b.isOriginal ? 'checked' : ''}> Orig.
          </label>
          <button class="btn-icon" data-bday-save="${b.id}" title="Speichern">✓</button>
          <button class="btn-icon" data-bday-cancel="1" title="Abbrechen">✕</button>
        </div>`;
    }
    return `
      <div class="list-item">
        <div style="flex:1;">
          <div class="item-text">${escapeHtml(b.name)}</div>
          <div class="item-meta">${dateLabel}${b.isOriginal ? ' · Original (mit Alter)' : ''}</div>
        </div>
        <button class="btn-icon" data-bday-edit="${b.id}" title="Bearbeiten">✏️</button>
        <button class="btn-icon" data-bday-delete="${b.id}" title="Löschen">🗑️</button>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-bday-edit]').forEach((btn) => {
    btn.addEventListener('click', () => { birthdayEditingId = btn.dataset.bdayEdit; renderAdminBirthdays(); });
  });
  el.querySelectorAll('[data-bday-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => { birthdayEditingId = null; renderAdminBirthdays(); });
  });
  el.querySelectorAll('[data-bday-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveBirthdayEdit(btn.dataset.bdaySave));
  });
  el.querySelectorAll('[data-bday-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteBirthday(btn.dataset.bdayDelete));
  });
}

function saveBirthdayEdit(id) {
  const nameInput = document.querySelector(`[data-bday-edit-name="${CSS.escape(id)}"]`);
  const dateInput = document.querySelector(`[data-bday-edit-date="${CSS.escape(id)}"]`);
  const origInput = document.querySelector(`[data-bday-edit-original="${CSS.escape(id)}"]`);
  const name = nameInput.value.trim();
  const date = dateInput.value;
  if (!name || !date) return;
  db.collection('birthdays').doc(id).update({ name, date, isOriginal: origInput.checked });
  birthdayEditingId = null;
}

async function deleteBirthday(id) {
  const ok = await confirmModal('Geburtstag löschen?', 'Dieser Eintrag wird endgültig entfernt.');
  if (ok) db.collection('birthdays').doc(id).delete();
}

document.getElementById('birthday-add-btn').addEventListener('click', () => {
  const nameInput = document.getElementById('birthday-name-input');
  const dateInput = document.getElementById('birthday-date-input');
  const origInput = document.getElementById('birthday-original-input');
  const name = nameInput.value.trim();
  const date = dateInput.value;
  if (!name || !date) { toast('Bitte Name und Datum angeben.'); return; }
  db.collection('birthdays').add({
    name, date, isOriginal: origInput.checked,
    createdBy: currentUser.name, createdAt: FieldValue.serverTimestamp()
  });
  nameInput.value = '';
  dateInput.value = '';
  origInput.checked = false;
});

// ==========================================================
// SPIELE — 4 Gewinnt und Schach: Herausforderung, Zugspiel, Siegestabellen
// Pro Spielerpaar gibt es pro Spiel immer nur EINE Partie (feste Dokument-ID).
// ==========================================================
// <GAMES-START>

const C4_COLS = 7;
const C4_ROWS = 6;
const GAME_STALE_INVITE_DAYS = 14;
const GAME_FINISHED_KEEP_DAYS = 7;
const GAME_TYPES = {
  connect4: { label: '4 Gewinnt', icon: '🔴', subtitle: 'Zu zweit, abwechselnd Steine einwerfen' },
  chess: { label: 'Schach', icon: '♟️', subtitle: 'Der Klassiker – mit Remis-Angebot' },
  tictactoe: { label: 'Tic Tac Toe', icon: '⭕', subtitle: 'Drei in einer Reihe gewinnt' },
  kniffel: { label: 'Kniffel', icon: '🎲', subtitle: 'Würfeln, Felder füllen, Punkte sammeln' },
  othello: { label: 'Othello', icon: '⚫', subtitle: 'Steine einklammern und umdrehen' },
  ships: { label: 'Schiffe versenken', icon: '🚢', subtitle: 'Flotte platzieren, Schiffe des Gegners versenken' },
  blokus: { label: 'Blokus', icon: '🟦', subtitle: 'Für 2 bis 4 Spieler – Formen legen, Ecken berühren', multi: true },
  sudoku: { label: 'Sudoku', icon: '🔢', subtitle: 'Allein knobeln – mit Bestzeiten', solo: true }
};

let gamesRaw = [];                                   // alle Partien (alle Spiele), an denen ich beteiligt bin
let gameStatsAll = {
  connect4: { wins: {}, draws: {}, lastWin: null },
  chess: { wins: {}, draws: {}, lastWin: null },
  tictactoe: { wins: {}, draws: {}, lastWin: null },
  kniffel: { wins: {}, draws: {}, lastWin: null },
  othello: { wins: {}, draws: {}, lastWin: null },
  ships: { wins: {}, draws: {}, lastWin: null },
  blokus: { wins: {}, draws: {}, played: {}, lastWin: null }
};
let gamesView = 'menu';                              // 'menu' | 'lobby' | 'board'
let gamesType = 'connect4';                          // welches Spiel in der Übersicht gezeigt wird
let openGameId = null;
let lastBoardSig = '';
let c4AnimKey = '';
let gameBusy = false;
let gameOpenAfterAccept = null;
let chSel = null;                                    // Schach: { gameId, moves, from, promoTo }
let knUi = { gameId: null, turnsDone: -1, held: [false, false, false, false, false] };   // Kniffel: behaltene Würfel (nur lokal)
let shUi = { gameId: null, grid: [], selected: 1, horizontal: true };   // Schiffe versenken: Flotte beim Platzieren (nur lokal)
let suProgress = {};                                 // Sudoku: mein Stand je Aufgabe ("stufe_nummer")
let suStatsList = [];                                // Sudoku: Bestzeiten und gelöste Aufgaben aller Nutzer
let suLevelSel = 'easy';
let suUi = null;                                     // Sudoku: gerade geöffnete Aufgabe (nur lokal)
let groupGamesRaw = [];                              // Mehrspieler-Runden (Blokus), an denen ich beteiligt bin
let openGroupId = null;
let blInviteSel = new Set();                         // Blokus-Lobby: ausgewählte Mitspieler
let blUi = { gameId: null, piece: null, shape: null, at: null };   // Blokus: gewähltes Stück und Stelle (nur lokal)
let tournamentsRaw = [];                             // Turniere, die ich sehen darf (Admin: alle)
let openTournamentId = null;
let tnAdvanceBusy = false;
let tnTimer = null;
let tnFormSelected = null;                           // Admin-Formular: ausgewählte Teilnehmer

// <GAMES-LOGIC-START>

// ----- allgemeine Hilfen für alle Spiele -----
function gameTypeOf(g) {
  return g.type || 'connect4';                       // ältere Partien haben (noch) kein Typ-Feld
}

function gamePairKey(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join('|');
}

function gameDocId(type, a, b) {
  const prefix = type === 'connect4' ? 'c4' : type;  // "c4_" bleibt wie bisher, damit laufende Partien erhalten bleiben
  return prefix + '_' + gamePairKey(a, b).split('|').map(encodeURIComponent).join('__');
}

function gamePlayerIndex(game, name) {
  return (game.players || []).findIndex((n) => n.toLowerCase() === name.toLowerCase());
}

// ----- Farben der Spielfiguren (Nutzerfarben, bei zu großer Ähnlichkeit wird Spieler 2 angepasst) -----
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function colorDistance(a, b) {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 999;
  return Math.sqrt(ra.reduce((sum, v, i) => sum + (v - rb[i]) ** 2, 0));
}

function invertColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#888888';
  return '#' + rgb.map((v) => (255 - v).toString(16).padStart(2, '0')).join('');
}

function gameStoneStyles(game) {
  const users = game.players.map((n) => usersMap[n.toLowerCase()]);
  const defaults = ['#E3A857', '#74AFC6'];
  const fills = users.map((u, i) => (u && userColor(u, 'color')) || defaults[i]);
  const rings = users.map((u, i) => (u && userColor(u, 'border')) || fills[i]);
  if (colorDistance(fills[0], fills[1]) < 90) {
    fills[1] = colorDistance(fills[0], rings[1]) >= 90 ? rings[1] : invertColor(fills[0]);
  }
  return [{ fill: fills[0], ring: rings[0] }, { fill: fills[1], ring: rings[1] }];
}

// ----- 4 Gewinnt: reine Spiellogik (Index = Reihe * 7 + Spalte, Reihe 0 = oben) -----
function c4NewBoard() {
  return new Array(C4_COLS * C4_ROWS).fill(0);
}

function c4DropRow(board, col) {
  for (let row = C4_ROWS - 1; row >= 0; row--) {
    if (board[row * C4_COLS + col] === 0) return row;
  }
  return -1; // Spalte voll
}

// Liefert die Felder der Gewinnreihe (>= 4 in einer Linie durch idx) oder null.
function c4CheckWin(board, idx, player) {
  const row = Math.floor(idx / C4_COLS);
  const col = idx % C4_COLS;
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of directions) {
    const cells = [idx];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS && board[r * C4_COLS + c] === player) {
        cells.push(r * C4_COLS + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

function c4IsFull(board) {
  return board.every((v) => v !== 0);
}

// ----- Schach: reine Spiellogik -----
// Brett = 64 Felder, Index = Reihe * 8 + Spalte, Reihe 0 = 8. Reihe (Schwarz oben), Spalte 0 = a-Linie.
// Figuren wie in der FEN-Schreibweise: Großbuchstaben = Weiß (Spieler 1), Kleinbuchstaben = Schwarz (Spieler 2),
// '' = leeres Feld. Rochaderechte als Text wie "KQkq", "en passant"-Feld als Index (oder -1).
const CH_KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const CH_KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const CH_DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const CH_STRAIGHT = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function chIsWhite(p) {
  return p !== '' && p === p.toUpperCase();
}

function chNewBoard() {
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const board = new Array(64).fill('');
  for (let c = 0; c < 8; c++) {
    board[c] = back[c];
    board[8 + c] = 'p';
    board[48 + c] = 'P';
    board[56 + c] = back[c].toUpperCase();
  }
  return board;
}

function chNewState() {
  return { board: chNewBoard(), turn: 1, castling: 'KQkq', ep: -1 };
}

// Wird das Feld sq von einer Figur der angegebenen Farbe angegriffen?
function chAttacked(board, sq, byWhite) {
  const row = sq >> 3;
  const col = sq & 7;
  const at = (r, c) => (r >= 0 && r < 8 && c >= 0 && c < 8 ? board[r * 8 + c] : null);
  const pawn = byWhite ? 'P' : 'p';
  const pr = byWhite ? row + 1 : row - 1;
  if (at(pr, col - 1) === pawn || at(pr, col + 1) === pawn) return true;
  const knight = byWhite ? 'N' : 'n';
  for (const [dr, dc] of CH_KNIGHT) if (at(row + dr, col + dc) === knight) return true;
  const king = byWhite ? 'K' : 'k';
  for (const [dr, dc] of CH_KING) if (at(row + dr, col + dc) === king) return true;
  const bishop = byWhite ? 'B' : 'b';
  const rook = byWhite ? 'R' : 'r';
  const queen = byWhite ? 'Q' : 'q';
  for (const [dr, dc] of CH_DIAG) {
    let r = row + dr;
    let c = col + dc;
    while (at(r, c) === '') { r += dr; c += dc; }
    const p = at(r, c);
    if (p === bishop || p === queen) return true;
  }
  for (const [dr, dc] of CH_STRAIGHT) {
    let r = row + dr;
    let c = col + dc;
    while (at(r, c) === '') { r += dr; c += dc; }
    const p = at(r, c);
    if (p === rook || p === queen) return true;
  }
  return false;
}

function chKingSquare(board, white) {
  return board.indexOf(white ? 'K' : 'k');
}

function chInCheck(board, white) {
  const k = chKingSquare(board, white);
  return k >= 0 && chAttacked(board, k, !white);
}

// Alle Züge, die nach den Bewegungsregeln möglich sind (der eigene König darf dabei noch im Schach stehen).
function chPseudoMoves(state) {
  const { board, castling, ep } = state;
  const white = state.turn === 1;
  const moves = [];
  const PROMOS = ['q', 'r', 'b', 'n'];
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (p === '' || chIsWhite(p) !== white) continue;
    const row = from >> 3;
    const col = from & 7;
    const type = p.toLowerCase();

    if (type === 'p') {
      const dir = white ? -1 : 1;
      const startRow = white ? 6 : 1;
      const lastRow = white ? 0 : 7;
      const r1 = row + dir;
      if (r1 < 0 || r1 > 7) continue;
      const push = (to, flag) => {
        if (r1 === lastRow) PROMOS.forEach((promo) => moves.push({ from, to, promo }));
        else moves.push(flag ? { from, to, flag } : { from, to });
      };
      if (board[r1 * 8 + col] === '') {
        push(r1 * 8 + col);
        if (row === startRow && board[(row + 2 * dir) * 8 + col] === '') {
          moves.push({ from, to: (row + 2 * dir) * 8 + col, flag: 'double' });
        }
      }
      for (const dc of [-1, 1]) {
        const c2 = col + dc;
        if (c2 < 0 || c2 > 7) continue;
        const to = r1 * 8 + c2;
        const target = board[to];
        if (target !== '' && chIsWhite(target) !== white) push(to);
        else if (target === '' && to === ep) moves.push({ from, to, flag: 'ep' });
      }
    } else if (type === 'n' || type === 'k') {
      for (const [dr, dc] of (type === 'n' ? CH_KNIGHT : CH_KING)) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        const target = board[r * 8 + c];
        if (target === '' || chIsWhite(target) !== white) moves.push({ from, to: r * 8 + c });
      }
      if (type === 'k' && from === (white ? 60 : 4)) {
        const base = white ? 56 : 0;
        const rook = white ? 'R' : 'r';
        const enemyWhite = !white;
        if (castling.includes(white ? 'K' : 'k') && board[base + 5] === '' && board[base + 6] === '' && board[base + 7] === rook
          && !chAttacked(board, base + 4, enemyWhite) && !chAttacked(board, base + 5, enemyWhite) && !chAttacked(board, base + 6, enemyWhite)) {
          moves.push({ from, to: base + 6, flag: 'castleK' });
        }
        if (castling.includes(white ? 'Q' : 'q') && board[base + 1] === '' && board[base + 2] === '' && board[base + 3] === '' && board[base] === rook
          && !chAttacked(board, base + 4, enemyWhite) && !chAttacked(board, base + 3, enemyWhite) && !chAttacked(board, base + 2, enemyWhite)) {
          moves.push({ from, to: base + 2, flag: 'castleQ' });
        }
      }
    } else {
      const dirs = type === 'b' ? CH_DIAG : type === 'r' ? CH_STRAIGHT : CH_DIAG.concat(CH_STRAIGHT);
      for (const [dr, dc] of dirs) {
        let r = row + dr;
        let c = col + dc;
        while (r >= 0 && r < 8 && c >= 0 && c < 8) {
          const target = board[r * 8 + c];
          if (target === '') {
            moves.push({ from, to: r * 8 + c });
          } else {
            if (chIsWhite(target) !== white) moves.push({ from, to: r * 8 + c });
            break;
          }
          r += dr;
          c += dc;
        }
      }
    }
  }
  return moves;
}

// Führt einen Zug aus und liefert den neuen Spielzustand (Seite am Zug wechselt).
function chApply(state, m) {
  const board = state.board.slice();
  const piece = board[m.from];
  const white = chIsWhite(piece);
  board[m.from] = '';
  if (m.flag === 'ep') board[m.to + (white ? 8 : -8)] = '';
  board[m.to] = m.promo ? (white ? m.promo.toUpperCase() : m.promo) : piece;
  if (m.flag === 'castleK') { board[m.to + 1] = ''; board[m.to - 1] = white ? 'R' : 'r'; }
  if (m.flag === 'castleQ') { board[m.to - 2] = ''; board[m.to + 1] = white ? 'R' : 'r'; }

  let castling = state.castling;
  const strip = (chars) => { for (const ch of chars) castling = castling.replace(ch, ''); };
  if (piece === 'K') strip('KQ');
  if (piece === 'k') strip('kq');
  [m.from, m.to].forEach((sq) => {
    if (sq === 63) strip('K');
    if (sq === 56) strip('Q');
    if (sq === 7) strip('k');
    if (sq === 0) strip('q');
  });
  const ep = m.flag === 'double' ? (m.from + m.to) / 2 : -1;
  return { board, turn: state.turn === 1 ? 2 : 1, castling, ep };
}

// Nur Züge, nach denen der eigene König nicht im Schach steht.
function chLegalMoves(state) {
  const white = state.turn === 1;
  return chPseudoMoves(state).filter((m) => !chInCheck(chApply(state, m).board, white));
}

function chPositionKey(state) {
  // "en passant" zählt nur, wenn er auch wirklich möglich ist (gleiche Stellung = gleiche Zugmöglichkeiten)
  const epPart = (state.ep >= 0 && chLegalMoves(state).some((m) => m.flag === 'ep')) ? String(state.ep) : '-';
  return state.board.map((c) => c || '.').join('') + (state.turn === 1 ? 'w' : 'b') + (state.castling || '-') + epPart;
}

// Zu wenig Material für ein Matt: König gegen König, König+Läufer/Springer gegen König,
// oder nur Läufer, die alle auf gleichfarbigen Feldern stehen.
function chInsufficientMaterial(board) {
  const minors = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === '') continue;
    const t = p.toLowerCase();
    if (t === 'k') continue;
    if (t === 'p' || t === 'r' || t === 'q') return false;
    minors.push({ t, squareColor: ((i >> 3) + (i & 7)) % 2 });
  }
  if (minors.length <= 1) return true;
  return minors.every((m) => m.t === 'b' && m.squareColor === minors[0].squareColor);
}

// Beurteilt die Stellung NACH einem Zug (die Seite am Zug ist der Gegner des Ziehenden).
function chEvaluate(state, posHistory) {
  const white = state.turn === 1;
  if (chLegalMoves(state).length === 0) {
    return chInCheck(state.board, white) ? { over: true, mate: true, reason: 'checkmate' } : { over: true, draw: true, reason: 'stalemate' };
  }
  if (chInsufficientMaterial(state.board)) return { over: true, draw: true, reason: 'insufficient' };
  const key = posHistory[posHistory.length - 1];
  if (posHistory.filter((k) => k === key).length >= 3) return { over: true, draw: true, reason: 'repetition' };
  return { over: false };
}

// ----- Tic Tac Toe: reine Spiellogik (Index = Reihe * 3 + Spalte) -----
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

// Liefert die Felder der Gewinnreihe des Spielers oder null.
function tttCheckWin(board, player) {
  return TTT_LINES.find((line) => line.every((i) => board[i] === player)) || null;
}

function tttIsFull(board) {
  return board.every((v) => v !== 0);
}

// ----- Kniffel: reine Spiellogik -----
const KN_UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
const KN_LOWER = ['threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'kniffel', 'chance'];
const KN_BOXES = KN_UPPER.concat(KN_LOWER);
const KN_LABELS = {
  ones: 'Einser', twos: 'Zweier', threes: 'Dreier', fours: 'Vierer', fives: 'Fünfer', sixes: 'Sechser',
  threeKind: 'Dreierpasch', fourKind: 'Viererpasch', fullHouse: 'Full House', smallStraight: 'Kleine Straße',
  largeStraight: 'Große Straße', kniffel: 'Kniffel', chance: 'Chance'
};
const KN_TURNS = 26;              // 13 Felder pro Spieler, 2 Spieler
const KN_BONUS_LIMIT = 63;        // ab so vielen Punkten im oberen Teil gibt es den Bonus
const KN_BONUS_POINTS = 35;
const KN_EXTRA_KNIFFEL = 100;     // Bonus für jeden weiteren Kniffel (wenn im Kniffel-Feld 50 stehen)

function knCounts(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  dice.forEach((d) => { counts[d] += 1; });
  return counts;
}

function knSum(dice) {
  return dice.reduce((a, b) => a + b, 0);
}

function knIsKniffel(dice) {
  return dice.length === 5 && dice[0] > 0 && dice.every((d) => d === dice[0]);
}

// Punkte eines Wurfs in einem Feld – immer nach den normalen Regeln
// (auch ein weiterer Kniffel zählt z.B. nicht als Full House oder Straße).
function knScoreBox(dice, box) {
  const counts = knCounts(dice);
  const maxCount = Math.max(...counts.slice(1));
  const upperIdx = KN_UPPER.indexOf(box);
  if (upperIdx >= 0) return counts[upperIdx + 1] * (upperIdx + 1);
  const has = (values) => values.every((v) => counts[v] > 0);
  switch (box) {
    case 'threeKind': return maxCount >= 3 ? knSum(dice) : 0;
    case 'fourKind': return maxCount >= 4 ? knSum(dice) : 0;
    case 'fullHouse': return (counts.includes(3) && counts.includes(2)) ? 25 : 0;
    case 'smallStraight': return (has([1, 2, 3, 4]) || has([2, 3, 4, 5]) || has([3, 4, 5, 6])) ? 30 : 0;
    case 'largeStraight': return (has([1, 2, 3, 4, 5]) || has([2, 3, 4, 5, 6])) ? 40 : 0;
    case 'kniffel': return knIsKniffel(dice) ? 50 : 0;
    case 'chance': return knSum(dice);
    default: return 0;
  }
}

// Jeder Wurf darf in jedes noch freie Feld eingetragen werden – auch ein weiterer Kniffel.
function knFreeBoxes(card) {
  return KN_BOXES.filter((b) => card[b] === undefined);
}

// 100 Bonuspunkte für jeden weiteren Kniffel, sobald im Kniffel-Feld 50 Punkte stehen
// (bei einem gestrichenen Kniffel-Feld mit 0 gibt es keinen Bonus). Der Wurf wird danach
// ganz normal in ein freies Feld eingetragen.
function knExtraBonusFor(dice, card) {
  return knIsKniffel(dice) && card.kniffel === 50 ? KN_EXTRA_KNIFFEL : 0;
}

function knUpperSum(card) {
  return KN_UPPER.reduce((s, b) => s + (card[b] || 0), 0);
}

function knUpperBonus(card) {
  return knUpperSum(card) >= KN_BONUS_LIMIT ? KN_BONUS_POINTS : 0;
}

function knLowerSum(card) {
  return KN_LOWER.reduce((s, b) => s + (card[b] || 0), 0);
}

function knTotal(card, extra) {
  return knUpperSum(card) + knUpperBonus(card) + knLowerSum(card) + (extra || 0);
}

// Würfel: gleichmäßig verteilt (Rejection-Sampling), nach Möglichkeit mit dem Zufallsgenerator des Browsers.
function kniffelDefaultDie() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= 4294967292);   // 4294967292 = 6 * 715827882
    return (x % 6) + 1;
  }
  return Math.floor(Math.random() * 6) + 1;
}

let kniffelRoller = kniffelDefaultDie;

function kniffelDie() {
  return kniffelRoller();
}

// ----- Othello: reine Spiellogik (Index = Reihe * 8 + Spalte, Reihe 0 = oben; 1 = Spieler 1, 2 = Spieler 2) -----
const OT_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function otNewBoard() {
  const board = new Array(64).fill(0);
  board[27] = 2; board[36] = 2;     // Mitte: je zwei Steine über Kreuz
  board[28] = 1; board[35] = 1;
  return board;
}

// Welche gegnerischen Steine würden umgedreht, wenn der Spieler auf idx setzt? ([] = Zug nicht erlaubt)
function otFlips(board, idx, player) {
  if (board[idx] !== 0) return [];
  const row = idx >> 3;
  const col = idx & 7;
  const opp = player === 1 ? 2 : 1;
  const flips = [];
  for (const [dr, dc] of OT_DIRS) {
    const line = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === opp) {
      line.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (line.length && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === player) flips.push(...line);
  }
  return flips;
}

// Alle erlaubten Züge des Spielers: Feld -> umzudrehende Steine
function otLegalMoves(board, player) {
  const moves = new Map();
  for (let i = 0; i < 64; i++) {
    const flips = otFlips(board, i, player);
    if (flips.length) moves.set(i, flips);
  }
  return moves;
}

function otHasMove(board, player) {
  for (let i = 0; i < 64; i++) if (otFlips(board, i, player).length) return true;
  return false;
}

function otApply(board, idx, player) {
  const flips = otFlips(board, idx, player);
  const next = board.slice();
  next[idx] = player;
  flips.forEach((i) => { next[i] = player; });
  return { board: next, flips };
}

function otCount(board) {
  const counts = { 1: 0, 2: 0 };
  board.forEach((v) => { if (v) counts[v] += 1; });
  return counts;
}

// ----- Turniere: reine Logik (Datum, Spielplan, Tabelle, Gleichstand-Regeln) -----
const TN_WIN = 3;                 // Punkte für einen Sieg
const TN_DRAW = 1;                // Punkte für ein Unentschieden
const TN_SHOW_AFTER_DAYS = 7;     // so lange bleibt ein beendetes Turnier bei den Teilnehmern sichtbar

function tnDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tnParseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function tnAddDays(s, n) {
  const d = tnParseDate(s);
  d.setDate(d.getDate() + n);
  return tnDateStr(d);
}

// Der letzte Tag, an dem noch gespielt werden darf (bei 1 Tag = der Starttag selbst)
function tnEndDate(startDate, days) {
  return tnAddDays(startDate, days - 1);
}

let tnTodayFn = () => tnDateStr(new Date());

function tnToday() {
  return tnTodayFn();
}

function tnRangeLabel(t) {
  const [y1, m1, d1] = t.startDate.split('-');
  const [y2, m2, d2] = t.endDate.split('-');
  return t.startDate === t.endDate ? `${d1}.${m1}.${y1}` : `${d1}.${m1}.–${d2}.${m2}.${y2}`;
}

function tnPrizeLabel(t) {
  return `${t.prize} €`;
}

function tnPrizeReason(t) {
  return `Turniersieg: ${(GAME_TYPES[t.game] || { label: t.game }).label} (${tnRangeLabel(t)})`;
}

function tnGameId(tid, key) {
  return 't_' + tid + '_' + key;
}

// Jeder gegen jeden. Wer beginnt (Spieler 1), wird möglichst gleichmäßig verteilt.
function tnFixtures(participants) {
  const fixtures = [];
  let k = 0;
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const swap = (i + j) % 2 === 1;
      fixtures.push({ key: 'f' + k, players: swap ? [participants[j], participants[i]] : [participants[i], participants[j]] });
      k += 1;
    }
  }
  return fixtures;
}

// Ergebnis eines Spiels zählt nur, wenn es einen Sieger (1/2) oder ein Unentschieden (0) gibt; -1 = gestrichen.
function tnCounts(result) {
  return !!result && (result.winner === 0 || result.winner === 1 || result.winner === 2);
}

function tnStandings(participants, fixtures, results) {
  const rows = {};
  participants.forEach((n) => { rows[n] = { name: n, played: 0, wins: 0, draws: 0, losses: 0, points: 0 }; });
  fixtures.forEach((f) => {
    const r = (results || {})[f.key];
    if (!tnCounts(r)) return;
    const [a, b] = f.players;
    rows[a].played += 1;
    rows[b].played += 1;
    if (r.winner === 0) {
      rows[a].draws += 1; rows[b].draws += 1;
      rows[a].points += TN_DRAW; rows[b].points += TN_DRAW;
    } else {
      const w = f.players[r.winner - 1];
      const l = f.players[r.winner === 1 ? 1 : 0];
      rows[w].wins += 1; rows[l].losses += 1;
      rows[w].points += TN_WIN;
    }
  });
  return rows;
}

// Fester "Zufall": hängt nur vom Startwert des Turniers und vom Namen ab, ist also bei jedem Aufruf gleich.
function tnHash(seed, name) {
  const s = String(seed) + ':' + String(name).toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Reihenfolge der Tabelle:
// 1. Punkte
// 2. bei Gleichstand: direkter Vergleich (Punkte aus den Spielen der Gleichplatzierten gegeneinander)
// 3. dann: wer in der normalen Tabelle des Spiels öfter gegen den anderen gewonnen hat (duelWins = Statistik "gewinner|verlierer")
// 4. dann: fester Zufall
function tnRanking(t, duelWins) {
  const fixtures = tnFixtures(t.participants);
  const results = t.results || {};
  const stand = tnStandings(t.participants, fixtures, results);
  const wins = duelWins || {};

  const directPoints = (names) => {
    const pts = Object.fromEntries(names.map((n) => [n, 0]));
    fixtures.forEach((f) => {
      const r = results[f.key];
      if (!tnCounts(r)) return;
      const [a, b] = f.players;
      if (!names.includes(a) || !names.includes(b)) return;
      if (r.winner === 0) { pts[a] += TN_DRAW; pts[b] += TN_DRAW; } else pts[f.players[r.winner - 1]] += TN_WIN;
    });
    return pts;
  };
  const duelNet = (names) => Object.fromEntries(names.map((n) => [n, names.reduce((sum, m) => {
    if (m === n) return sum;
    return sum + (wins[n.toLowerCase() + '|' + m.toLowerCase()] || 0) - (wins[m.toLowerCase() + '|' + n.toLowerCase()] || 0);
  }, 0)]));
  const splitBy = (names, scores) => {
    const groups = new Map();
    names.forEach((n) => {
      if (!groups.has(scores[n])) groups.set(scores[n], []);
      groups.get(scores[n]).push(n);
    });
    return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, g]) => g);
  };
  const breakTies = (names) => {
    if (names.length <= 1) return names;
    let parts = splitBy(names, directPoints(names));
    if (parts.length === 1) parts = splitBy(names, duelNet(names));
    if (parts.length === 1) {
      return names.slice().sort((a, b) => (tnHash(t.seed, a) - tnHash(t.seed, b)) || a.localeCompare(b));
    }
    return parts.flatMap(breakTies);
  };
  const byPoints = splitBy(t.participants, Object.fromEntries(Object.values(stand).map((r) => [r.name, r.points])));
  return byPoints.flatMap(breakTies);
}

function tnHasCountedResults(t) {
  return Object.values(t.results || {}).some(tnCounts);
}

// Hat die App etwas zu erledigen (Spiele anlegen, Finale anlegen, auswerten)?
function tnNeedsAdvance(t, today) {
  if (!t || !t.status || t.status === 'finished' || !Array.isArray(t.participants)) return false;
  const results = t.results || {};
  const expired = today > t.endDate;
  if (t.status === 'scheduled') return today >= t.startDate;
  if (t.status === 'group') return expired || tnFixtures(t.participants).every((f) => results[f.key]);
  if (t.status === 'final') return expired || !!results.final;
  return false;
}

// Sieht die Person das Turnier? Nur Teilnehmer, ab dem Starttag, nach dem Ende noch einige Tage.
function tnVisibleTo(t, name, today) {
  if (!t || !Array.isArray(t.participants) || !t.participants.includes(name)) return false;
  return today >= t.startDate && today <= tnAddDays(t.endDate, TN_SHOW_AFTER_DAYS);
}

function tnGameDoc(t, tid, key, players, round, ts) {
  return {
    type: t.game, players, pairKey: gamePairKey(players[0], players[1]), status: 'active',
    ...gameInitialFields(t.game),
    tournamentId: tid, fixtureKey: key, round, createdAt: ts, startedAt: ts, updatedAt: ts
  };
}

// ----- Schiffe versenken: reine Spiellogik -----
// Feld 10 x 10, Index = Reihe * 10 + Spalte. Jeder Spieler hat ein eigenes Feld ("grid"): 0 = Wasser,
// 1 bis 5 = Nummer des Schiffs an diesem Feld. Flotte: Schiff 1 (5 Felder), 2 (4), 3 (3), 4 (3), 5 (2).
// Schiffe dürfen sich berühren, dürfen aber nicht übereinander liegen.
const SH_FLEET = [5, 4, 3, 3, 2];
const SH_LETTERS = 'ABCDEFGHIJ';

function shNewGrid() {
  return new Array(100).fill(0);
}

function shCellLabel(idx) {
  return SH_LETTERS[idx % 10] + (Math.floor(idx / 10) + 1);
}

function shShipCells(grid, id) {
  const cells = [];
  grid.forEach((v, i) => { if (v === id) cells.push(i); });
  return cells;
}

// Liegen die Felder in einer geraden, lückenlosen Linie (waagerecht oder senkrecht)?
function shIsLine(cells) {
  if (cells.length < 2) return false;
  const sorted = cells.slice().sort((a, b) => a - b);
  const sameRow = sorted.every((c) => Math.floor(c / 10) === Math.floor(sorted[0] / 10));
  const sameCol = sorted.every((c) => c % 10 === sorted[0] % 10);
  if (sameRow) return sorted.every((c, i) => i === 0 || c === sorted[i - 1] + 1);
  if (sameCol) return sorted.every((c, i) => i === 0 || c === sorted[i - 1] + 10);
  return false;
}

// Liefert '' wenn die Flotte gültig ist, sonst eine Fehlermeldung.
function shValidateGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== 100) return 'Ungültiges Spielfeld.';
  if (!grid.every((v) => Number.isInteger(v) && v >= 0 && v <= SH_FLEET.length)) return 'Ungültiges Spielfeld.';
  for (let id = 1; id <= SH_FLEET.length; id++) {
    const cells = shShipCells(grid, id);
    if (cells.length !== SH_FLEET[id - 1]) return 'Die Flotte ist nicht vollständig.';
    if (!shIsLine(cells)) return 'Jedes Schiff muss gerade liegen.';
  }
  return '';
}

// Felder, die ein Schiff belegen würde, oder null wenn es nicht passt (Rand, anderes Schiff im Weg).
// Das Schiff mit derselben Nummer darf überschrieben werden (zum Neu-Setzen).
function shPlacementCells(grid, id, startIdx, horizontal) {
  const size = SH_FLEET[id - 1];
  const row = Math.floor(startIdx / 10);
  const col = startIdx % 10;
  if (horizontal ? col + size > 10 : row + size > 10) return null;
  const cells = Array.from({ length: size }, (_, k) => (horizontal ? row * 10 + col + k : (row + k) * 10 + col));
  return cells.every((c) => grid[c] === 0 || grid[c] === id) ? cells : null;
}

// Zufällige gültige Flotte (rnd = Zufallsquelle, zum Testen austauschbar)
function shRandomGrid(rnd) {
  const rand = rnd || Math.random;
  for (let tries = 0; tries < 1000; tries++) {
    const grid = shNewGrid();
    let complete = true;
    for (let id = 1; id <= SH_FLEET.length && complete; id++) {
      let placed = false;
      for (let attempt = 0; attempt < 200 && !placed; attempt++) {
        const horizontal = rand() < 0.5;
        const start = Math.floor(rand() * 100);
        const cells = shPlacementCells(grid, id, start, horizontal);
        if (cells && cells.every((c) => grid[c] === 0)) { cells.forEach((c) => { grid[c] = id; }); placed = true; }
      }
      if (!placed) complete = false;
    }
    if (complete) return grid;
  }
  const fallback = shNewGrid();                                  // sollte praktisch nie nötig sein
  SH_FLEET.forEach((size, k) => { for (let c = 0; c < size; c++) fallback[(k * 2) * 10 + c] = k + 1; });
  return fallback;
}

// Schuss auf ein Feld: shot = bisherige Schüsse auf dieses Feld (0/1 je Feld)
function shApplyShot(grid, shot, idx) {
  const next = shot.slice();
  next[idx] = 1;
  const id = grid[idx];
  if (!id) return { shot: next, result: 'miss', sunkId: 0, sunkSize: 0, allSunk: false };
  const cells = shShipCells(grid, id);
  const sunk = cells.every((c) => next[c] === 1);
  const allSunk = SH_FLEET.every((_, k) => shShipCells(grid, k + 1).every((c) => next[c] === 1));
  return { shot: next, result: sunk ? 'sunk' : 'hit', sunkId: sunk ? id : 0, sunkSize: sunk ? cells.length : 0, allSunk };
}

function shSunkIds(grid, shot) {
  return SH_FLEET.map((_, k) => k + 1).filter((id) => shShipCells(grid, id).every((c) => shot[c] === 1));
}

function shShipsLeft(grid, shot) {
  return SH_FLEET.length - shSunkIds(grid, shot).length;
}

// Von wem wird als Nächstes etwas erwartet? Meist der Spieler am Zug; beim Platzieren der Flotte alle, die noch nicht fertig sind.
function gameWaitingOn(g) {
  if (gameTypeOf(g) === 'ships' && g.phase === 'placing') return [1, 2].filter((n) => !g['ready' + n]);
  return [g.turn];
}

// ----- Blokus: reine Spiellogik -----
// 2 Spieler: kleines Brett (Blokus Duo, 14 x 14), 3 oder 4 Spieler: 20 x 20 (bei 3 Spielern bleibt die vierte Farbe ungenutzt).
// Brett: Reihe * Größe + Spalte; 0 = leer, 1 bis 4 = Nummer des Spielers (Farbe) auf dem Feld.
// Jeder Spieler hat 21 Formstücke (89 Quadrate). Das erste Stück liegt auf dem Startfeld, jedes weitere berührt
// einen eigenen Stein an einer Ecke, aber nie an einer Kante. An fremde Steine darf man überall anlegen.
const BL_PIECES = {
  I1: [[0, 0]],
  I2: [[0, 0], [0, 1]],
  I3: [[0, 0], [0, 1], [0, 2]],
  V3: [[0, 0], [1, 0], [1, 1]],
  I4: [[0, 0], [0, 1], [0, 2], [0, 3]],
  L4: [[0, 0], [1, 0], [2, 0], [2, 1]],
  T4: [[0, 0], [0, 1], [0, 2], [1, 1]],
  O4: [[0, 0], [0, 1], [1, 0], [1, 1]],
  Z4: [[0, 0], [0, 1], [1, 1], [1, 2]],
  I5: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
  L5: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]],
  N5: [[0, 1], [1, 1], [2, 1], [2, 0], [3, 0]],
  P5: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]],
  F5: [[0, 1], [0, 2], [1, 0], [1, 1], [2, 1]],
  T5: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]],
  U5: [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2]],
  V5: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
  W5: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],
  X5: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]],
  Y5: [[0, 1], [1, 0], [1, 1], [2, 1], [3, 1]],
  Z5: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]]
};
const BL_NAMES = Object.keys(BL_PIECES);
const BL_TOTAL_SQUARES = 89;

function blNormalize(cells) {
  const minR = Math.min(...cells.map((c) => c[0]));
  const minC = Math.min(...cells.map((c) => c[1]));
  return cells.map(([r, c]) => [r - minR, c - minC]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function blRotate(cells) {
  return blNormalize(cells.map(([r, c]) => [c, -r]));
}

function blFlip(cells) {
  return blNormalize(cells.map(([r, c]) => [r, -c]));
}

function blKey(cells) {
  return blNormalize(cells).map(([r, c]) => r + ',' + c).join(';');
}

// Alle verschiedenen Lagen eines Stücks (Drehungen und Spiegelungen)
function blOrientations(cells) {
  const seen = new Map();
  let cur = blNormalize(cells);
  for (let f = 0; f < 2; f++) {
    for (let k = 0; k < 4; k++) {
      seen.set(blKey(cur), cur);
      cur = blRotate(cur);
    }
    cur = blFlip(cur);
  }
  return [...seen.values()];
}

const BL_ORIENTS = Object.fromEntries(BL_NAMES.map((n) => [n, blOrientations(BL_PIECES[n])]));
const BL_ORIENT_KEYS = Object.fromEntries(BL_NAMES.map((n) => [n, new Set(BL_ORIENTS[n].map(blKey))]));

function blSize(playerCount) {
  return playerCount === 2 ? 14 : 20;
}

// Startfeld des Spielers: Duo (14 x 14): zwei Felder in der Mitte; 20 x 20: die vier Ecken (im Uhrzeigersinn ab oben links)
function blStartIdx(size, slot) {
  if (size === 14) return slot === 1 ? 4 * 14 + 4 : 9 * 14 + 9;
  return [0, 19, 19 * 20 + 19, 19 * 20][slot - 1];
}

function blRemaining(used) {
  return BL_NAMES.filter((n) => !used.includes(n));
}

function blRemainingSquares(used) {
  return blRemaining(used).reduce((s, n) => s + BL_PIECES[n].length, 0);
}

// Wertung wie im Original: jedes Restfeld zählt minus 1; alle Stücke gelegt +15, und +5 mehr, wenn das Einzelquadrat zuletzt kam
function blScore(used) {
  const left = blRemainingSquares(used);
  if (left > 0) return -left;
  return 15 + (used[used.length - 1] === 'I1' ? 5 : 0);
}

// Entspricht die Auswahl von Feldern einer Lage des Stücks (an beliebiger Stelle des Bretts)?
function blShapeMatches(piece, cells, size) {
  if (!BL_PIECES[piece] || cells.length !== BL_PIECES[piece].length) return false;
  const coords = cells.map((i) => [Math.floor(i / size), i % size]);
  return BL_ORIENT_KEYS[piece].has(blKey(coords));
}

// Liefert '' wenn die Felder regelkonform belegt werden dürfen, sonst den Grund.
// first = der Spieler hat noch kein Stück gelegt.
function blCheckMove(board, size, slot, cells, first) {
  const set = new Set(cells);
  let corner = false;
  for (const idx of cells) {
    if (board[idx] !== 0) return 'Dieses Feld ist schon belegt.';
    const r = Math.floor(idx / size);
    const c = idx % size;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      if (board[rr * size + cc] === slot) return 'Das Stück darf deine eigenen Steine nicht an einer Kante berühren.';
    }
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      if (board[rr * size + cc] === slot) corner = true;
    }
  }
  if (first) return set.has(blStartIdx(size, slot)) ? '' : 'Das erste Stück muss auf dem Startfeld liegen.';
  return corner ? '' : 'Das Stück muss einen deiner Steine an einer Ecke berühren.';
}

// Felder, auf die ein Stück mit einer seiner Zellen fallen muss (Startfeld bzw. freie Eck-Anschlussfelder)
function blAnchors(board, size, slot, first) {
  if (first) {
    const start = blStartIdx(size, slot);
    return board[start] === 0 ? [start] : [];
  }
  const anchors = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== slot) continue;
    const r = Math.floor(i / size);
    const c = i % size;
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const idx = rr * size + cc;
      if (board[idx] !== 0) continue;
      const edgeOwn = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([er, ec]) => {
        const r2 = rr + er;
        const c2 = cc + ec;
        return r2 >= 0 && r2 < size && c2 >= 0 && c2 < size && board[r2 * size + c2] === slot;
      });
      if (!edgeOwn) anchors.add(idx);
    }
  }
  return [...anchors];
}

// Alle erlaubten Züge (Stück + Felder) der noch nicht gelegten Stücke; stopAtFirst für die schnelle Frage "gibt es einen?"
function blMoves(board, size, slot, remaining, first, stopAtFirst) {
  const anchors = blAnchors(board, size, slot, first);
  const found = new Map();
  for (const name of remaining) {
    for (const shape of BL_ORIENTS[name]) {
      for (const [sr, sc] of shape) {
        for (const a of anchors) {
          const ar = Math.floor(a / size);
          const ac = a % size;
          const cells = [];
          let inside = true;
          for (const [r, c] of shape) {
            const rr = ar + (r - sr);
            const cc = ac + (c - sc);
            if (rr < 0 || rr >= size || cc < 0 || cc >= size) { inside = false; break; }
            cells.push(rr * size + cc);
          }
          if (!inside || blCheckMove(board, size, slot, cells, first) !== '') continue;
          const key = name + ':' + cells.slice().sort((x, y) => x - y).join(',');
          if (!found.has(key)) {
            found.set(key, { piece: name, cells });
            if (stopAtFirst) return [...found.values()];
          }
        }
      }
    }
  }
  return [...found.values()];
}

function blHasMove(board, size, slot, remaining, first) {
  return blMoves(board, size, slot, remaining, first, true).length > 0;
}

// Wer ist nach einem Zug (oder einer Aufgabe) von fromSlot als Nächstes dran?
// Wer nicht mehr legen kann, scheidet für den Rest der Runde aus (outSlots). turn = 0 heißt: keiner kann mehr.
function blAdvance(size, board, usedList, outSlots, resigned, fromSlot) {
  const n = usedList.length;
  const out = new Set(outSlots);
  for (let k = 1; k <= n; k++) {
    const t = ((fromSlot - 1 + k) % n) + 1;
    if (out.has(t) || resigned.includes(t)) continue;
    if (blHasMove(board, size, t, blRemaining(usedList[t - 1]), usedList[t - 1].length === 0)) {
      return { turn: t, outSlots: [...out].sort((a, b) => a - b) };
    }
    out.add(t);
  }
  return { turn: 0, outSlots: [...out].sort((a, b) => a - b) };
}

// Punkte aller Spieler und Sieger (nur wer nicht aufgegeben hat, kann gewinnen); mehrere Sieger = Gleichstand
function blResult(usedList, resigned) {
  const scores = usedList.map((u) => blScore(u));
  const contenders = usedList.map((_, i) => i + 1).filter((s) => !resigned.includes(s));
  const best = Math.max(...contenders.map((s) => scores[s - 1]));
  return { scores, winners: contenders.filter((s) => scores[s - 1] === best) };
}

// ----- Sudoku (Solospiel): Aufgaben, Hilfen, Bestzeiten -----
// Die Aufgaben sind selbst erzeugt und geprüft: jede hat genau eine Lösung. Format "Aufgabe:Lösung" (81 Ziffern, 0 = leer).
// Leicht: nur eindeutige Felder nötig. Mittel: dazu versteckte Einzelzahlen. Schwer: schwierigere Techniken, aber nie Raten.
const SU_LEVELS = [
  { key: 'easy', label: 'Leicht' },
  { key: 'medium', label: 'Mittel' },
  { key: 'hard', label: 'Schwer' }
];
const SU_PUZZLES = {
  easy: [
    '500780032000000504260000078780200050300594817009100000600409080070326000900807300:594781632817632594263945178781263459326594817459178263632459781178326945945817326',
    '000000004640205010700006502258100600096508173017094025960850700580710006100060000:825371964649285317731946582258137649496528173317694825964852731582713496173469258',
    '250800610780010503109023800690350480002067001030082007425700030070000040016000708:253874619784619523169523874697351482842967351531482967425798136978136245316245798',
    '007605831502308007801000060320040000670283904900056000046000080189400053203891000:497625831562318497831974562328149675675283914914756328746532189189467253253891746',
    '000012730020073900057006008030090810002350004900081073690000007000009281081735400:469812735128573946357946128735694812812357694946281573694128357573469281281735469',
    '018064035402093100000010602680029510150700204000350800001000000549000020206000381:718264935462593178395817642687429513153786294924351867831672459549138726276945381',
    '000260007000080090075194003097406008264000700000010406300071940018042605009630870:941263587632587194875194263197426358264358719583719426356871942718942635429635871',
    '549008713013945020800010500090560008238001000465800097000086070002009084080000951:549628713713945826826317549197564238238791465465832197951486372372159684684273951',
    '070600000108400000030000057620901570000547630040362008700006100302108705981704300:475623891198475263236819457623981574819547632547362918754236189362198745981754326',
    '790000006500000814180005009007810605801000070260039400070001502008250007602900100:793148256526397814184625739937814625841562973265739481379481562418256397652973148',
    '380020001006380094040706803204000305071508029008000007000167000003094716100050940:385429671716385294942716853294671385671538429538942167429167538853294716167853942',
    '400063000000704060000100750269041030050690040000507602000320000690008005532916070:475263189918754263326189754269841537753692841184537692847325916691478325532916478',
    '310470962000200010600001408530080000480900000209010780708629301003840290926005047:315478962874296513692351478531784629487962135269513784748629351153847296926135847',
    '004085300800000000600491285080000129467020030091000000009803610730604952100900873:914285367852367491673491285385746129467129538291538746529873614738614952146952873',
    '000709001879134050000005897006508700790000005058903164400800010507001426900000078:625789341879134652314265897146528739793416285258973164462857913587391426931642578',
    '100000806090864020800105379640201900903040152001709600002090000000500003039080200:125973846397864521864125379648251937973648152251739684512397468486512793739486215',
    '007180500320740100080020064590007416730401850004000070473008005009000000810950340:647189532325746198981523764598237416732461859164895273473618925259374681816952347',
    '609510000847603500210870093008060000006251004052087000003000487000036025501000030:639512748847693512215874693478369251396251874152487369963125487784936125521748936',
    '000060070901240000047853900195706348000004050380005062008079400070030081432018600:853961274961247835247853916195726348726384159384195762518679423679432581432518697',
    '700982034009603000000010900400700085802304706100258040004100857600070090570000103:715982634289643571346517928493761285852394716167258349924136857631875492578429163',
    '379502400040070265200000703700056010000010000080007600520800300014039500030625048:379562481148973265265184793793256814652418937481397652526841379814739526937625148',
    '009025000006070001002060097704250080120000009000094000608047015201306900040502368:479125836386479521512863497794251683125638749863794152638947215251386974947512368',
    '058270301027010048900000007079000020080700050514060739090020070760900402800600905:458276391627319548931584267379145826286793154514862739195428673763951482842637915',
    '600082030009750021020934567003060000005821049812000600200090000576008493090070080:657182934439756821128934567943567218765821349812349675281493756576218493394675182',
    '002000980007005010040708352084000120010080079750002864400009601900103740060870090:532641987897235416146798352684957123213486579759312864478529631925163748361874295',
    '060008003000071080408050001500710802084530010070200030000305107716000095395107408:167428953953671284428953671539716842284539716671284539842395167716842395395167428',
    '000296840020010357000000629400307090007060400092084003269801000053620000140500000:375296841926418357814735629481357296537962418692184573269841735753629184148573962',
    '400089020200001080580027300702014000000090072005206130007043809103950267050702000:431589726276431985589627341762314598314895672895276134627143859143958267958762413',
    '020065000700302058500090001400120506800970300000658090085040120947000865213580004:321865749794312658568497231479123586856974312132658497685749123947231865213586974',
    '790508000568000791304700008806052109000076450400000006017005000903000280280900017:791568324568324791324791568876452139139876452452139876617285943943617285285943617',
    '694008050080500094270090830027004080018705069069300070006803500000207900002640308:694138752183572694275496831527964183318725469469381275946813527831257946752649318',
    '080153060005009070906000001009001030060700025100634807631900582704085010000016749:287153964315469278946872351879521436463798125152634897631947582794285613528316749',
    '601032050020047000475060392507810020940700003000204076000000000700309005204001800:681932457329547618475168392567813924942756183138294576893425761716389245254671839',
    '008000421000012809004003000007154980501928703209000100490080006003501290600009308:938675421756412839124893657367154982541928763289736145492387516873561294615249378',
    '700003406000971000008050079070180063820360790603407281107200000360500010005008000:719823456546971328238654179974182563821365794653497281187236945362549817495718632',
    '605012070002800005307009100008006204000104007200008560050241738421703950870065001:695412873142837695387659142738596214569124387214378569956241738421783956873965421',
    '000309068320006105006150002645000000030040000710938604094060007501203009203000000:157329468329486175486157392645712983938645721712938654894561237561273849273894516',
    '260348009000201030040059601000093057007602043490000802000025086005836700800974005:261348579759261438348759621682493157517682943493517862974125386125836794836974215',
    '609050700207006000015080000040020690708360100003014800000145278802600450000078006:639451782287936514415782369541827693728369145963514827396145278872693451154278936',
    '008047000000165030000000740010300427702500089300700005150039204890072056400601000:938247561274165938561983742615398427742516389389724615156839274893472156427651893',
    '700600000100053040032784169040000503005807000901030800470061052000025007000400091:784619235196253748532784169847196523325847916961532874478961352619325487253478691',
    '080060410567000300120300700708000039000000640010293870000546103231908504640002987:983765412567421398124389756758614239392857641416293875879546123231978564645132987',
    '730408015100063080400020300000152037000809521000300408940205000502630840070080152:736498215125763984489521376894152637367849521251376498948215763512637849673984152',
    '100056904900001300053940020008007530065009712012560000500090001800102053201035849:127356984984721365653948127498217536365489712712563498536894271849172653271635849',
    '375000809980357002000060037600000204021080700500124006000241090869730000042800000:375412869986357142214968537698573214421689753537124986753241698869735421142896375',
    '310790254879000601040163087065000070093000006000054009630019700200306100000500403:316798254879425631542163987465931872193287546728654319634819725257346198981572463',
    '320970000060400023010020709001030097790000038030069500154002076000090045600005380:328976451967451823415823769541238697796514238832769514154382976283697145679145382',
    '000684000400001002070920460300000600917000004650800001865407219201560703000190006:529684137486371592173925468348719625917256384652843971865437219291568743734192856',
    '000092010085007296206005004960000000430060000050034962374000850620100437010003600:743692518185347296296815374962581743437269185851734962374926851629158437518473629',
    '209000005705000008108706902576902100810507029920410000007009000400000003390100060:239841675765293418148756932576932184814567329923418756657329841481675293392184567'
  ],
  medium: [
    '005382000004000003800700006900160000050208790300900500060023040203090600470016020:615382479794651283832749156947165832156238794328974561561823947283497615479516328',
    '203040080085100006400890000308001000000000090047038620000019002002504030000600800:213746985985123476476895213398261547621457398547938621854319762762584139139672854',
    '050000078001070000040509210000300801004900000600040950500182090000000605009635000:956213478321478569847569213795326841184957326632841957563182794218794635479635182',
    '080690010000301005213000000105000030432007908060000501000870420700460000004005000:587694312946321785213758649175986234432517968869243571351879426798462153624135897',
    '080900370002007140053010200178000030300700004000050800037109002000060083520000090:481926375692537148753814269178492536365781924249653817837149652914265783526378491',
    '000100073000526900000000200600005080381260000000000000008050139009078500540300760:256194873873526914914783256627945381381267495495831627768452139139678542542319768',
    '970400030000780400600020008800046000203078004401500000320007041700600023000053870:978461235532789416614325798897146352253978164461532987325897641789614523146253879',
    '800000345201500000430060021100340008000170000003080000090700500710400600000096170:869217345271534896435968721127345968986172453543689217698721534712453689354896172',
    '600007000045801060038206074060070051004060007009405080006009000007180000080003795:692547813745831269138296574863972451514368927279415386326759148957184632481623795',
    '030600091090402000080001432920070016006900000074800000050049063200003000700100040:432687591591432687687591432925374816816925374374816925158249763249763158763158249',
    '070000006200000000000000079050006000362078540009010630510300098600700150007105200:978451326236897415145623879451236987362978541789514632514362798623789154897145263',
    '003109700074003500000600023020417008300000047400060000530000406040030901791000350:283159764674283519159674823925417638368925147417368295532791486846532971791846352',
    '007000030000130024900000000006903400300000070014075900000047308745008091060091000:427856139658139724931724856576983412389412675214675983192547368745368291863291547',
    '000600500020000000060070040601750000000080310800300205000520084700049100090160052:984631527527498631163275849631752498275984316849316275316527984752849163498163752',
    '001008000080000005040100000000860240608040050270013060500086072000204030007001680:351698724986427315742135896135869247698742153274513968513986472869274531427351689',
    '002000700070064080050030026000700040230086059804091000080000004000608000000342065:642815793379264581158937426915723648237486159864591372586179234423658917791342865',
    '000000500000073001305009060753000020060050140900006000530400680409080030008000904:194268573286573491375149268753914826862357149941826357537491682419682735628735914',
    '060020800073090140012370096056004308080000020240000060030600004005000000020030000:569421837873596142412378596956214378387965421241783965738659214695142783124837659',
    '500008601010075089803614050040900000050083000381006000034000800005029000900000070:572398641416275389893614257647952138259183764381746925134567892765829413928431576',
    '500200000400058000012000070000000002241695000030020069070082001020010056000507030:587231694469758123312946875956873412241695387738124569675382941823419756194567238',
    '500609140800050706700800005000000907000100200002006000410025600690401500005960004:523679148841253796769814325184532967976148253352796481418325679697481532235967814',
    '040010000709300800802009304005600010201080000670201008063028400000000006000163002:346812795759346821812759364985674213231985647674231958163528479528497136497163582',
    '609050027000200000070003508000390086010040275000705931001000750745002000800000002:639458127584217693172963548257391486913846275468725931321689754745132869896574312',
    '091074820800000030473580100000208600000096000900000502060040050007000960005009004:691374825852961437473582196734258619528196743916437582169743258347825961285619374',
    '030700160040162090000800040601003000500000009083000000000407600060000450057021903:839745162745162398216839745621983574574216839983574216398457621162398457457621983',
    '860010200971000000000030070090000100006108490007059006040703000000590602009004700:863917254971245863254836971495362187326178495187459326642783519738591642519624738',
    '300000405000010600060805009400007560000003007007058940000001020001286004000504700:319762485845319672762845139493127568658493217127658943534971826971286354286534791',
    '500004000002060084849001700756008001984200000000000008090002060070080023123076000:567894312312765984849321756756948231984213675231657498498132567675489123123576849',
    '005003849000000670849605010000021080504000000020004300000130000106400758090000006:675213849213849675849675213367921584584367921921584367758136492136492758492758136',
    '000410630600080704007690058040009000005001300000520047000030805030050000520074060:852417639693285714417693258741369582285741396369528147174936825936852471528174963',
    '304010052907000000000006009520400000700082040006107005002000700070025304643071508:364719852917258436285346179528463917791582643436197285852634791179825364643971528',
    '010439070000008510670050000943700100780000004020004700001903800800120903030000000:512439678394678512678251439943786125786512394125394786251943867867125943439867251',
    '008901500000006700060087002009504080030209605506800000080102000902000000650708010:378921564291456738465387192129564387837219645546873921783192456912645873654738219',
    '000042000801006050040100003306090785000057001058000400003009000500300046900020008:639542817871936254245178693316294785492857361758613429183469572527381946964725138',
    '902007460000004000050009008870060300090010506400030070007000902300071004000093007:932187465718654293654329718871465329293718546465932871187546932329871654546293187',
    '300050920009004000500008314008030607050000401430000800065209100140570000802000060:314657928289314576576928314928431657657892431431765892765289143143576289892143765',
    '850004203001200000032000090090576018000320000000408300000050040478000600020047930:857194263941263785632785194293576418184329576765418329319652847478931652526847931',
    '060005009805100067100000030740000006000043080002900700200094370090000000308200690:467835129835129467129467835743582916916743582582916743251694378694378251378251694',
    '000700068830090500050006912012947000040068103008002000000070850400003090000480006:291754368836291547754836912312947685947568123568312479623179854485623791179485236',
    '401058967000140358008096040500907021004503600009020000096000030000000090005600004:421358967967142358358796142583967421214583679679421583796214835142835796835679214',
    '405070000190042007003809000000760309650000040000020570300081405506000008802600703:425376981198542637763819254284765319657193842931428576379281465546937128812654793',
    '005407000060302007000010000090004026018006070002900100026000800070049201900060700:235497618861352497749618352397184526418526973652973184126735849573849261984261735',
    '060000070000260801000000020900000004006100000084507002010009260032418009097600018:263841975759263841841975326975326184326184597184597632418759263632418759597632418',
    '000800600600092100050070024700000805005007000020581003402108000070020000080060049:249815637637492158158376924763249815815637492924581763492158376376924581581763249',
    '000500007006080003700120065031006070000900032008300004103000708064890000007000006:312564987456789213789123465231456879645978132978312654123645798564897321897231546',
    '050180970400700020079500100002008000000050010800000052907205040048307205020000739:256184973481739526379526184562418397793652418814973652937265841148397265625841739',
    '030098014982000000000003000070019060000604000506307081010435000000900003050080190:735298614982146357461573829273819465198654732546327981619435278827961543354782196',
    '090040800030000007000063010308100070040080000020700368200000683007000901600910040:192547836836291457574863219368129574745386192921754368219475683457638921683912745',
    '013000790709030605050090000100000874807120000030070000025000000901302086468900002:213645798789231645654798231192563874847129563536874129325486917971352486468917352',
    '090428050024000030170300002960802010700006000248007096000084100000015900000000208:396428751824571639175369482963842517751936824248157396639284175482715963517693248'
  ],
  hard: [
    '000000002006905000009710300630000000950247010040100005100000007000400000893072100:417683592386925471529714368631859724958247613742136985164398257275461839893572146',
    '000075004003000050200001000000120000680090000000000975090000008305014090040060000:968275314413986752257431869579123486684597231132648975796352148325814697841769523',
    '040209000090060700000000030000090600073000040820000307000023010004005020000000905:547239168392168754681754239415397682973682541826541397759823416164975823238416975',
    '000001000572900031000200086005000000800000090000140023000300702400002819060010000:689431275572986431134275986325697148841523697796148523918354762453762819267819354',
    '021930080000000040000421000800004096000000000030570000009005002100090005070000030:421936587693857241785421963857214396214369758936578124369785412142693875578142639',
    '000200960000000008004000002000301027570004000001002600007640010080507000046010000:318275964725496138694138752469381527572964381831752649257649813183527496946813275',
    '700023004300004100486107003003410002000000060000308000632000005000075000000000800:791523684325684197486197523863419752914752368257368419632841975148975236579236841',
    '600803000090240080800097062000900000005400003040008709380000046002300507000000000:624813975597246381813597462138975624975462813246138759381759246462381597759624138',
    '000005000030006490005008067003701040040080700700400038002000904000030600001500003:167945382238176495495328167823761549549283716716459238382617954954832671671594823',
    '600005004004000000000002000042006100000530000100040007009000240301000090008070305:697315824284967531513482679842796153976531482135248967769153248351824796428679315',
    '006000040001040082000028000010000006060010000350002010090003060080790300003000107:826179543971345682435628971719534826268917435354862719197453268682791354543286197',
    '000000000183000050500000624000308000610020000000014700000700080000000143090001200:246579318183246957579183624927358461614927835358614792431762589762895143895431276',
    '600000000001340000050819043000100000000723500519400020090000430008200000000007080:634572918981346275257819643372195864846723591519468327795681432168234759423957186',
    '004700009000000061700090000000000038060300200900040000000000004025610000809024010:254761389398452761716893452542176938167389245983245176671938524425617893839524617',
    '000908720000064008090000600007020000000403900003800050400000060802051430061000000:614938725725164398398275614987526143256413987143897256439782561872651439561349872',
    '000960105500000980000002000300004092006500000000000513053890001060000009000206000:734968125521473986689152437315784692296531748847629513453897261162345879978216354',
    '070500030306870009009000000904100800001008000000000000000060020000000045702450013:278594136316872459549613287954136872631728594827945361495361728163287945782459613',
    '000000040250000070604080002000043708000010009903002000060408200000000601005009004:387251946251694873694387512516943728872516439943872165169438257438725691725169384',
    '008000590600900280700800610402130050010090008050004060000700000800013000000000000:248361597631975284795842613482136759316597428957284361163759842824613975579428136',
    '000020600008000000300140080051070906000600400009004800087003050900450270040007000:514728693728396541396145782451872936872639415639514827287963154963451278145287369',
    '068000300003080040009050000000070000080924050000001760310708900000009000020000607:768492315153687249249153876531876492687924153492531768315768924876249531924315687',
    '900005708060000000180900050500100300010090000203040870000320006004008002000000000:932465718465871293187932654546187329718293465293546871871329546654718932329654187',
    '300500007000680000905002000000425003037000500004031000000000736063908000010060000:386549217271683954945172368698425173137896542524731689859214736763958421412367895',
    '602000400037000020080000903000000002300000061010902800260070000045006000700000030:652793418937148625481265973874651392329487561516932847263879154145326789798514236',
    '082503000000000007537160000000007000900000701001000285709084000050000060008000000:482573916196428357537169842825317694964852731371946285719684523253791468648235179',
    '100005007900000200602907040000502003006000000700080005004000370000070410007410000:148625937973841256652937841481562793526793184739184625814256379265379418397418562',
    '930000000000070080081005030008047000023506090794000000800700300400090060300000005:937812546546379281281465937658947123123586794794231658862754319475193862319628475',
    '090076005100894000000100400002940006000530104000000050405080700009000001300410000:894276315153894627276153489532941876768532194941768253415689732689327541327415968',
    '000903200001000004000020000900100080005300000602058030800009060020005000040010700:578943216261587394493621875934162587785394621612758439857439162126875943349216758',
    '000000006008001305903600000090003080006108500017004000500000000009300000080407250:174539826268741395953682417495263781326178549817954632532816974749325168681497253',
    '020046807870000000000000010487000106003070005000001000000060000216080050340050201:521346897879215643634798512487529136163874925952631478795162384216483759348957261',
    '842006000000590004900000700530000400704000000001078000050900800008000042000060000:842736591367591284915284736536129478784653129291478653153942867678315942429867315',
    '002000070005040030008000500000008002000039600900600004000106000807090050060780000:392561478615847239478923561156478392784239615923615784239156847847392156561784923',
    '000000007006057000907001806000010600064500320310608000700003000040000100003080905:231864597486957213957231846579312684864579321312648759795123468648795132123486975',
    '000006009350028070700000480000000060820070000007003820900080600100090000008007030:482716359359428176761539482593842761824671593617953824935284617176395248248167935',
    '500000610000903040004070000800260970307000100010000400000040080100007000053000000:539428617761953842284176395845261973397584126612739458976345281128697534453812769',
    '050000000001060834000001060100020003005004900300007020009006000520800007004100002:652438719971562834483791265197625483265384971348917526719256348526843197834179652',
    '005073000010009080000000056003106000570000010000000008000008040900032000304600870:695873124412569387738241956843126795579384612261957438156798243987432561324615879',
    '002030004500840000100006003003000096700000000069002001000100060070604000006029300:692735184537841629148296573253417896714968235869352741925173468371684952486529317',
    '050040100090300070000010000067000005300004010109008000000060200700109030000050006:853746129291385674674912853467291385385674912129538467538467291746129538912853746',
    '490057100005032400003000000009700000301009560000003090650000000000000302002080070:498657123765132489213498756849765231321849567576213894657321948984576312132984675',
    '000006000450000000239080040075040000000605000903020000000064900802000630000000050:781456329456239871239781546675943218128675493943128765517364982892517634364892157',
    '085700030206000000000000084700006000000947310000020907862009000900000060000060450:485791632236584791197632584749316825528947316613825947862459173954173268371268459',
    '050080030100007060000003905801000000270004800000030000000090704740600020300005000:957486132123957468486123975831279546279564813564831297618392754745618329392745681',
    '400002160000700004000035009027000000304009000800020013040006000100000600000070805:435982167982761534761435289627314958314859726859627413548296371173548692296173845',
    '700810000900005700032000000000070800060103000020000305000000090193002000000001054:746819532981325746532467981315274869869153427427698315254786193193542678678931254',
    '030040005027060084081070300009084000000006008010200000002030000090000250000700060:936841725527963184481572396369184572275396418814257639752639841693418257148725963',
    '080090000900100408010000300028005070601400500300000002000020050042050100509610000:284593716953176428716248395428935671671482539395761842167824953842359167539617284',
    '090020004430010000000436010005008000007060009000000002003590800050700030270603000:591827364436915278782436915915278643827364159364159782643591827159782436278643591',
    '403002018000068003008400900010000006300006000070815000500000260000601000000080307:453792618792168543168453972815349726349276185276815439584937261937621854621584397'
  ]
};

const SU_UNITS = (() => {
  const units = [];
  for (let r = 0; r < 9; r++) units.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) units.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let b = 0; b < 9; b++) {
    const br = Math.floor(b / 3) * 3;
    const bc = (b % 3) * 3;
    units.push(Array.from({ length: 9 }, (_, k) => (br + Math.floor(k / 3)) * 9 + bc + (k % 3)));
  }
  return units;
})();
const SU_UNIT_KIND = ['Zeile', 'Spalte', 'Block'];

// Felder, die mit Feld i in derselben Zeile, Spalte oder demselben Block liegen
const SU_PEERS = Array.from({ length: 81 }, (_, i) => {
  const set = new Set();
  const r = Math.floor(i / 9);
  const c = i % 9;
  [r, 9 + c, 18 + Math.floor(r / 3) * 3 + Math.floor(c / 3)].forEach((u) => SU_UNITS[u].forEach((x) => { if (x !== i) set.add(x); }));
  return [...set];
});

function suPuzzle(level, idx) {
  const entry = (SU_PUZZLES[level] || [])[idx];
  if (!entry) return null;
  const [p, s] = entry.split(':');
  return { puzzle: Array.from(p, Number), solution: Array.from(s, Number) };
}

function suKey(level, idx) {
  return level + '_' + idx;
}

function suDocId(name, key) {
  return encodeURIComponent(name.toLowerCase()) + '__' + key;
}

function suFormatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function suPop(mask) {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n += 1;
  return n;
}

// Welche Zahlen passen laut Zeile, Spalte und Block noch in das leere Feld i? (Bits 1 bis 9)
function suCandidates(grid, i) {
  let mask = 0x3FE;
  for (const p of SU_PEERS[i]) if (grid[p]) mask &= ~(1 << grid[p]);
  return mask;
}

// Felder, in denen eine falsche Zahl steht
function suErrors(grid, solution) {
  const bad = [];
  grid.forEach((v, i) => { if (v !== 0 && v !== solution[i]) bad.push(i); });
  return bad;
}

function suEmptyCount(grid) {
  return grid.filter((v) => v === 0).length;
}

// Tipp: erst ein Feld, in dem nur noch eine Zahl passt, dann eine "versteckte Einzelzahl" in Zeile/Spalte/Block,
// sonst wird ein Feld verraten. Enthält das Gitter einen Fehler, gibt es keinen Tipp.
function suHint(grid, solution) {
  if (suErrors(grid, solution).length) return { type: 'error' };
  for (let i = 0; i < 81; i++) {
    if (grid[i] === 0) {
      const m = suCandidates(grid, i);
      if (suPop(m) === 1) return { type: 'naked', cell: i, value: Math.log2(m) };
    }
  }
  for (let u = 0; u < 27; u++) {
    const unit = SU_UNITS[u];
    for (let d = 1; d <= 9; d++) {
      if (unit.some((i) => grid[i] === d)) continue;
      const cells = unit.filter((i) => grid[i] === 0 && (suCandidates(grid, i) & (1 << d)));
      if (cells.length === 1) return { type: 'hidden', cell: cells[0], value: d, unit: SU_UNIT_KIND[Math.floor(u / 9)] };
    }
  }
  const first = grid.indexOf(0);
  return first < 0 ? { type: 'none' } : { type: 'reveal', cell: first, value: solution[first] };
}

// Eine Aufgabe ist gelöst: speichert Zeit, zählt sie als gelöst und merkt sich die Bestzeit pro Stufe.
// Nur Läufe ohne Tipp zählen für die Bestzeit; das Lösen zählt nur beim ersten Mal; erneutes Lösen kann die Bestzeit verbessern.
function sudokuFinish(level, idx, seconds, hints) {
  return gameTry(async () => {
    if (!SU_PUZZLES[level] || !SU_PUZZLES[level][idx]) throw new Error('Unbekannte Aufgabe.');
    const me = currentUser.name;
    const pRef = db.collection('sudokuProgress').doc(suDocId(me, suKey(level, idx)));
    const sRef = db.collection('sudokuStats').doc(me.toLowerCase());
    await db.runTransaction(async (tx) => {
      const p = await tx.get(pRef);
      const st = await tx.get(sRef);
      const pd = p.exists ? p.data() : {};
      if (pd.done) return;
      const lv = { best: 0, bestIdx: -1, solved: 0, ...((st.exists && st.data().levels && st.data().levels[level]) || {}) };
      if (!pd.solvedOnce) lv.solved += 1;
      if (hints === 0 && (!lv.best || seconds < lv.best)) { lv.best = seconds; lv.bestIdx = idx; }
      const ts = FieldValue.serverTimestamp();
      tx.set(pRef, { user: me, level, idx, done: true, solvedOnce: true, finishedSeconds: seconds, seconds, hints, updatedAt: ts }, { merge: true });
      tx.set(sRef, { name: me, levels: { [level]: lv } }, { merge: true });
    });
  });
}

// Stand einer Aufgabe speichern (Eingaben, Notizen, Zeit); ohne Rückfrage, im Hintergrund
function sudokuSaveProgress(level, idx, data) {
  const me = currentUser.name;
  return db.collection('sudokuProgress').doc(suDocId(me, suKey(level, idx)))
    .set({ user: me, level, idx, ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

// ----- Datenbank-Aktionen (alles in Transaktionen, damit nichts durcheinanderkommt) -----
async function gameTry(fn, okMessage) {
  if (gameBusy) return false;
  gameBusy = true;
  try {
    await fn();
    if (okMessage) toast(okMessage);
    return true;
  } catch (err) {
    console.error(err);
    toast(err && err.message ? err.message : 'Das hat nicht geklappt.');
    return false;
  } finally {
    gameBusy = false;
  }
}

// Beendet eine Partie und schreibt Sieg/Remis in die Statistik des jeweiligen Spiels.
function gameApplyResult(tx, gameRef, game, baseUpdate, winnerNum, extra) {
  const ts = FieldValue.serverTimestamp();
  tx.update(gameRef, {
    ...baseUpdate, ...(extra || {}), status: 'finished', winner: winnerNum, finishedAt: ts, updatedAt: ts
  });
  const type = gameTypeOf(game);
  const statsRef = db.collection('gameStats').doc(type);
  const label = (GAME_TYPES[type] || GAME_TYPES.connect4).label;
  if (winnerNum === 0) {
    tx.set(statsRef, { draws: { [gamePairKey(game.players[0], game.players[1])]: FieldValue.increment(1) } }, { merge: true });
  } else {
    const winner = game.players[winnerNum - 1];
    const loser = game.players[winnerNum === 1 ? 1 : 0];
    tx.set(statsRef, {
      wins: { [winner.toLowerCase() + '|' + loser.toLowerCase()]: FieldValue.increment(1) },
      lastWin: { winner, loser, game: label, at: ts }
    }, { merge: true });
  }
  // Turnierpartie: Ergebnis für die Turnier-Tabelle festhalten (Sieg in der Statistik zählt trotzdem normal)
  if (game.tournamentId) {
    tx.set(db.collection('tournaments').doc(game.tournamentId), {
      results: { [game.fixtureKey]: { winner: winnerNum, p1: game.players[0], p2: game.players[1] } }
    }, { merge: true });
  }
}

function gameInitialFields(type) {
  if (type === 'chess') {
    const st = chNewState();
    return {
      board: st.board, turn: 1, castling: st.castling, ep: -1, posHistory: [chPositionKey(st)],
      moves: 0, lastFrom: -1, lastTo: -1, winner: 0, reason: '', drawOffer: 0
    };
  }
  if (type === 'tictactoe') {
    return { board: new Array(9).fill(0), turn: 1, winner: 0, winCells: [], moves: 0, lastMove: -1 };
  }
  if (type === 'ships') {
    return {
      turn: 1, winner: 0, moves: 0, phase: 'placing', ready1: false, ready2: false,
      grid1: shNewGrid(), grid2: shNewGrid(), shot1: shNewGrid(), shot2: shNewGrid(),
      lastShot: -1, lastShotBy: 0, lastResult: '', lastSunk: 0, reason: ''
    };
  }
  if (type === 'othello') {
    return { board: otNewBoard(), turn: 1, winner: 0, moves: 0, lastMove: -1, flipped: [], lastPass: 0, reason: '' };
  }
  if (type === 'kniffel') {
    return {
      turn: 1, winner: 0, moves: 0, turnsDone: 0, dice: [0, 0, 0, 0, 0], rollsLeft: 3, lastRolled: [false, false, false, false, false],
      card1: {}, card2: {}, extra1: 0, extra2: 0, lastBox: '', lastBoxPlayer: 0, lastPoints: 0, lastBonus: 0, reason: ''
    };
  }
  return { board: c4NewBoard(), turn: 1, winner: 0, winCells: [], moves: 0, lastMove: -1 };
}

function gameChallenge(type, opponentName) {
  const me = currentUser.name;
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameDocId(type, me, opponentName));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const g = snap.data();
        if (g.status === 'invited' || g.status === 'active') throw new Error('Zwischen euch läuft schon eine Partie.');
      }
      const ts = FieldValue.serverTimestamp();
      tx.set(ref, {
        type, players: [me, opponentName], pairKey: gamePairKey(me, opponentName), status: 'invited',
        ...gameInitialFields(type), createdAt: ts, updatedAt: ts
      });
    });
  }, `Herausforderung an ${opponentName} gesendet.`);
}

function gameAccept(gameId) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Einladung gibt es nicht mehr.');
      const g = snap.data();
      if (g.status !== 'invited') throw new Error('Die Einladung ist nicht mehr offen.');
      if (g.players[1].toLowerCase() !== currentUser.name.toLowerCase()) throw new Error('Diese Einladung gilt nicht für dich.');
      tx.update(ref, { status: 'active', startedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    });
  }, 'Partie gestartet!');
}

// Ablehnen (Eingeladener) bzw. Zurückziehen (Herausforderer) – die Einladung wird gelöscht.
function gameCancelInvite(gameId) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();
      if (g.status !== 'invited') throw new Error('Die Einladung wurde schon beantwortet.');
      if (gamePlayerIndex(g, currentUser.name) < 0) throw new Error('Das ist nicht deine Partie.');
      tx.delete(ref);
    });
  });
}

async function gameResign(gameId) {
  const ok = await confirmModal('Aufgeben?', 'Die Partie ist dann verloren und zählt als Sieg für deinen Gegner.', 'Aufgeben');
  if (!ok) return false;
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      gameApplyResult(tx, ref, g, {}, myIdx === 0 ? 2 : 1, { reason: 'resign' });
    });
  });
}

async function gameRemoveFinished(gameId) {
  const ok = await confirmModal('Partie entfernen?', 'Die Partie verschwindet aus deiner Liste. Die Siege bleiben in der Tabelle erhalten.', 'Entfernen');
  if (!ok) return false;
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if (snap.data().status !== 'finished') throw new Error('Nur beendete Partien lassen sich entfernen.');
      tx.delete(ref);
    });
  });
}

function c4PlayMove(gameId, col) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'connect4') throw new Error('Das ist keine 4-Gewinnt-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g.turn !== myNum) throw new Error('Du bist nicht dran.');
      if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) throw new Error('Ungültige Spalte.');
      const board = g.board.slice();
      const row = c4DropRow(board, col);
      if (row < 0) throw new Error('Diese Spalte ist voll.');
      const idx = row * C4_COLS + col;
      board[idx] = myNum;
      const base = { board, lastMove: idx, moves: (g.moves || 0) + 1 };
      const winCells = c4CheckWin(board, idx, myNum);
      if (winCells) gameApplyResult(tx, ref, g, base, myNum, { winCells });
      else if (c4IsFull(board)) gameApplyResult(tx, ref, g, base, 0, { winCells: [] });
      else tx.update(ref, { ...base, turn: myNum === 1 ? 2 : 1, updatedAt: FieldValue.serverTimestamp() });
    });
  });
}

function tttPlayMove(gameId, idx) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'tictactoe') throw new Error('Das ist keine Tic-Tac-Toe-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g.turn !== myNum) throw new Error('Du bist nicht dran.');
      if (!Number.isInteger(idx) || idx < 0 || idx > 8) throw new Error('Ungültiges Feld.');
      if (g.board[idx] !== 0) throw new Error('Dieses Feld ist schon belegt.');
      const board = g.board.slice();
      board[idx] = myNum;
      const base = { board, lastMove: idx, moves: (g.moves || 0) + 1 };
      const winCells = tttCheckWin(board, myNum);
      if (winCells) gameApplyResult(tx, ref, g, base, myNum, { winCells });
      else if (tttIsFull(board)) gameApplyResult(tx, ref, g, base, 0, { winCells: [] });
      else tx.update(ref, { ...base, turn: myNum === 1 ? 2 : 1, updatedAt: FieldValue.serverTimestamp() });
    });
  });
}

// Würfeln: Der Wurf wird in der Datenbank gespeichert (nicht im Browser), damit Neuladen keinen neuen Wurf bringt.
function kniffelRoll(gameId, held) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'kniffel') throw new Error('Das ist keine Kniffel-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      if (g.turn !== myIdx + 1) throw new Error('Du bist nicht dran.');
      const rollsLeft = typeof g.rollsLeft === 'number' ? g.rollsLeft : 3;
      if (rollsLeft <= 0) throw new Error('Du hast schon dreimal gewürfelt – trage jetzt Punkte ein.');
      const first = rollsLeft === 3;
      const keep = (!first && Array.isArray(held) && held.length === 5) ? held.map(Boolean) : [false, false, false, false, false];
      if (keep.every(Boolean)) throw new Error('Lass mindestens einen Würfel zum Neuwürfeln frei.');
      const dice = (g.dice || [0, 0, 0, 0, 0]).slice();
      const rolled = keep.map((k) => !k);
      for (let i = 0; i < 5; i++) if (rolled[i]) dice[i] = kniffelDie();
      tx.update(ref, {
        dice, rollsLeft: rollsLeft - 1, lastRolled: rolled, moves: (g.moves || 0) + 1, updatedAt: FieldValue.serverTimestamp()
      });
    });
  });
}

// Punkte in ein Feld eintragen: Der Wert wird aus den gespeicherten Würfeln berechnet,
// geprüft werden Zugrecht und freies Feld. Nach dem 26. Eintrag ist die Partie zu Ende.
function kniffelScore(gameId, box) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'kniffel') throw new Error('Das ist keine Kniffel-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g.turn !== myNum) throw new Error('Du bist nicht dran.');
      const dice = g.dice || [0, 0, 0, 0, 0];
      if (!dice.every((d) => d >= 1 && d <= 6)) throw new Error('Würfle zuerst.');
      if (!KN_BOXES.includes(box)) throw new Error('Unbekanntes Feld.');
      const cardKey = 'card' + myNum;
      const extraKey = 'extra' + myNum;
      const card = { ...(g[cardKey] || {}) };
      if (card[box] !== undefined) throw new Error('Dieses Feld ist schon belegt.');
      const points = knScoreBox(dice, box);
      const bonus = knExtraBonusFor(dice, card);
      card[box] = points;
      const extra = (g[extraKey] || 0) + bonus;
      const done = (g.turnsDone || 0) + 1;
      const base = {
        [cardKey]: card, [extraKey]: extra, turnsDone: done, moves: (g.moves || 0) + 1,
        lastBox: box, lastBoxPlayer: myNum, lastPoints: points, lastBonus: bonus
      };
      if (done >= KN_TURNS) {
        const cards = [myNum === 1 ? card : (g.card1 || {}), myNum === 2 ? card : (g.card2 || {})];
        const extras = [myNum === 1 ? extra : (g.extra1 || 0), myNum === 2 ? extra : (g.extra2 || 0)];
        const t1 = knTotal(cards[0], extras[0]);
        const t2 = knTotal(cards[1], extras[1]);
        gameApplyResult(tx, ref, g, { ...base, rollsLeft: 0 }, t1 > t2 ? 1 : (t2 > t1 ? 2 : 0), { reason: 'finished', total1: t1, total2: t2 });
      } else {
        tx.update(ref, {
          ...base, turn: myNum === 1 ? 2 : 1, dice: [0, 0, 0, 0, 0], rollsLeft: 3,
          lastRolled: [false, false, false, false, false], updatedAt: FieldValue.serverTimestamp()
        });
      }
    });
  });
}

// Othello-Zug. Das Passen übernimmt die App automatisch: Hat der Gegner nach dem Zug keinen erlaubten Zug,
// ist der Ziehende nochmal dran; kann keiner mehr ziehen (oder ist das Brett voll), ist die Partie zu Ende.
function otelloPlayMove(gameId, idx) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'othello') throw new Error('Das ist keine Othello-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g.turn !== myNum) throw new Error('Du bist nicht dran.');
      if (!Number.isInteger(idx) || idx < 0 || idx > 63) throw new Error('Ungültiges Feld.');
      if (g.board[idx] !== 0) throw new Error('Dieses Feld ist schon belegt.');
      const { board, flips } = otApply(g.board, idx, myNum);
      if (!flips.length) throw new Error('Hier darfst du nicht setzen – du musst mindestens einen gegnerischen Stein einklammern.');
      const opp = myNum === 1 ? 2 : 1;
      const base = { board, lastMove: idx, flipped: flips, moves: (g.moves || 0) + 1 };
      if (otHasMove(board, opp)) {
        tx.update(ref, { ...base, turn: opp, lastPass: 0, updatedAt: FieldValue.serverTimestamp() });
      } else if (otHasMove(board, myNum)) {
        tx.update(ref, { ...base, turn: myNum, lastPass: opp, updatedAt: FieldValue.serverTimestamp() });
      } else {
        const counts = otCount(board);
        const winner = counts[1] > counts[2] ? 1 : (counts[2] > counts[1] ? 2 : 0);
        gameApplyResult(tx, ref, g, { ...base, lastPass: 0 }, winner, { reason: 'finished', count1: counts[1], count2: counts[2] });
      }
    });
  });
}

// ----- Turniere: Aktionen in der Datenbank -----

// Turnier anlegen (nur Admin). Die Partien werden erst am Starttag automatisch angelegt.
async function tournamentCreate({ game, startDate, days, prize, participants }) {
  if (!GAME_TYPES[game]) throw new Error('Bitte ein Spiel wählen.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) throw new Error('Bitte ein Startdatum wählen.');
  if (![1, 2, 3].includes(days)) throw new Error('Der Zeitraum beträgt 1, 2 oder 3 Tage.');
  if (!Number.isInteger(prize) || prize < 1 || prize > 10) throw new Error('Der Gewinn muss zwischen 1 und 10 Euro liegen.');
  const names = [...new Set(participants || [])];
  if (names.length < 2) throw new Error('Wähle mindestens 2 Teilnehmer.');
  const ref = db.collection('tournaments').doc();
  await ref.set({
    game, participants: names, startDate, days, endDate: tnEndDate(startDate, days), prize,
    seed: Math.floor(Math.random() * 4294967296), status: 'scheduled', results: {}, ranking: [], finalists: [],
    winner: '', endReason: '', prizeBooked: false, createdBy: currentUser.name, createdAt: FieldValue.serverTimestamp()
  });
  return ref.id;
}

// Erledigt den jeweils nächsten Schritt eines Turniers. Kann von jedem Teilnehmer/Admin ausgelöst werden;
// die Transaktion sorgt dafür, dass jeder Schritt (und die Gutschrift) nur ein einziges Mal passiert.
//  scheduled -> group : am Starttag alle Partien (jeder gegen jeden) anlegen
//  group -> final     : sind alle Partien gespielt, spielen Platz 1 und 2 das Finale (Platz 1 beginnt)
//  final -> finished  : Sieger des Finales (bei Remis der Tabellenerste), Gewinn aufs Konto buchen
//  Ende des Zeitraums : offene Partien werden gestrichen (0 Punkte, keine Statistik), kein Finale mehr,
//                       der Tabellenerste gewinnt; wurde keine Partie gewertet, gibt es keinen Sieger.
async function tournamentAdvance(tid) {
  const tRef = db.collection('tournaments').doc(tid);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(tRef);
      if (!snap.exists) return;
      const t = snap.data();
      const today = tnToday();
      if (!GAME_TYPES[t.game] || !tnNeedsAdvance(t, today)) return;
      const ts = FieldValue.serverTimestamp();
      const fixtures = tnFixtures(t.participants);
      const results = { ...(t.results || {}) };
      const expired = today > t.endDate;

      // Lesen (muss vor allem Schreiben passieren): Statistik des Spiels für die Gleichstand-Regel
      let wins = {};
      if (t.status === 'group') {
        const st = await tx.get(db.collection('gameStats').doc(t.game));
        wins = st.exists ? (st.data().wins || {}) : {};
      }

      const finish = (winner, reason, extra) => {
        tx.update(tRef, {
          status: 'finished', winner: winner || '', endReason: reason, finishedAt: ts, prizeBooked: !!winner, ...(extra || {})
        });
        if (winner) {
          const accRef = db.collection('accounts').doc(winner);
          tx.set(accRef, { balance: FieldValue.increment(t.prize) }, { merge: true });
          tx.set(accRef.collection('transactions').doc(), { amount: t.prize, reason: tnPrizeReason(t), auto: true, createdAt: ts });
        }
      };

      if (t.status === 'scheduled') {
        if (expired) { finish('', 'noGames'); return; }
        fixtures.forEach((f) => tx.set(db.collection('games').doc(tnGameId(tid, f.key)), tnGameDoc(t, tid, f.key, f.players, 'group', ts)));
        tx.update(tRef, { status: 'group', startedAt: ts });
        return;
      }

      if (t.status === 'group') {
        if (expired) {
          fixtures.filter((f) => !results[f.key]).forEach((f) => {
            tx.delete(db.collection('games').doc(tnGameId(tid, f.key)));
            results[f.key] = { winner: -1, p1: f.players[0], p2: f.players[1] };
          });
          const merged = { ...t, results };
          const ranking = tnRanking(merged, wins);
          const winner = tnHasCountedResults(merged) ? ranking[0] : '';
          finish(winner, winner ? 'deadline' : 'noGames', { results, ranking });
          return;
        }
        const ranking = tnRanking(t, wins);
        const finalists = [ranking[0], ranking[1]];
        tx.set(db.collection('games').doc(tnGameId(tid, 'final')), tnGameDoc(t, tid, 'final', finalists, 'final', ts));
        tx.update(tRef, { status: 'final', ranking, finalists });
        return;
      }

      if (t.status === 'final') {
        const ranking = t.ranking || [];
        const fin = results.final;
        if (fin && (fin.winner === 1 || fin.winner === 2)) {
          finish((t.finalists || [])[fin.winner - 1], 'final');
        } else if (fin && fin.winner === 0) {
          finish(ranking[0], 'finalDraw');
        } else {
          tx.delete(db.collection('games').doc(tnGameId(tid, 'final')));
          results.final = { winner: -1, p1: (t.finalists || [])[0], p2: (t.finalists || [])[1] };
          finish(ranking[0], 'deadline', { results });
        }
      }
    });
  } catch (err) {
    console.error('Turnier-Auswertung fehlgeschlagen', err);
  }
}

async function tournamentsAdvanceAll() {
  if (tnAdvanceBusy) return;
  tnAdvanceBusy = true;
  try {
    const today = tnToday();
    for (const t of tournamentsRaw) {
      if (tnNeedsAdvance(t, today)) await tournamentAdvance(t.id);
    }
  } finally {
    tnAdvanceBusy = false;
  }
}

// Turnier samt allen zugehörigen Partien löschen (eine schon gebuchte Gutschrift bleibt bestehen).
async function tournamentDelete(tid) {
  const gamesSnap = await db.collection('games').where('tournamentId', '==', tid).get();
  const batch = db.batch();
  gamesSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection('tournaments').doc(tid));
  await batch.commit();
}

// Flotte abgeben (jeder Spieler für sich, zeitversetzt möglich). Sind beide fertig, beginnt der Kampf (Spieler 1 schießt zuerst).
function shipsPlace(gameId, grid) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'ships') throw new Error('Das ist keine Schiffe-versenken-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      if (g.phase !== 'placing') throw new Error('Die Flotten sind schon platziert.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g['ready' + myNum]) throw new Error('Du hast deine Flotte schon platziert.');
      const problem = shValidateGrid(grid);
      if (problem) throw new Error(problem);
      const otherReady = !!g['ready' + (myNum === 1 ? 2 : 1)];
      const update = { ['grid' + myNum]: grid, ['ready' + myNum]: true, moves: (g.moves || 0) + 1, updatedAt: FieldValue.serverTimestamp() };
      if (otherReady) { update.phase = 'battle'; update.turn = 1; }
      tx.update(ref, update);
    });
  }, 'Flotte steht.');
}

// Schuss auf ein Feld des Gegners. Nach einem Treffer (auch wenn das Schiff versenkt wurde) darf man nochmal schießen,
// nach Wasser ist der andere dran. Wer das letzte Schiff versenkt, gewinnt.
function shipsShoot(gameId, idx) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'ships') throw new Error('Das ist keine Schiffe-versenken-Partie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      if (g.phase !== 'battle') throw new Error('Es geht erst los, wenn beide ihre Flotte platziert haben.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g.turn !== myNum) throw new Error('Du bist nicht dran.');
      if (!Number.isInteger(idx) || idx < 0 || idx > 99) throw new Error('Ungültiges Feld.');
      const oppNum = myNum === 1 ? 2 : 1;
      const shot = g['shot' + oppNum] || shNewGrid();
      if (shot[idx]) throw new Error('Auf dieses Feld hast du schon geschossen.');
      const r = shApplyShot(g['grid' + oppNum], shot, idx);
      const base = {
        ['shot' + oppNum]: r.shot, lastShot: idx, lastShotBy: myNum, lastResult: r.result, lastSunk: r.sunkSize, moves: (g.moves || 0) + 1
      };
      if (r.allSunk) gameApplyResult(tx, ref, g, base, myNum, { reason: 'finished' });
      else tx.update(ref, { ...base, turn: r.result === 'miss' ? oppNum : myNum, updatedAt: FieldValue.serverTimestamp() });
    });
  });
}

// ----- Blokus (Mehrspieler-Rahmen): Einladen, Starten, Ziehen, Aufgeben -----
// Mehrspieler-Runden liegen in der Sammlung "groupGames" (getrennt von den Duell-Partien in "games").

function blStartFields(players) {
  const size = blSize(players.length);
  return {
    status: 'active', players, size, board: new Array(size * size).fill(0), turn: 1,
    used1: [], used2: [], used3: [], used4: [], outSlots: [], resigned: [],
    lastSlot: 0, lastPiece: '', lastCells: [], moves: 0, scores: [], winners: [], winner: '', reason: ''
  };
}

function blUsedList(g, override) {
  return g.players.map((_, i) => (override && override.slot === i + 1 ? override.used : (g['used' + (i + 1)] || [])));
}

// Eine Runde eröffnen: 1 bis 3 Mitspieler einladen (der Eröffner ist automatisch dabei und zugesagt)
function blokusCreate(invitees) {
  return gameTry(async () => {
    const me = currentUser.name;
    const names = [...new Set(invitees || [])].filter((n) => n.toLowerCase() !== me.toLowerCase());
    if (names.length < 1 || names.length > 3) throw new Error('Wähle 1 bis 3 Mitspieler.');
    const ref = db.collection('groupGames').doc();
    const ts = FieldValue.serverTimestamp();
    await ref.set({
      type: 'blokus', host: me, participants: [me, ...names], accepted: [me], declined: [], hiddenBy: [], status: 'invited',
      players: [], size: 0, board: [], turn: 1, moves: 0, scores: [], winners: [], winner: '', reason: '', createdAt: ts, updatedAt: ts
    });
  }, 'Einladung verschickt.');
}

// Zusagen oder Absagen. Haben alle zugesagt, geht es sofort los; sagen alle ab, verfällt die Runde;
// sagen einige ab, entscheidet der Eröffner (blokusStart).
function blokusRespond(gameId, accept) {
  return gameTry(async () => {
    const ref = db.collection('groupGames').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Einladung gibt es nicht mehr.');
      const g = snap.data();
      const me = currentUser.name;
      if (g.type !== 'blokus') throw new Error('Das ist keine Blokus-Runde.');
      if (g.status !== 'invited') throw new Error('Die Einladung ist nicht mehr offen.');
      if (!g.participants.includes(me) || g.host === me) throw new Error('Diese Einladung gilt nicht für dich.');
      if (g.accepted.includes(me) || g.declined.includes(me)) throw new Error('Du hast schon geantwortet.');
      const accepted = accept ? [...g.accepted, me] : g.accepted;
      const declined = accept ? g.declined : [...g.declined, me];
      const pending = g.participants.filter((n) => !accepted.includes(n) && !declined.includes(n));
      const ts = FieldValue.serverTimestamp();
      if (pending.length === 0 && accepted.length === 1) { tx.delete(ref); return; }
      if (pending.length === 0 && declined.length === 0) {
        tx.update(ref, { accepted, declined, ...blStartFields(g.participants.filter((n) => accepted.includes(n))), startedAt: ts, updatedAt: ts });
        return;
      }
      tx.update(ref, { accepted, declined, updatedAt: ts });
    });
  }, accept ? 'Zugesagt.' : null);
}

// Der Eröffner startet mit den Zugesagten (mindestens ein Mitspieler). Wer noch nicht geantwortet hat, ist dann nicht dabei.
function blokusStart(gameId) {
  return gameTry(async () => {
    const ref = db.collection('groupGames').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Runde gibt es nicht mehr.');
      const g = snap.data();
      if (g.status !== 'invited') throw new Error('Die Runde ist schon gestartet.');
      if (g.host !== currentUser.name) throw new Error('Nur wer die Runde eröffnet hat, kann sie starten.');
      if (g.accepted.length < 2) throw new Error('Es hat noch niemand zugesagt.');
      const players = g.participants.filter((n) => g.accepted.includes(n));
      const ts = FieldValue.serverTimestamp();
      tx.update(ref, { participants: players, ...blStartFields(players), startedAt: ts, updatedAt: ts });
    });
  }, 'Die Runde beginnt.');
}

function blokusCancel(gameId) {
  return gameTry(async () => {
    const ref = db.collection('groupGames').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();
      if (g.status !== 'invited') throw new Error('Die Runde ist schon gestartet.');
      if (g.host !== currentUser.name) throw new Error('Nur wer die Runde eröffnet hat, kann sie abbrechen.');
      tx.delete(ref);
    });
  });
}

// Beendet die Runde: Punkte, Sieger und Statistik (Partien und Siege pro Person; bei Gleichstand zählt ein Unentschieden)
function groupApplyResult(tx, ref, g, base, result, reason) {
  const ts = FieldValue.serverTimestamp();
  const winners = result.winners.map((s) => g.players[s - 1]);
  tx.update(ref, {
    ...base, status: 'finished', scores: result.scores, winners, winner: winners.length === 1 ? winners[0] : '',
    turn: 0, reason, finishedAt: ts, updatedAt: ts
  });
  const statsRef = db.collection('gameStats').doc(g.type);
  const played = Object.fromEntries(g.players.map((n) => [n.toLowerCase(), FieldValue.increment(1)]));
  if (winners.length === 1) {
    const others = g.players.filter((n) => n !== winners[0]);
    tx.set(statsRef, {
      played, wins: { [winners[0].toLowerCase()]: FieldValue.increment(1) },
      lastWin: { winner: winners[0], loser: others.join(', '), losers: others, game: GAME_TYPES[g.type].label, at: ts }
    }, { merge: true });
  } else {
    tx.set(statsRef, { played, draws: Object.fromEntries(winners.map((n) => [n.toLowerCase(), FieldValue.increment(1)])) }, { merge: true });
  }
}

// Ein Stück legen: piece = Name (z.B. "F5"), cells = die belegten Feldnummern auf dem Brett
function blokusPlay(gameId, piece, cells) {
  return gameTry(async () => {
    const ref = db.collection('groupGames').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Runde gibt es nicht mehr.');
      const g = snap.data();
      if (g.type !== 'blokus') throw new Error('Das ist keine Blokus-Runde.');
      if (g.status !== 'active') throw new Error('Die Runde läuft nicht mehr.');
      const slot = gamePlayerIndex(g, currentUser.name) + 1;
      if (slot < 1) throw new Error('Du spielst in dieser Runde nicht mit.');
      if (g.turn !== slot) throw new Error('Du bist nicht dran.');
      if (!BL_PIECES[piece]) throw new Error('Unbekanntes Stück.');
      const used = g['used' + slot] || [];
      if (used.includes(piece)) throw new Error('Dieses Stück hast du schon gelegt.');
      const total = g.size * g.size;
      if (!Array.isArray(cells) || cells.length !== BL_PIECES[piece].length || new Set(cells).size !== cells.length
        || !cells.every((c) => Number.isInteger(c) && c >= 0 && c < total)) throw new Error('Ungültiger Zug.');
      if (!blShapeMatches(piece, cells, g.size)) throw new Error('Die Form passt nicht zum gewählten Stück.');
      const problem = blCheckMove(g.board, g.size, slot, cells, used.length === 0);
      if (problem) throw new Error(problem);

      const board = g.board.slice();
      cells.forEach((c) => { board[c] = slot; });
      const newUsed = [...used, piece];
      const base = {
        board, ['used' + slot]: newUsed, lastSlot: slot, lastPiece: piece,
        lastCells: cells.slice().sort((a, b) => a - b), moves: (g.moves || 0) + 1
      };
      const usedList = blUsedList(g, { slot, used: newUsed });
      const adv = blAdvance(g.size, board, usedList, g.outSlots || [], g.resigned || [], slot);
      if (adv.turn === 0) {
        groupApplyResult(tx, ref, g, { ...base, outSlots: adv.outSlots }, blResult(usedList, g.resigned || []), 'finished');
      } else {
        tx.update(ref, { ...base, turn: adv.turn, outSlots: adv.outSlots, updatedAt: FieldValue.serverTimestamp() });
      }
    });
  });
}

// Aufgeben: Wer aufgibt, kann nicht mehr gewinnen. Bleibt nur noch einer übrig, hat er gewonnen,
// sonst wird ohne den Aufgebenden weitergespielt.
async function blokusResign(gameId) {
  const ok = await confirmModal('Aufgeben?', 'Du kannst dann nicht mehr gewinnen. Die anderen spielen weiter.', 'Aufgeben');
  if (!ok) return false;
  return gameTry(async () => {
    const ref = db.collection('groupGames').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Runde gibt es nicht mehr.');
      const g = snap.data();
      if (g.status !== 'active') throw new Error('Die Runde läuft nicht mehr.');
      const slot = gamePlayerIndex(g, currentUser.name) + 1;
      if (slot < 1) throw new Error('Du spielst in dieser Runde nicht mit.');
      if ((g.resigned || []).includes(slot)) throw new Error('Du hast schon aufgegeben.');
      const resigned = [...(g.resigned || []), slot];
      const usedList = blUsedList(g);
      const contenders = g.players.map((_, i) => i + 1).filter((s) => !resigned.includes(s));
      if (contenders.length <= 1) {
        groupApplyResult(tx, ref, g, { resigned }, { scores: usedList.map(blScore), winners: contenders }, 'resign');
        return;
      }
      let turn = g.turn;
      let outSlots = g.outSlots || [];
      if (g.turn === slot) {
        const adv = blAdvance(g.size, g.board, usedList, outSlots, resigned, slot);
        turn = adv.turn;
        outSlots = adv.outSlots;
      }
      if (turn === 0) groupApplyResult(tx, ref, g, { resigned, outSlots }, blResult(usedList, resigned), 'finished');
      else tx.update(ref, { resigned, outSlots, turn, updatedAt: FieldValue.serverTimestamp() });
    });
  });
}

// Eine beendete Runde aus der eigenen Liste ausblenden (für die anderen bleibt sie sichtbar)
function blokusHide(gameId) {
  return gameTry(async () => {
    const ref = db.collection('groupGames').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();
      if (g.status !== 'finished') throw new Error('Nur beendete Runden lassen sich ausblenden.');
      const hidden = g.hiddenBy || [];
      if (!hidden.includes(currentUser.name)) tx.update(ref, { hiddenBy: [...hidden, currentUser.name] });
    });
  });
}

function chessPlayMove(gameId, from, to, promo) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'chess') throw new Error('Das ist keine Schachpartie.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      const myNum = myIdx + 1;
      if (g.turn !== myNum) throw new Error('Du bist nicht dran.');
      const state = { board: g.board, turn: g.turn, castling: g.castling || '', ep: Number.isInteger(g.ep) ? g.ep : -1 };
      const candidates = chLegalMoves(state).filter((m) => m.from === from && m.to === to);
      if (!candidates.length) throw new Error('Dieser Zug ist nicht erlaubt.');
      const wanted = (promo || 'q').toLowerCase();
      const move = candidates.find((m) => !m.promo) || candidates.find((m) => m.promo === wanted);
      if (!move) throw new Error('Ungültige Umwandlung.');
      const next = chApply(state, move);
      const history = [...(g.posHistory || []), chPositionKey(next)];
      const base = {
        board: next.board, castling: next.castling, ep: next.ep, posHistory: history,
        moves: (g.moves || 0) + 1, lastFrom: from, lastTo: to, drawOffer: 0
      };
      const verdict = chEvaluate(next, history);
      if (verdict.mate) gameApplyResult(tx, ref, g, base, myNum, { reason: 'checkmate' });
      else if (verdict.draw) gameApplyResult(tx, ref, g, base, 0, { reason: verdict.reason });
      else tx.update(ref, { ...base, turn: myNum === 1 ? 2 : 1, updatedAt: FieldValue.serverTimestamp() });
    });
  });
}

// ----- Remis-Angebot (nur Schach) -----
function chessOfferDraw(gameId) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (gameTypeOf(g) !== 'chess') throw new Error('Remis gibt es nur beim Schach.');
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      if (g.drawOffer) throw new Error('Es gibt schon ein Remis-Angebot.');
      tx.update(ref, { drawOffer: myIdx + 1, updatedAt: FieldValue.serverTimestamp() });
    });
  }, 'Remis angeboten.');
}

function chessAnswerDraw(gameId, accept) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      if (g.status !== 'active') throw new Error('Die Partie läuft nicht mehr.');
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (myIdx < 0) throw new Error('Du spielst in dieser Partie nicht mit.');
      if (!g.drawOffer) throw new Error('Es gibt kein Remis-Angebot mehr.');
      if (g.drawOffer === myIdx + 1) throw new Error('Das ist dein eigenes Angebot.');
      if (accept) gameApplyResult(tx, ref, g, { drawOffer: 0 }, 0, { reason: 'agreement' });
      else tx.update(ref, { drawOffer: 0, updatedAt: FieldValue.serverTimestamp() });
    });
  }, accept ? 'Remis vereinbart.' : null);
}

function chessWithdrawDraw(gameId) {
  return gameTry(async () => {
    const ref = db.collection('games').doc(gameId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Die Partie gibt es nicht mehr.');
      const g = snap.data();
      const myIdx = gamePlayerIndex(g, currentUser.name);
      if (g.status !== 'active' || myIdx < 0 || g.drawOffer !== myIdx + 1) throw new Error('Es gibt kein eigenes Angebot zum Zurückziehen.');
      tx.update(ref, { drawOffer: 0, updatedAt: FieldValue.serverTimestamp() });
    });
  });
}

// <GAMES-LOGIC-END>

// Alte beendete Partien (> 7 Tage) und unbeantwortete Einladungen (> 14 Tage) aufräumen.
function gameCleanup(games) {
  const now = Date.now();
  games.forEach((g) => {
    const ts = g.status === 'finished' ? g.finishedAt : g.createdAt;
    const ms = ts && ts.toMillis ? ts.toMillis() : null;
    if (!ms) return;
    const ageDays = (now - ms) / 86400000;
    if ((g.status === 'finished' && ageDays > GAME_FINISHED_KEEP_DAYS) || (g.status === 'invited' && ageDays > GAME_STALE_INVITE_DAYS)) {
      db.collection('games').doc(g.id).delete().catch(() => {});
    }
  });
}

// ----- Abonnements -----
function subscribeGames() {
  return db.collection('games').where('players', 'array-contains', currentUser.name).onSnapshot((snap) => {
    gamesRaw = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
    if (gameOpenAfterAccept) {
      const g = gameOf(gameOpenAfterAccept);
      if (g && g.status === 'active') {
        const id = gameOpenAfterAccept;
        gameOpenAfterAccept = null;
        gameOpenBoard(id);
      }
    }
    renderGames();
    renderHomeGames();
    updateGamesBadge();
    gameCleanup(gamesRaw);
  });
}

function subscribeGameStats() {
  const unsubs = Object.keys(GAME_TYPES).filter((type) => !GAME_TYPES[type].solo).map((type) => db.collection('gameStats').doc(type).onSnapshot((doc) => {
    const d = doc.exists ? doc.data({ serverTimestamps: 'estimate' }) : {};
    gameStatsAll[type] = { wins: d.wins || {}, draws: d.draws || {}, played: d.played || {}, lastWin: d.lastWin || null };
    renderHomeLastWin();
    if (currentScreen === 'games') renderGames();
  }));
  return () => unsubs.forEach((u) => u());
}

// ----- Hilfsfunktionen für die Anzeige -----
function gameOf(id) {
  return gamesRaw.find((g) => g.id === id);
}

function gameLabel(g) {
  return (GAME_TYPES[gameTypeOf(g)] || GAME_TYPES.connect4).label;
}

function coloredNameHtml(name) {
  const u = usersMap[(name || '').toLowerCase()];
  const color = u ? userColor(u, 'color') : null;
  return `<span style="${color ? `color:${color};` : ''}font-weight:700;">${escapeHtml(name)}</span>`;
}

function canonicalUserName(lower) {
  const u = usersMap[lower];
  return u ? u.name : lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Einladungen an mich, Partien in denen ich am Zug bin und Remis-Angebote an mich (alle Spiele)
function gamesPendingInfo() {
  const me = currentUser.name.toLowerCase();
  const invites = gamesRaw.filter((g) => g.status === 'invited' && g.players[1].toLowerCase() === me);
  const myTurn = gamesRaw.filter((g) => g.status === 'active' && gameWaitingOn(g).includes(gamePlayerIndex(g, currentUser.name) + 1));
  const drawOffers = gamesRaw.filter((g) => g.status === 'active' && g.drawOffer
    && g.players[g.drawOffer === 1 ? 1 : 0].toLowerCase() === me);
  return { invites, myTurn, drawOffers };
}

// Anzahl Partien, bei denen etwas auf mich wartet.
// Ohne Angabe: alle (für den Punkt am "Start"-Knopf). Mit Spiel: nur die normalen Partien dieses Spiels –
// Turnierpartien erscheinen nur an der Turnierkarte, nicht an der Kachel des Spiels.
function gamesPendingCount(type) {
  const { invites, myTurn, drawOffers } = gamesPendingInfo();
  const ids = new Set([...invites, ...myTurn, ...drawOffers]
    .filter((g) => !type || (gameTypeOf(g) === type && !g.tournamentId)).map((g) => g.id));
  return ids.size;
}

function updateGamesBadge() {
  const badge = document.getElementById('nav-badge-games');
  if (!badge || !currentUser) return;
  badge.classList.toggle('show', (gamesPendingCount() > 0 || groupPendingCount() > 0) && currentScreen !== 'games');
}

// ----- Startseite: Karte "Spiele" und Karte "Letzter Sieg" -----
function renderHomeGames() {
  const el = document.getElementById('home-games-content');
  if (!el || !currentUser) return;
  const { invites, myTurn, drawOffers } = gamesPendingInfo();
  const lines = [];
  invites.forEach((g) => lines.push(`<div class="games-hint-line">⚔️ ${coloredNameHtml(g.players[0])} fordert dich zu ${escapeHtml(gameLabel(g))} heraus</div>`));
  myTurn.forEach((g) => {
    const opp = g.players[gamePlayerIndex(g, currentUser.name) === 0 ? 1 : 0];
    const suffix = `(${escapeHtml(gameLabel(g))}${g.tournamentId ? ' – Turnier' : ''})`;
    lines.push(gameTypeOf(g) === 'ships' && g.phase === 'placing'
      ? `<div class="games-hint-line">⚓ Platziere deine Flotte gegen ${coloredNameHtml(opp)} ${suffix}</div>`
      : `<div class="games-hint-line">🎯 Du bist dran gegen ${coloredNameHtml(opp)} ${suffix}</div>`);
  });
  drawOffers.forEach((g) => {
    const opp = g.players[gamePlayerIndex(g, currentUser.name) === 0 ? 1 : 0];
    lines.push(`<div class="games-hint-line">🤝 ${coloredNameHtml(opp)} bietet dir Remis an (${escapeHtml(gameLabel(g))})</div>`);
  });
  const gp = groupPendingInfo();
  gp.invites.forEach((g) => lines.push(`<div class="games-hint-line">⚔️ ${coloredNameHtml(g.host)} lädt dich zu ${escapeHtml(GAME_TYPES[g.type].label)} ein (${g.participants.length} Spieler)</div>`));
  gp.myTurn.forEach((g) => lines.push(`<div class="games-hint-line">🎯 Du bist dran bei ${escapeHtml(GAME_TYPES[g.type].label)} (mit ${joinNamesHtml(g.players.filter((n) => n !== currentUser.name))})</div>`));
  gp.hostReady.forEach((g) => lines.push(`<div class="games-hint-line">▶️ Alle haben geantwortet – starte deine ${escapeHtml(GAME_TYPES[g.type].label)}-Runde</div>`));
  myVisibleTournaments().filter((t) => t.status !== 'finished').forEach((t) => {
    const label = (GAME_TYPES[t.game] || { label: t.game }).label;
    lines.push(`<div class="games-hint-line">🏆 Turnier ${escapeHtml(label)}: ${escapeHtml(tnPrizeLabel(t))} zu gewinnen (bis ${escapeHtml(tnRangeLabel(t).split('–').pop().slice(0, 6))})</div>`);
  });
  el.innerHTML = lines.join('');
  const card = document.getElementById('home-card-spiele');
  if (card) card.style.display = lines.length ? '' : 'none';
}

// Der allerletzte Sieg über ALLE Spiele hinweg
function latestWinOverall() {
  let best = null;
  Object.entries(gameStatsAll).forEach(([type, st]) => {
    const lw = st.lastWin;
    if (!lw || !lw.at || !lw.at.toMillis || !lw.at.toDate) return;
    if (!best || lw.at.toMillis() > best.at.toMillis()) best = { ...lw, game: lw.game || GAME_TYPES[type].label };
  });
  return best;
}

function renderHomeLastWin() {
  const card = document.getElementById('home-card-letzterSieg');
  const el = document.getElementById('home-lastwin-content');
  if (!card || !el) return;
  const lw = latestWinOverall();
  if (!lw) { card.style.display = 'none'; return; }
  const dateLabel = lw.at.toDate().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  card.style.display = '';
  const losers = Array.isArray(lw.losers) && lw.losers.length ? joinNamesHtml(lw.losers) : coloredNameHtml(lw.loser);
  el.innerHTML = `${dateLabel} ${coloredNameHtml(lw.winner)} hat gegen ${losers} in ${escapeHtml(lw.game)} gewonnen.`;
}

// ----- Spiele-Seite -----
function resetGamesView() {
  suLeave();
  gamesView = 'menu';
  openGameId = null;
  openGroupId = null;
  openTournamentId = null;
  lastBoardSig = '';
  chSel = null;
}

function renderGames() {
  const el = document.getElementById('games-content');
  const titleEl = document.getElementById('games-title');
  if (!el || !titleEl || !currentUser) return;

  if (suUi && gamesView !== 'sboard') suLeave();
  if (gamesView === 'sboard') {
    if (suUi) { renderSudokuBoard(el, titleEl); return; }
    gamesView = 'sudoku';
  }
  if (gamesView === 'sudoku') { lastBoardSig = ''; renderSudokuMenu(el, titleEl); return; }
  if (gamesView === 'gboard') {
    const gg = groupGameOf(openGroupId);
    if (gg && gg.status !== 'invited') { renderBlokusBoard(el, titleEl, gg); return; }
    gamesView = 'globby';
    openGroupId = null;
  }
  if (gamesView === 'board') {
    const g = gameOf(openGameId);
    if (g && g.status !== 'invited') {
      const type = gameTypeOf(g);
      if (type === 'chess') renderChessBoard(el, titleEl, g);
      else if (type === 'tictactoe') renderTttBoard(el, titleEl, g);
      else if (type === 'kniffel') renderKniffelBoard(el, titleEl, g);
      else if (type === 'othello') renderOthelloBoard(el, titleEl, g);
      else if (type === 'ships') renderShipsBoard(el, titleEl, g);
      else renderC4Board(el, titleEl, g);
      if (g.tournamentId) titleEl.textContent += ' · Turnier';
      return;
    }
    gamesView = openTournamentId ? 'tournament' : 'lobby';
    openGameId = null;
    chSel = null;
  }
  lastBoardSig = '';
  if (gamesView === 'globby') renderGroupLobby(el, titleEl, gamesType);
  else if (gamesView === 'tournament') renderTournamentView(el, titleEl);
  else if (gamesView === 'menu') renderGamesMenu(el, titleEl);
  else renderGameLobby(el, titleEl, gamesType);
}

function renderGamesMenu(el, titleEl) {
  titleEl.textContent = '🎮 Spiele';
  const tns = myVisibleTournaments();
  const tnBlock = tns.length
    ? `<div class="games-section-title" style="margin-top:0;">🏆 Turniere</div>${tns.map(tnCardHtml).join('')}<div class="games-section-title">Spiele</div>`
    : '';
  el.innerHTML = tnBlock + Object.entries(GAME_TYPES).map(([type, t]) => {
    const n = t.solo ? 0 : (t.multi ? groupPendingCount() : gamesPendingCount(type));
    return `
    <button class="game-tile" data-open-game="${type}">
      <span class="game-tile-icon">${t.icon}</span>
      <span class="game-tile-text"><strong>${escapeHtml(t.label)}</strong><small>${escapeHtml(t.subtitle)}</small></span>
      ${n ? `<span class="game-tile-badge">${n}</span>` : ''}
    </button>`;
  }).join('');
  el.querySelectorAll('[data-open-game]').forEach((b) => b.addEventListener('click', () => {
    gamesType = b.dataset.openGame;
    gamesView = GAME_TYPES[gamesType].solo ? 'sudoku' : (GAME_TYPES[gamesType].multi ? 'globby' : 'lobby');
    renderGames();
  }));
  el.querySelectorAll('[data-open-tournament]').forEach((b) => b.addEventListener('click', () => {
    openTournamentId = b.dataset.openTournament;
    gamesView = 'tournament';
    renderGames();
  }));
}

// Text für Karten und Listen: wer ist als Nächstes dran?
function gameWaitingText(g, myIdx) {
  const mine = gameWaitingOn(g).includes(myIdx + 1);
  if (gameTypeOf(g) === 'ships' && g.phase === 'placing') return mine ? '<strong>Flotte platzieren</strong>' : 'Gegner platziert noch';
  return mine ? '<strong>du bist dran</strong>' : 'Gegner ist dran';
}

function gamePriority(g) {
  const myIdx = gamePlayerIndex(g, currentUser.name);
  if (g.status === 'invited') return myIdx === 1 ? 0 : 3;
  if (g.status === 'active') {
    const drawForMe = g.drawOffer && g.drawOffer !== myIdx + 1;
    return (gameWaitingOn(g).includes(myIdx + 1) || drawForMe) ? 1 : 2;
  }
  return 4;
}

function gameCardHtml(g) {
  const myIdx = gamePlayerIndex(g, currentUser.name);
  const oppName = g.players[myIdx === 0 ? 1 : 0];
  let info = '';
  let actions = '';
  if (g.status === 'invited') {
    if (myIdx === 1) {
      info = `${coloredNameHtml(oppName)} fordert dich heraus`;
      actions = `<button class="btn btn-primary btn-small" data-g-accept="${g.id}">Annehmen</button>
                 <button class="btn btn-secondary btn-small" data-g-decline="${g.id}">Ablehnen</button>`;
    } else {
      info = `Warte auf Antwort von ${coloredNameHtml(oppName)}`;
      actions = `<button class="btn btn-secondary btn-small" data-g-decline="${g.id}">Zurückziehen</button>`;
    }
  } else if (g.status === 'active') {
    let extra = '';
    if (g.drawOffer) extra = g.drawOffer === myIdx + 1 ? ' · Remis angeboten' : ' · <strong>Remis-Angebot</strong>';
    info = `Gegen ${coloredNameHtml(oppName)} – ${gameWaitingText(g, myIdx)}${extra}`;
    actions = `<button class="btn btn-primary btn-small" data-g-open="${g.id}">Öffnen</button>`;
  } else {
    let result;
    if (g.winner === 0) result = 'Unentschieden';
    else if (g.winner === myIdx + 1) result = '🏆 Du hast gewonnen';
    else result = `${coloredNameHtml(oppName)} hat gewonnen`;
    info = `Gegen ${coloredNameHtml(oppName)} – ${result}`;
    actions = `<button class="btn btn-secondary btn-small" data-g-open="${g.id}">Ansehen</button>
               <button class="btn btn-primary btn-small" data-g-rematch="${escapeHtml(oppName)}">Revanche</button>
               <button class="btn btn-ghost btn-small" data-g-remove="${g.id}">Entfernen</button>`;
  }
  return `<div class="game-card"><div>${info}</div><div class="game-card-actions">${actions}</div></div>`;
}

// Eine Zeile pro Duell (Spielerpaar): Stand "Siege A : Siege B", der Führende steht links.
function gameDuelRows(type) {
  const stats = gameStatsAll[type] || { wins: {}, draws: {} };
  const duels = {};
  const duelOf = (a, b) => {
    const key = [a, b].sort().join('|');
    if (!duels[key]) {
      const [x, y] = key.split('|');
      duels[key] = { x, y, xWins: 0, yWins: 0, draws: 0 };
    }
    return duels[key];
  };
  Object.entries(stats.wins || {}).forEach(([key, n]) => {
    const [winner, loser] = key.split('|');
    const d = duelOf(winner, loser);
    if (winner === d.x) d.xWins += n; else d.yWins += n;
  });
  Object.entries(stats.draws || {}).forEach(([key, n]) => {
    const [a, b] = key.split('|');
    duelOf(a, b).draws += n;
  });
  return Object.values(duels).map((d) => {
    const nx = canonicalUserName(d.x);
    const ny = canonicalUserName(d.y);
    const xFirst = d.xWins > d.yWins || (d.xWins === d.yWins && nx.localeCompare(ny) <= 0);
    const left = xFirst ? { name: nx, wins: d.xWins } : { name: ny, wins: d.yWins };
    const right = xFirst ? { name: ny, wins: d.yWins } : { name: nx, wins: d.xWins };
    return { left, right, draws: d.draws, total: d.xWins + d.yWins + d.draws };
  }).sort((a, b) => b.total - a.total || a.left.name.localeCompare(b.left.name) || a.right.name.localeCompare(b.right.name));
}

function gameStatsTableHtml(type) {
  const rows = gameDuelRows(type);
  if (!rows.length) return `<div class="games-muted">Noch keine beendeten Partien.</div>`;
  const body = rows.map((r) => `
    <tr>
      <td>${coloredNameHtml(r.left.name)}</td>
      <td class="mid">${r.left.wins} : ${r.right.wins}${r.draws ? `<small>${r.draws}× unentschieden</small>` : ''}</td>
      <td class="rt">${coloredNameHtml(r.right.name)}</td>
    </tr>`).join('');
  return `<table class="games-table">
    <thead><tr><th>Spieler</th><th class="mid">Siege</th><th class="rt">Spieler</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function gameOpenBoard(gameId) {
  const g = gameOf(gameId);
  if (!g) return;
  gamesType = gameTypeOf(g);
  openGameId = gameId;
  openTournamentId = g.tournamentId || null;
  gamesView = 'board';
  lastBoardSig = '';
  chSel = null;
  c4AnimKey = g.id + ':' + (g.moves || 0);   // beim Öffnen keine Fall-Animation
  renderGames();
}

function renderGameLobby(el, titleEl, type) {
  const t = GAME_TYPES[type] || GAME_TYPES.connect4;
  titleEl.textContent = t.label;
  const me = currentUser.name;
  const typeGames = gamesRaw.filter((g) => gameTypeOf(g) === type && !g.tournamentId);
  const myGames = typeGames.slice().sort((a, b) => gamePriority(a) - gamePriority(b));
  const gamesHtml = myGames.length
    ? myGames.map(gameCardHtml).join('')
    : `<div class="games-muted">Noch keine Partien. Fordere unten jemanden heraus!</div>`;

  const others = Object.values(usersMap)
    .filter((u) => u.name.toLowerCase() !== me.toLowerCase())
    .sort((a, b) => a.name.localeCompare(b.name));
  const challengeHtml = others.length ? others.map((u) => {
    const g = typeGames.find((x) => x.pairKey === gamePairKey(me, u.name));
    let right;
    if (g && g.status === 'active') right = '<span class="game-hint">Partie läuft</span>';
    else if (g && g.status === 'invited') right = '<span class="game-hint">Einladung offen</span>';
    else right = `<button class="btn btn-secondary btn-small" data-g-challenge="${escapeHtml(u.name)}">Herausfordern</button>`;
    return `<div class="game-card"><div class="game-card-top">${coloredNameHtml(u.name)}${right}</div></div>`;
  }).join('') : `<div class="games-muted">Es gibt noch keine anderen Nutzer.</div>`;

  el.innerHTML = `
    <div class="games-section-title" style="margin-top:0;">Meine Partien</div>
    ${gamesHtml}
    <div class="games-section-title">Herausfordern</div>
    ${challengeHtml}
    <div class="games-section-title">Wer hat wie oft gegen wen gewonnen?</div>
    ${gameStatsTableHtml(type)}`;

  el.querySelectorAll('[data-g-challenge]').forEach((b) => b.addEventListener('click', () => gameChallenge(type, b.dataset.gChallenge)));
  el.querySelectorAll('[data-g-rematch]').forEach((b) => b.addEventListener('click', () => gameChallenge(type, b.dataset.gRematch)));
  el.querySelectorAll('[data-g-accept]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.gAccept;
    gameOpenAfterAccept = id;
    const ok = await gameAccept(id);
    if (!ok) gameOpenAfterAccept = null;
  }));
  el.querySelectorAll('[data-g-decline]').forEach((b) => b.addEventListener('click', () => gameCancelInvite(b.dataset.gDecline)));
  el.querySelectorAll('[data-g-open]').forEach((b) => b.addEventListener('click', () => gameOpenBoard(b.dataset.gOpen)));
  el.querySelectorAll('[data-g-remove]').forEach((b) => b.addEventListener('click', () => gameRemoveFinished(b.dataset.gRemove)));
}

// ----- 4 Gewinnt: Spielbrett -----
function renderC4Board(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES.connect4.label;
  const myIdx = gamePlayerIndex(g, currentUser.name);
  const styles = gameStoneStyles(g);

  // Nur neu zeichnen, wenn sich wirklich etwas geändert hat (sonst würde die Fall-Animation abbrechen)
  const sig = JSON.stringify([g.id, g.status, g.turn, g.moves, g.winner, g.players, styles]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const animate = g.lastMove >= 0 && c4AnimKey !== g.id + ':' + (g.moves || 0);
  c4AnimKey = g.id + ':' + (g.moves || 0);

  const isActive = g.status === 'active';
  const myTurn = isActive && myIdx >= 0 && g.turn === myIdx + 1;

  const colButtons = Array.from({ length: C4_COLS }, (_, c) => {
    const full = c4DropRow(g.board, c) < 0;
    return `<button class="c4-col" data-c4-col="${c}" ${(!myTurn || full) ? 'disabled' : ''} style="${myTurn ? `color:${styles[myIdx].fill};` : ''}" aria-label="Spalte ${c + 1}">▼</button>`;
  }).join('');

  const winSet = new Set(g.winCells || []);
  const cells = g.board.map((v, i) => {
    let stone = '';
    if (v) {
      const st = styles[v - 1];
      const isLast = animate && i === g.lastMove;
      const dropVar = isLast ? `--drop-rows:${Math.floor(i / C4_COLS) + 1};` : '';
      stone = `<span class="c4-stone ${isLast ? 'drop' : ''} ${winSet.has(i) ? 'win' : ''}" style="background:${st.fill};--ring:${st.ring};${dropVar}"></span>`;
    }
    return `<div class="c4-cell">${stone}</div>`;
  }).join('');

  const chip = (idx) => `
    <div class="c4-player ${isActive && g.turn === idx + 1 ? 'turn' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}
    </div>`;

  let status = '';
  if (g.status === 'finished') {
    status = g.winner === 0 ? '🤝 Unentschieden!' : `🏆 ${coloredNameHtml(g.players[g.winner - 1])} hat gewonnen!`;
  } else if (myTurn) {
    status = '<strong>Du bist dran</strong> – wähle oben eine Spalte.';
  } else if (isActive) {
    status = `${coloredNameHtml(g.players[g.turn - 1])} ist dran …`;
  }

  let actions = '';
  if (isActive && myIdx >= 0) {
    actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
  } else if (g.status === 'finished' && myIdx >= 0 && !g.tournamentId) {
    actions = `<button class="btn btn-primary btn-small" id="g-rematch-btn">Revanche</button>`;
  }

  el.innerHTML = `
    <div class="c4-players">${chip(0)}<span class="c4-vs">gegen</span>${chip(1)}</div>
    <div class="c4-status">${status}</div>
    <div class="c4-wrap">
      <div class="c4-cols">${colButtons}</div>
      <div class="c4-board">${cells}</div>
    </div>
    <div class="c4-actions">${actions}</div>`;

  el.querySelectorAll('[data-c4-col]').forEach((b) => b.addEventListener('click', () => c4PlayMove(g.id, parseInt(b.dataset.c4Col, 10))));
  bindResignAndRematch(el, g, myIdx);
}

// ----- Tic Tac Toe: Spielbrett (X und O werden als Grafik gezeichnet, sehen also überall gleich aus) -----
function tttMarkSvg(player, color, pop) {
  const shape = player === 1
    ? (stroke, width) => `<path d="M24 24 L76 76 M76 24 L24 76" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
    : (stroke, width) => `<circle cx="50" cy="50" r="27" stroke="${stroke}" stroke-width="${width}" fill="none"/>`;
  return `<svg class="ttt-mark ${pop ? 'pop' : ''}" viewBox="0 0 100 100" aria-hidden="true">${shape('rgba(0,0,0,0.55)', 17)}${shape(color, 11)}</svg>`;
}

function renderTttBoard(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES.tictactoe.label;
  const myIdx = gamePlayerIndex(g, currentUser.name);
  const styles = gameStoneStyles(g);

  // Nur neu zeichnen, wenn sich wirklich etwas geändert hat (sonst würde die Animation abbrechen)
  const sig = JSON.stringify([g.id, g.status, g.turn, g.moves, g.winner, g.players, styles]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const animate = g.lastMove >= 0 && c4AnimKey !== g.id + ':' + (g.moves || 0);
  c4AnimKey = g.id + ':' + (g.moves || 0);

  const isActive = g.status === 'active';
  const myTurn = isActive && myIdx >= 0 && g.turn === myIdx + 1;
  const winSet = new Set(g.winCells || []);

  const cells = g.board.map((v, i) => {
    const open = myTurn && v === 0;
    const classes = ['ttt-cell'];
    if (open) classes.push('open');
    if (winSet.has(i)) classes.push('win');
    const mark = v ? tttMarkSvg(v, styles[v - 1].fill, animate && i === g.lastMove) : '';
    return `<button class="${classes.join(' ')}" data-ttt-cell="${i}" ${open ? '' : 'disabled'} aria-label="Feld ${i + 1}">${mark}</button>`;
  }).join('');

  const chip = (idx) => `
    <div class="c4-player ${isActive && g.turn === idx + 1 ? 'turn' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}<small class="ch-side">${idx === 0 ? 'X' : 'O'}</small>
    </div>`;

  let status = '';
  if (g.status === 'finished') {
    status = g.winner === 0 ? '🤝 Unentschieden!' : `🏆 ${coloredNameHtml(g.players[g.winner - 1])} hat gewonnen!`;
  } else if (myTurn) {
    status = '<strong>Du bist dran</strong> – tippe auf ein freies Feld.';
  } else if (isActive) {
    status = `${coloredNameHtml(g.players[g.turn - 1])} ist dran …`;
  }

  let actions = '';
  if (isActive && myIdx >= 0) {
    actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
  } else if (g.status === 'finished' && myIdx >= 0 && !g.tournamentId) {
    actions = `<button class="btn btn-primary btn-small" id="g-rematch-btn">Revanche</button>`;
  }

  el.innerHTML = `
    <div class="c4-players">${chip(0)}<span class="c4-vs">gegen</span>${chip(1)}</div>
    <div class="c4-status">${status}</div>
    <div class="ttt-board">${cells}</div>
    <div class="c4-actions">${actions}</div>`;

  el.querySelectorAll('[data-ttt-cell]').forEach((b) => b.addEventListener('click', () => tttPlayMove(g.id, parseInt(b.dataset.tttCell, 10))));
  bindResignAndRematch(el, g, myIdx);
}

// ----- Kniffel: Spielbrett (Würfel als Grafik, Punktetabelle mit beiden Spielern) -----
const KN_PIPS = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 26], [72, 26], [28, 50], [72, 50], [28, 74], [72, 74]]
};

function knDieSvg(v) {
  const content = v
    ? KN_PIPS[v].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="#1b2328"/>`).join('')
    : `<text x="50" y="64" text-anchor="middle" font-size="44" fill="#7d8b91">?</text>`;
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="4" y="4" width="92" height="92" rx="18" fill="${v ? '#F3EFE6' : '#C9D0D2'}" stroke="rgba(0,0,0,0.35)" stroke-width="3"/>${content}</svg>`;
}

// Welche Würfel ich für den nächsten Wurf behalten will (nur lokal, wird beim Würfeln mitgeschickt)
function knSyncUi(g) {
  if (knUi.gameId !== g.id || knUi.turnsDone !== (g.turnsDone || 0)) {
    knUi = { gameId: g.id, turnsDone: g.turnsDone || 0, held: [false, false, false, false, false] };
  }
}

async function knEnterBox(g, box, points, bonus) {
  const label = KN_LABELS[box];
  let text = points === 0
    ? `0 Punkte in „${label}“ eintragen? Das Feld wird gestrichen.`
    : `${points} Punkte in „${label}“ eintragen?`;
  if (bonus) text += ` Dazu gibt es ${bonus} Bonuspunkte für den Zusatz-Kniffel.`;
  const ok = await confirmModal('Punkte eintragen?', text, 'Eintragen');
  if (ok) kniffelScore(g.id, box);
}

function renderKniffelBoard(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES.kniffel.label;
  const myIdx = gamePlayerIndex(g, currentUser.name);
  const styles = gameStoneStyles(g);
  knSyncUi(g);

  const isActive = g.status === 'active';
  const myTurn = isActive && myIdx >= 0 && g.turn === myIdx + 1;
  const dice = g.dice || [0, 0, 0, 0, 0];
  const rolled = dice.every((d) => d >= 1);
  const rollsLeft = typeof g.rollsLeft === 'number' ? g.rollsLeft : 3;
  const cards = [g.card1 || {}, g.card2 || {}];
  const extras = [g.extra1 || 0, g.extra2 || 0];

  // Nur neu zeichnen, wenn sich wirklich etwas geändert hat (sonst würde die Würfel-Animation abbrechen)
  const sig = JSON.stringify([g.id, g.status, g.turn, g.moves, g.winner, g.reason, g.players, styles, dice, rollsLeft, cards, extras,
    knUi.held, g.lastRolled, g.lastBox, g.lastBoxPlayer]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const animate = (g.moves || 0) > 0 && c4AnimKey !== g.id + ':' + (g.moves || 0);
  c4AnimKey = g.id + ':' + (g.moves || 0);

  const canHold = myTurn && rolled && rollsLeft > 0;
  const diceHtml = dice.map((v, i) => {
    const held = canHold && knUi.held[i];
    const rolling = animate && g.lastRolled && g.lastRolled[i];
    return `<div class="kn-die-wrap">
      <button class="kn-die ${held ? 'held' : ''} ${rolling ? 'roll' : ''}" data-kn-die="${i}" ${canHold ? '' : 'disabled'}
        aria-label="Würfel ${i + 1}: ${v || 'noch nicht gewürfelt'}${held ? ', behalten' : ''}">${knDieSvg(v)}</button>
      <span class="kn-die-label">${held ? 'behalten' : ''}</span>
    </div>`;
  }).join('');

  const allHeld = rolled && knUi.held.every(Boolean);
  let rollHtml = '';
  if (myTurn) {
    const label = rollsLeft === 3 ? 'Würfeln' : (rollsLeft > 0 ? `Nochmal würfeln (${rollsLeft} übrig)` : 'Keine Würfe mehr');
    rollHtml = `<div class="kn-roll-row"><button class="btn btn-primary" id="kn-roll-btn" ${(rollsLeft > 0 && !allHeld) ? '' : 'disabled'}>${label}</button></div>`;
  }

  // Punktetabelle
  const myCard = myIdx >= 0 ? cards[myIdx] : {};
  const allowed = (myTurn && rolled) ? knFreeBoxes(myCard) : [];
  const cell = (p, box) => {
    const val = cards[p][box];
    const last = g.lastBox === box && g.lastBoxPlayer === p + 1 ? ' last' : '';
    if (val !== undefined) return `<td class="kn-filled${last}">${val}</td>`;
    if (p === myIdx && allowed.includes(box)) {
      const pts = knScoreBox(dice, box);
      return `<td class="kn-open"><button class="kn-pick${pts === 0 ? ' zero' : ''}" data-kn-box="${box}" data-kn-pts="${pts}">${pts}</button></td>`;
    }
    return `<td class="kn-empty"></td>`;
  };
  const boxRow = (box) => `<tr><th scope="row">${KN_LABELS[box]}</th>${cell(0, box)}${cell(1, box)}</tr>`;
  const sumRow = (label, a, b, cls) => `<tr class="kn-sum ${cls || ''}"><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`;
  const upperSums = cards.map(knUpperSum);
  const totals = cards.map((c, i) => knTotal(c, extras[i]));
  const bonusText = (p) => (upperSums[p] >= KN_BONUS_LIMIT ? `+${KN_BONUS_POINTS}` : '–');
  const tableHtml = `<table class="kn-table">
    <thead><tr><th></th><th>${coloredNameHtml(g.players[0])}</th><th>${coloredNameHtml(g.players[1])}</th></tr></thead>
    <tbody>
      ${KN_UPPER.map(boxRow).join('')}
      ${sumRow('Summe oben', `${upperSums[0]} / ${KN_BONUS_LIMIT}`, `${upperSums[1]} / ${KN_BONUS_LIMIT}`)}
      ${sumRow(`Bonus (ab ${KN_BONUS_LIMIT})`, bonusText(0), bonusText(1))}
      ${KN_LOWER.map(boxRow).join('')}
      ${sumRow(`Zusatz-Kniffel (je +${KN_EXTRA_KNIFFEL})`, extras[0] ? `+${extras[0]}` : '–', extras[1] ? `+${extras[1]}` : '–')}
      ${sumRow('Gesamt', totals[0], totals[1], 'kn-total')}
    </tbody></table>`;

  const chip = (idx) => `
    <div class="c4-player ${isActive && g.turn === idx + 1 ? 'turn' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}<small class="ch-side">${totals[idx]}</small>
    </div>`;

  let status = '';
  if (g.status === 'finished') {
    const score = `${totals[0]} : ${totals[1]}`;
    const why = g.reason === 'resign' ? ' – Aufgabe' : '';
    status = g.winner === 0
      ? `🤝 Unentschieden! (${score})`
      : `🏆 ${coloredNameHtml(g.players[g.winner - 1])} hat gewonnen! (${score})${why}`;
  } else if (myTurn) {
    if (rollsLeft === 3) status = '<strong>Du bist dran</strong> – würfle!';
    else if (rollsLeft > 0) status = '<strong>Du bist dran</strong> – tippe Würfel zum Behalten an und würfle nochmal, oder wähle ein Feld.';
    else status = '<strong>Du bist dran</strong> – wähle ein Feld für deine Punkte.';
  } else if (isActive) {
    const more = rolled ? ` (${rollsLeft} Wurf${rollsLeft === 1 ? '' : 'e'} übrig)` : '';
    status = `${coloredNameHtml(g.players[g.turn - 1])} ist dran …${more}`;
  }

  let actions = '';
  if (isActive && myIdx >= 0) {
    actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
  } else if (g.status === 'finished' && myIdx >= 0 && !g.tournamentId) {
    actions = `<button class="btn btn-primary btn-small" id="g-rematch-btn">Revanche</button>`;
  }

  const rules = `<details class="kn-rules"><summary>Regeln</summary><ul>
    <li>Pro Zug bis zu 3 Würfe. Nach dem ersten Wurf tippst du die Würfel an, die du behalten willst.</li>
    <li>Oben zählen nur die Würfel mit der gewählten Zahl. Ab ${KN_BONUS_LIMIT} Punkten oben gibt es ${KN_BONUS_POINTS} Bonus.</li>
    <li>Dreierpasch und Viererpasch: Summe aller Würfel. Full House 25, kleine Straße (4 in Folge) 30, große Straße (5 in Folge) 40, Kniffel (5 gleiche) 50, Chance: Summe aller Würfel.</li>
    <li>Passt nichts, streichst du ein Feld (0 Punkte).</li>
    <li>Weiterer Kniffel: Stehen im Kniffel-Feld 50 Punkte, gibt es dafür ${KN_EXTRA_KNIFFEL} Bonuspunkte. Den Wurf trägst du danach ganz normal in ein freies Feld ein. Er zählt dort wie jeder andere Wurf, ein Kniffel ist also z.B. kein Full House.</li>
  </ul></details>`;

  el.innerHTML = `
    <div class="c4-players">${chip(0)}<span class="c4-vs">gegen</span>${chip(1)}</div>
    <div class="c4-status">${status}</div>
    <div class="kn-dice">${diceHtml}</div>
    ${rollHtml}
    ${tableHtml}
    <div class="c4-actions">${actions}</div>
    ${rules}`;

  el.querySelectorAll('[data-kn-die]').forEach((b) => b.addEventListener('click', () => {
    const i = parseInt(b.dataset.knDie, 10);
    knUi.held[i] = !knUi.held[i];
    renderGames();
  }));
  const rollBtn = el.querySelector('#kn-roll-btn');
  if (rollBtn) rollBtn.addEventListener('click', () => kniffelRoll(g.id, knUi.held.slice()));
  el.querySelectorAll('[data-kn-box]').forEach((b) => b.addEventListener('click', () => {
    knEnterBox(g, b.dataset.knBox, parseInt(b.dataset.knPts, 10), knExtraBonusFor(dice, myCard));
  }));
  bindResignAndRematch(el, g, myIdx);
}

// ----- Othello: Spielbrett (Steine in den Nutzerfarben, erlaubte Felder sind markiert) -----
function renderOthelloBoard(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES.othello.label;
  const myIdx = gamePlayerIndex(g, currentUser.name);
  const styles = gameStoneStyles(g);

  // Nur neu zeichnen, wenn sich wirklich etwas geändert hat (sonst würde die Umdreh-Animation abbrechen)
  const sig = JSON.stringify([g.id, g.status, g.turn, g.moves, g.winner, g.players, styles, g.lastPass]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const animate = (g.moves || 0) > 0 && c4AnimKey !== g.id + ':' + (g.moves || 0);
  c4AnimKey = g.id + ':' + (g.moves || 0);

  const isActive = g.status === 'active';
  const myTurn = isActive && myIdx >= 0 && g.turn === myIdx + 1;
  const legal = myTurn ? otLegalMoves(g.board, myIdx + 1) : new Map();
  const flipped = new Set(animate ? (g.flipped || []) : []);
  const counts = otCount(g.board);

  const cells = g.board.map((v, i) => {
    const isLegal = legal.has(i);
    const classes = ['ot-cell'];
    if (isLegal) classes.push('legal');
    if (i === g.lastMove) classes.push('last');
    let inner = '';
    if (v) {
      const st = styles[v - 1];
      const anim = flipped.has(i) ? ' flip' : (animate && i === g.lastMove ? ' pop' : '');
      inner = `<span class="ot-disc${anim}" style="background:${st.fill};--ring:${st.ring};"></span>`;
    } else if (isLegal) {
      inner = `<span class="ot-hint" style="background:${styles[myIdx].fill};"></span>`;
    }
    return `<button class="${classes.join(' ')}" data-ot-cell="${i}" ${isLegal ? '' : 'disabled'} aria-label="Feld ${i + 1}">${inner}</button>`;
  }).join('');

  const chip = (idx) => `
    <div class="c4-player ${isActive && g.turn === idx + 1 ? 'turn' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}<small class="ch-side">${counts[idx + 1]}</small>
    </div>`;

  let status = '';
  if (g.status === 'finished') {
    const score = `${counts[1]} : ${counts[2]}`;
    const why = g.reason === 'resign' ? ' – Aufgabe' : '';
    status = g.winner === 0
      ? `🤝 Unentschieden! (${score})`
      : `🏆 ${coloredNameHtml(g.players[g.winner - 1])} hat gewonnen! (${score})${why}`;
  } else if (myTurn) {
    status = '<strong>Du bist dran</strong> – tippe auf ein markiertes Feld.';
  } else if (isActive) {
    status = `${coloredNameHtml(g.players[g.turn - 1])} ist dran …`;
  }
  const passNote = (isActive && g.lastPass)
    ? `<div class="games-muted" style="text-align:center;margin-bottom:10px;">${coloredNameHtml(g.players[g.lastPass - 1])} hatte keinen Zug und musste passen.</div>`
    : '';

  let actions = '';
  if (isActive && myIdx >= 0) {
    actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
  } else if (g.status === 'finished' && myIdx >= 0 && !g.tournamentId) {
    actions = `<button class="btn btn-primary btn-small" id="g-rematch-btn">Revanche</button>`;
  }

  el.innerHTML = `
    <div class="c4-players">${chip(0)}<span class="c4-vs">gegen</span>${chip(1)}</div>
    <div class="c4-status">${status}</div>
    ${passNote}
    <div class="ot-board">${cells}</div>
    <div class="c4-actions">${actions}</div>`;

  el.querySelectorAll('[data-ot-cell]').forEach((b) => b.addEventListener('click', () => otelloPlayMove(g.id, parseInt(b.dataset.otCell, 10))));
  bindResignAndRematch(el, g, myIdx);
}

// ----- Turniere: Anzeige (Spiele-Bereich der Teilnehmer + Admin-Bereich) -----
function subscribeTournaments() {
  const base = db.collection('tournaments');
  const q = isAdmin(currentUser.name) ? base : base.where('participants', 'array-contains', currentUser.name);
  return q.onSnapshot((snap) => {
    tournamentsRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.game && Array.isArray(t.participants));
    renderAdminTournaments();
    renderGames();
    renderHomeGames();
    setTimeout(tournamentsAdvanceAll, 200);
  });
}

// Turniere, die die angemeldete Person sehen darf (laufende zuerst)
function myVisibleTournaments() {
  const today = tnToday();
  return tournamentsRaw
    .filter((t) => tnVisibleTo(t, currentUser.name, today))
    .sort((a, b) => ((a.status === 'finished') - (b.status === 'finished')) || b.startDate.localeCompare(a.startDate));
}

// Turnierpartien, bei denen etwas auf mich wartet (ich bin dran oder mir wurde Remis angeboten)
function tnMyOpenCount(t) {
  const { myTurn, drawOffers } = gamesPendingInfo();
  return new Set([...myTurn, ...drawOffers].filter((g) => g.tournamentId === t.id).map((g) => g.id)).size;
}

// Kurzer Statustext (Klartext, Namen werden mit escapeHtml ausgegeben)
function tnStatusText(t) {
  const label = (GAME_TYPES[t.game] || { label: t.game }).label;
  if (t.status === 'finished') {
    return t.winner ? `Sieger: ${t.winner}` : 'Beendet – kein Sieger';
  }
  if (t.status === 'final') return `Finale: ${(t.finalists || []).join(' gegen ')}`;
  if (t.status === 'group') {
    const fixtures = tnFixtures(t.participants);
    const left = fixtures.filter((f) => !(t.results || {})[f.key]).length;
    return `Gruppenphase – noch ${left} von ${fixtures.length} Partien offen`;
  }
  return `${label}: startet gleich`;
}

function tnCardHtml(t) {
  const meta = GAME_TYPES[t.game] || { label: t.game, icon: '🎮' };
  const open = t.status === 'finished' ? 0 : tnMyOpenCount(t);
  return `
    <button class="game-tile tn-tile" data-open-tournament="${t.id}">
      <span class="game-tile-icon">🏆</span>
      <span class="game-tile-text">
        <strong>Turnier: ${escapeHtml(meta.label)}</strong>
        <small>${escapeHtml(tnRangeLabel(t))} · ${escapeHtml(tnPrizeLabel(t))} zu gewinnen</small>
        <small>${escapeHtml(tnStatusText(t))}</small>
      </span>
      ${open ? `<span class="game-tile-badge">${open}</span>` : ''}
    </button>`;
}

function tnResultHtml(f, r) {
  if (!r) return 'noch offen';
  if (r.winner === -1) return 'gestrichen';
  if (r.winner === 0) return 'Unentschieden';
  return `Sieg für ${coloredNameHtml(f.players[r.winner - 1])}`;
}

const TN_REASONS = {
  final: 'im Finale',
  finalDraw: 'Finale remis – der Tabellenerste gewinnt',
  deadline: 'Zeitraum abgelaufen – der Tabellenerste gewinnt',
  noGames: 'Es wurde keine Partie gewertet'
};

// Tabelle (für Teilnehmer und Admin): Platz, Spieler, Spiele, Siege, Unentschieden, Niederlagen, Punkte
function tnTableHtml(t) {
  const fixtures = tnFixtures(t.participants);
  const stand = tnStandings(t.participants, fixtures, t.results || {});
  const order = (t.ranking && t.ranking.length) ? t.ranking : tnRanking(t, ((gameStatsAll[t.game] || {}).wins) || {});
  const rows = order.map((name, i) => {
    const r = stand[name];
    const finalist = (t.finalists || []).includes(name);
    return `<tr${finalist ? ' class="tn-finalist"' : ''}><td>${i + 1}</td><td class="tn-name">${coloredNameHtml(name)}</td><td>${r.played}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td class="tn-pts">${r.points}</td></tr>`;
  }).join('');
  return `<table class="games-table tn-table">
    <thead><tr><th>#</th><th class="tn-name">Spieler</th><th>Sp</th><th>S</th><th>U</th><th>N</th><th>Pkt</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderTournamentView(el, titleEl) {
  const t = tournamentsRaw.find((x) => x.id === openTournamentId);
  if (!t || !tnVisibleTo(t, currentUser.name, tnToday())) {
    gamesView = 'menu';
    openTournamentId = null;
    renderGamesMenu(el, titleEl);
    return;
  }
  titleEl.textContent = '🏆 Turnier';
  const meta = GAME_TYPES[t.game] || { label: t.game, icon: '🎮' };
  const me = currentUser.name;
  const fixtures = tnFixtures(t.participants);
  const results = t.results || {};
  const gameDoc = (key) => gamesRaw.find((g) => g.id === tnGameId(t.id, key));

  const head = `
    <div class="game-card tn-head">
      <div><strong>${meta.icon} ${escapeHtml(meta.label)}-Turnier</strong></div>
      <div class="games-muted">${escapeHtml(tnRangeLabel(t))} · <strong>${escapeHtml(tnPrizeLabel(t))} zu gewinnen</strong></div>
      <div style="margin-top:6px;">${escapeHtml(tnStatusText(t))}</div>
    </div>`;

  let banner = '';
  if (t.status === 'finished') {
    banner = t.winner
      ? `<div class="game-card tn-winner">🏆 ${coloredNameHtml(t.winner)} gewinnt das Turnier und <strong>${escapeHtml(tnPrizeLabel(t))}</strong> (${escapeHtml(TN_REASONS[t.endReason] || '')}).</div>`
      : `<div class="game-card tn-winner">${escapeHtml(TN_REASONS[t.endReason] || 'Beendet – kein Sieger.')}</div>`;
  }

  // Meine Partien (Gruppenphase + Finale)
  const gameRow = (key, players, label) => {
    const opp = players[0].toLowerCase() === me.toLowerCase() ? players[1] : players[0];
    const g = gameDoc(key);
    // Ist die Partie schon beendet, das Turnier-Ergebnis aber noch unterwegs, gilt das Ergebnis der Partie
    const r = results[key] || (g && g.status === 'finished' ? { winner: g.winner } : null);
    let info; let action = '';
    if (r) {
      info = tnResultHtml({ players }, r);
      if (g) action = `<button class="btn btn-secondary btn-small" data-tn-open="${g.id}">Ansehen</button>`;
    } else if (g && g.status === 'active') {
      info = gameWaitingText(g, gamePlayerIndex(g, me));
      action = `<button class="btn btn-primary btn-small" data-tn-open="${g.id}">Öffnen</button>`;
    } else {
      info = 'noch nicht gestartet';
    }
    return `<div class="game-card"><div>${label ? `<strong>${label}</strong> – ` : ''}Gegen ${coloredNameHtml(opp)} – ${info}</div>${action ? `<div class="game-card-actions">${action}</div>` : ''}</div>`;
  };

  let finalHtml = '';
  if ((t.finalists || []).length === 2) {
    const fin = t.finalists;
    const isFinalist = fin.some((n) => n.toLowerCase() === me.toLowerCase());
    finalHtml = `<div class="games-section-title">Finale</div>`
      + (isFinalist
        ? gameRow('final', fin, 'Finale')
        : `<div class="game-card"><div>${coloredNameHtml(fin[0])} gegen ${coloredNameHtml(fin[1])} – ${tnResultHtml({ players: fin }, results.final)}</div></div>`);
  }

  const mine = fixtures.filter((f) => f.players.some((n) => n.toLowerCase() === me.toLowerCase()));
  const myRows = mine.map((f) => gameRow(f.key, f.players, '')).join('');
  const others = fixtures.filter((f) => !mine.includes(f));
  const otherRows = others.map((f) => `<div class="game-card"><div>${coloredNameHtml(f.players[0])} – ${coloredNameHtml(f.players[1])}</div><div class="games-muted">${tnResultHtml(f, results[f.key])}</div></div>`).join('');

  el.innerHTML = `
    ${head}
    ${banner}
    <div class="games-section-title">Tabelle</div>
    ${tnTableHtml(t)}
    <div class="games-muted" style="margin-top:8px;">Sieg ${TN_WIN} Punkte, Unentschieden ${TN_DRAW} Punkt. Bei Gleichstand zählt der direkte Vergleich, dann die Siege in der normalen Tabelle des Spiels, zuletzt das Los. Die ersten beiden spielen am Ende das Finale.</div>
    ${finalHtml}
    <div class="games-section-title">Meine Partien</div>
    ${myRows || '<div class="games-muted">Du hast keine Partien in diesem Turnier.</div>'}
    ${otherRows ? `<div class="games-section-title">Partien der anderen</div>${otherRows}` : ''}`;

  el.querySelectorAll('[data-tn-open]').forEach((b) => b.addEventListener('click', () => gameOpenBoard(b.dataset.tnOpen)));
}

// ----- Admin: Turnier anlegen und verwalten -----
function tnFormValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function initTournamentForm() {
  const gameSel = document.getElementById('tn-game');
  const daysSel = document.getElementById('tn-days');
  const prizeSel = document.getElementById('tn-prize');
  const startInput = document.getElementById('tn-start');
  const createBtn = document.getElementById('tn-create-btn');
  if (!gameSel || !daysSel || !prizeSel || !startInput || !createBtn) return;
  gameSel.innerHTML = Object.entries(GAME_TYPES).filter(([, v]) => !v.multi && !v.solo).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');
  daysSel.innerHTML = [1, 2, 3].map((d) => `<option value="${d}">${d} ${d === 1 ? 'Tag' : 'Tage'}</option>`).join('');
  prizeSel.innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${i + 1 === 5 ? 'selected' : ''}>${i + 1} €</option>`).join('');
  startInput.value = tnToday();
  createBtn.addEventListener('click', async () => {
    const startDate = tnFormValue('tn-start');
    if (startDate < tnToday()) { toast('Das Startdatum liegt in der Vergangenheit.'); return; }
    const names = Object.values(usersMap).map((u) => u.name).filter((n) => !tnFormSelected || tnFormSelected.has(n));
    try {
      await tournamentCreate({
        game: tnFormValue('tn-game'), startDate, days: parseInt(tnFormValue('tn-days'), 10),
        prize: parseInt(tnFormValue('tn-prize'), 10), participants: names
      });
      toast('Turnier angelegt.');
      setTimeout(tournamentsAdvanceAll, 300);
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : 'Das Turnier konnte nicht angelegt werden.');
    }
  });
}

function renderAdminTournaments() {
  const listEl = document.getElementById('tn-admin-list');
  const partEl = document.getElementById('tn-participants');
  if (!listEl || !partEl || !currentUser || !isAdmin(currentUser.name)) return;

  const names = Object.values(usersMap).map((u) => u.name).sort((a, b) => a.localeCompare(b));
  if (!tnFormSelected) tnFormSelected = new Set(names);          // zunächst sind alle ausgewählt
  partEl.innerHTML = names.map((n) => `
    <label class="tn-check"><input type="checkbox" data-tn-part="${escapeHtml(n)}" ${tnFormSelected.has(n) ? 'checked' : ''}> ${coloredNameHtml(n)}</label>`).join('');
  partEl.querySelectorAll('[data-tn-part]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) tnFormSelected.add(cb.dataset.tnPart); else tnFormSelected.delete(cb.dataset.tnPart);
  }));

  const sorted = tournamentsRaw.slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
  listEl.innerHTML = sorted.length ? sorted.map((t) => {
    const meta = GAME_TYPES[t.game] || { label: t.game, icon: '🎮' };
    const parts = t.participants.map(coloredNameHtml).join(', ');
    return `
      <div class="game-card tn-admin-card">
        <div class="game-card-top"><strong>${meta.icon} ${escapeHtml(meta.label)}</strong><span class="game-hint">${escapeHtml(tnStatusText(t))}</span></div>
        <div class="games-muted">${escapeHtml(tnRangeLabel(t))} · ${escapeHtml(tnPrizeLabel(t))} · ${parts}</div>
        ${t.status === 'scheduled' ? '' : `<div style="margin-top:8px;">${tnTableHtml(t)}</div>`}
        ${t.status === 'finished' && t.winner ? `<div style="margin-top:8px;">🏆 ${coloredNameHtml(t.winner)} · ${escapeHtml(tnPrizeLabel(t))} gutgeschrieben</div>` : ''}
        <div class="game-card-actions"><button class="btn btn-ghost btn-small" data-tn-delete="${t.id}">Löschen</button></div>
      </div>`;
  }).join('') : '<div class="games-muted">Noch keine Turniere angelegt.</div>';
  listEl.querySelectorAll('[data-tn-delete]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmModal('Turnier löschen?', 'Das Turnier und alle zugehörigen Partien werden entfernt. Ein bereits gutgeschriebener Gewinn bleibt auf dem Konto.');
    if (!ok) return;
    try { await tournamentDelete(b.dataset.tnDelete); } catch (err) { console.error(err); toast('Löschen fehlgeschlagen.'); }
  }));
}

initTournamentForm();

// App wieder im Vordergrund: anstehende Turnier-Schritte erledigen
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) tournamentsAdvanceAll();
});

// ----- Schiffe versenken: Anzeige -----
function shSyncUi(g) {
  if (shUi.gameId !== g.id) shUi = { gameId: g.id, grid: shNewGrid(), selected: 1, horizontal: true };
}

// 10 x 10 Feld mit Beschriftung (A-J, 1-10); cellHtml(i) liefert das Feld mit Nummer i
function shBoardHtml(cellHtml) {
  let html = '<div class="sh-board"><span class="sh-lbl"></span>';
  for (let c = 0; c < 10; c++) html += `<span class="sh-lbl">${SH_LETTERS[c]}</span>`;
  for (let r = 0; r < 10; r++) {
    html += `<span class="sh-lbl">${r + 1}</span>`;
    for (let c = 0; c < 10; c++) html += cellHtml(r * 10 + c);
  }
  return `${html}</div>`;
}

function shShipStyle(style) {
  return `background:${style.fill};--ring:${style.ring};`;
}

function renderShipsBoard(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES.ships.label;
  const myIdx = gamePlayerIndex(g, currentUser.name);
  if (myIdx < 0) { el.innerHTML = '<div class="games-muted">Du spielst in dieser Partie nicht mit.</div>'; return; }
  const myNum = myIdx + 1;
  const oppNum = myNum === 1 ? 2 : 1;
  const oppName = g.players[oppNum - 1];
  const styles = gameStoneStyles(g);
  shSyncUi(g);

  const isActive = g.status === 'active';
  const placing = isActive && g.phase === 'placing';
  const iAmReady = !!g['ready' + myNum];
  const myTurn = isActive && g.phase === 'battle' && g.turn === myNum;
  const editing = placing && !iAmReady;

  // Nur neu zeichnen, wenn sich wirklich etwas geändert hat
  const sig = JSON.stringify([g.id, g.status, g.phase, g.ready1, g.ready2, g.turn, g.moves, g.winner, g.players, styles, editing ? shUi : null]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const animate = (g.moves || 0) > 0 && c4AnimKey !== g.id + ':' + (g.moves || 0);
  c4AnimKey = g.id + ':' + (g.moves || 0);

  const myGrid = g['grid' + myNum] || shNewGrid();
  const myShots = g['shot' + myNum] || shNewGrid();
  const oppGrid = g['grid' + oppNum] || shNewGrid();
  const oppShots = g['shot' + oppNum] || shNewGrid();

  const turnNum = isActive && g.phase === 'battle' ? g.turn : 0;
  const chip = (idx) => {
    const n = idx + 1;
    const left = (g.phase === 'battle' || g.status === 'finished') ? `<small class="ch-side">${shShipsLeft(g['grid' + n] || shNewGrid(), g['shot' + n] || shNewGrid())} Schiffe</small>` : '';
    return `
    <div class="c4-player ${turnNum === n ? 'turn' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}${left}
    </div>`;
  };

  let status = '';
  let body = '';

  if (editing) {
    // ---- Flotte platzieren ----
    const grid = shUi.grid;
    const placed = new Set(grid.filter(Boolean));
    const chips = SH_FLEET.map((size, k) => {
      const id = k + 1;
      return `<button class="sh-chip ${shUi.selected === id ? 'sel' : ''} ${placed.has(id) ? 'done' : ''}" data-sh-ship="${id}">${size}er${placed.has(id) ? ' ✓' : ''}</button>`;
    }).join('');
    const board = shBoardHtml((i) => {
      const id = grid[i];
      return `<button class="sh-cell ${id ? 'ship' : ''} ${id && id === shUi.selected ? 'sel' : ''}" data-sh-place="${i}" style="${id ? shShipStyle(styles[myIdx]) : ''}" aria-label="${shCellLabel(i)}"></button>`;
    });
    const complete = shValidateGrid(grid) === '';
    status = `<strong>Platziere deine Flotte</strong> – wähle ein Schiff und tippe auf das Startfeld. Tippe ein gesetztes Schiff an, um es neu zu setzen.${g['ready' + oppNum] ? ` ${coloredNameHtml(oppName)} ist schon fertig.` : ''}`;
    body = `
      <div class="sh-chips">${chips}</div>
      ${board}
      <div class="c4-actions">
        <button class="btn btn-secondary btn-small" id="sh-rotate-btn">Drehen (jetzt ${shUi.horizontal ? 'waagerecht' : 'senkrecht'})</button>
        <button class="btn btn-secondary btn-small" id="sh-random-btn">Zufällig</button>
        <button class="btn btn-ghost btn-small" id="sh-reset-btn">Zurücksetzen</button>
        <button class="btn btn-primary btn-small" id="sh-done-btn" ${complete ? '' : 'disabled'}>Fertig</button>
      </div>`;
  } else if (placing) {
    // ---- eigene Flotte steht, der Gegner platziert noch ----
    status = `Deine Flotte steht. Warte, bis ${coloredNameHtml(oppName)} fertig ist …`;
    body = `<div class="sh-title">Meine Flotte</div>${shBoardHtml((i) => {
      const id = myGrid[i];
      return `<div class="sh-cell ${id ? 'ship' : ''}" style="${id ? shShipStyle(styles[myIdx]) : ''}"></div>`;
    })}`;
  } else {
    // ---- Kampf (oder beendet) ----
    const mySunk = new Set(shSunkIds(myGrid, myShots));
    const oppSunk = new Set(shSunkIds(oppGrid, oppShots));
    const finished = g.status === 'finished';
    const oppBoard = shBoardHtml((i) => {
      const id = oppGrid[i];
      const shot = oppShots[i];
      const revealed = id && (oppSunk.has(id) || finished);
      const classes = ['sh-cell'];
      if (shot) classes.push(id ? 'hit' : 'miss');
      if (revealed) classes.push('ship');
      if (revealed && !shot) classes.push('reveal');
      if (id && oppSunk.has(id)) classes.push('sunk');
      if (i === g.lastShot && g.lastShotBy === myNum) classes.push(animate ? 'last pop' : 'last');
      const style = revealed ? shShipStyle(styles[oppNum - 1]) : '';
      const canShoot = myTurn && !shot;
      return canShoot
        ? `<button class="${classes.join(' ')}" data-sh-shoot="${i}" aria-label="${shCellLabel(i)}"></button>`
        : `<div class="${classes.join(' ')}" style="${style}" aria-label="${shCellLabel(i)}"></div>`;
    });
    const myBoard = shBoardHtml((i) => {
      const id = myGrid[i];
      const shot = myShots[i];
      const classes = ['sh-cell'];
      if (id) classes.push('ship');
      if (shot) classes.push(id ? 'hit' : 'miss');
      if (id && mySunk.has(id)) classes.push('sunk');
      if (i === g.lastShot && g.lastShotBy === oppNum) classes.push(animate ? 'last pop' : 'last');
      return `<div class="${classes.join(' ')}" style="${id ? shShipStyle(styles[myIdx]) : ''}"></div>`;
    });
    body = `
      <div class="sh-title">Feld von ${escapeHtml(oppName)} – deine Schüsse</div>
      ${oppBoard}
      <div class="sh-title">Meine Flotte</div>
      ${myBoard}`;

    if (finished) {
      const why = g.reason === 'resign' ? ' – Aufgabe' : '';
      status = `🏆 ${coloredNameHtml(g.players[g.winner - 1])} hat gewonnen!${why}`;
    } else if (myTurn) {
      status = '<strong>Du bist dran</strong> – tippe ein Feld des Gegners an.';
    } else {
      status = `${coloredNameHtml(oppName)} ist dran …`;
    }
    if (g.lastShot >= 0) {
      const res = g.lastResult === 'miss' ? 'Wasser' : (g.lastResult === 'hit' ? 'Treffer!' : `Treffer – ein ${g.lastSunk}er-Schiff versenkt!`);
      body = `<div class="games-muted" style="text-align:center;margin-bottom:8px;">${coloredNameHtml(g.players[g.lastShotBy - 1])} schoss auf ${shCellLabel(g.lastShot)}: ${res}</div>${body}`;
    }
  }

  let actions = '';
  if (isActive) actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
  else if (g.status === 'finished' && !g.tournamentId) actions = `<button class="btn btn-primary btn-small" id="g-rematch-btn">Revanche</button>`;

  el.innerHTML = `
    <div class="c4-players">${chip(0)}<span class="c4-vs">gegen</span>${chip(1)}</div>
    <div class="c4-status">${status}</div>
    <div class="sh-boards">${body}</div>
    <div class="c4-actions">${actions}</div>`;

  // Platzieren
  el.querySelectorAll('[data-sh-ship]').forEach((b) => b.addEventListener('click', () => {
    shUi.selected = parseInt(b.dataset.shShip, 10);
    renderGames();
  }));
  el.querySelectorAll('[data-sh-place]').forEach((b) => b.addEventListener('click', () => {
    const idx = parseInt(b.dataset.shPlace, 10);
    const hit = shUi.grid[idx];
    if (hit) {                                              // gesetztes Schiff antippen = aufnehmen
      shUi.grid = shUi.grid.map((v) => (v === hit ? 0 : v));
      shUi.selected = hit;
      renderGames();
      return;
    }
    if (!shUi.selected) { toast('Wähle zuerst ein Schiff aus.'); return; }
    const cells = shPlacementCells(shUi.grid, shUi.selected, idx, shUi.horizontal);
    if (!cells) { toast('Hier passt das Schiff nicht.'); return; }
    const next = shUi.grid.map((v) => (v === shUi.selected ? 0 : v));
    cells.forEach((c) => { next[c] = shUi.selected; });
    shUi.grid = next;
    const open = SH_FLEET.map((_, k) => k + 1).find((id) => !next.includes(id));   // nächstes noch freies Schiff
    shUi.selected = open || 0;
    renderGames();
  }));
  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
  on('#sh-rotate-btn', () => { shUi.horizontal = !shUi.horizontal; renderGames(); });
  on('#sh-random-btn', () => { shUi.grid = shRandomGrid(); shUi.selected = 0; renderGames(); });
  on('#sh-reset-btn', () => { shUi.grid = shNewGrid(); shUi.selected = 1; renderGames(); });
  on('#sh-done-btn', () => { if (shValidateGrid(shUi.grid) === '') shipsPlace(g.id, shUi.grid.slice()); });
  // Schießen
  el.querySelectorAll('[data-sh-shoot]').forEach((b) => b.addEventListener('click', () => shipsShoot(g.id, parseInt(b.dataset.shShoot, 10))));
  bindResignAndRematch(el, g, myIdx);
}

// ----- Mehrspieler-Runden (Blokus): Abo, Hinweise, Lobby und Spielbrett -----
function subscribeGroupGames() {
  return db.collection('groupGames').where('participants', 'array-contains', currentUser.name).onSnapshot((snap) => {
    groupGamesRaw = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .filter((g) => g.type && GAME_TYPES[g.type] && Array.isArray(g.participants));
    renderGames();
    renderHomeGames();
    updateGamesBadge();
    groupCleanup(groupGamesRaw);
  });
}

// Alte beendete Runden (> 7 Tage) und unbeantwortete Einladungen (> 14 Tage) aufräumen
function groupCleanup(list) {
  const now = Date.now();
  list.forEach((g) => {
    const ts = g.status === 'finished' ? g.finishedAt : g.createdAt;
    const ms = ts && ts.toMillis ? ts.toMillis() : null;
    if (!ms) return;
    const ageDays = (now - ms) / 86400000;
    if ((g.status === 'finished' && ageDays > GAME_FINISHED_KEEP_DAYS) || (g.status === 'invited' && ageDays > GAME_STALE_INVITE_DAYS)) {
      db.collection('groupGames').doc(g.id).delete().catch(() => {});
    }
  });
}

function groupGameOf(id) {
  return groupGamesRaw.find((g) => g.id === id);
}

// Einladungen an mich, Runden in denen ich dran bin, Runden die ich als Eröffner starten kann (alle haben geantwortet)
function groupPendingInfo() {
  const me = currentUser.name;
  const invites = groupGamesRaw.filter((g) => g.status === 'invited' && g.host !== me && g.participants.includes(me)
    && !g.accepted.includes(me) && !g.declined.includes(me));
  const myTurn = groupGamesRaw.filter((g) => g.status === 'active' && g.players[g.turn - 1] === me);
  const hostReady = groupGamesRaw.filter((g) => g.status === 'invited' && g.host === me && g.accepted.length >= 2
    && g.participants.every((n) => g.accepted.includes(n) || g.declined.includes(n)));
  return { invites, myTurn, hostReady };
}

function groupPendingCount() {
  const { invites, myTurn, hostReady } = groupPendingInfo();
  return new Set([...invites, ...myTurn, ...hostReady].map((g) => g.id)).size;
}

function joinNamesHtml(names) {
  const html = names.map(coloredNameHtml);
  return html.length > 1 ? `${html.slice(0, -1).join(', ')} und ${html[html.length - 1]}` : html.join('');
}

// Farben für 2 bis 4 Spieler: Nutzerfarben, bei zu ähnlichen Farben wird eine ersetzt
function groupStoneStyles(names) {
  const fallback = ['#4A90D9', '#E3C94A', '#D9534F', '#5FAE6B', '#B07CD9', '#E3A857'];
  const chosen = [];
  names.forEach((n) => {
    const u = usersMap[n.toLowerCase()];
    let fill = (u && userColor(u, 'color')) || null;
    const ring = (u && userColor(u, 'border')) || fill;
    if (!fill || chosen.some((c) => colorDistance(c.fill, fill) < 90)) {
      fill = fallback.find((f) => chosen.every((c) => colorDistance(c.fill, f) >= 90)) || invertColor(chosen[0].fill);
    }
    chosen.push({ fill, ring: ring || fill });
  });
  return chosen;
}

function blStatsTableHtml(type) {
  const st = gameStatsAll[type] || {};
  const lower = new Set([...Object.keys(st.played || {}), ...Object.keys(st.wins || {}), ...Object.keys(st.draws || {})]);
  if (!lower.size) return `<div class="games-muted">Noch keine beendeten Runden.</div>`;
  const rows = [...lower].map((n) => ({ name: canonicalUserName(n), wins: (st.wins || {})[n] || 0, draws: (st.draws || {})[n] || 0, played: (st.played || {})[n] || 0 }))
    .sort((a, b) => b.wins - a.wins || a.played - b.played || a.name.localeCompare(b.name));
  const withDraws = rows.some((r) => r.draws);
  return `<table class="games-table">
    <thead><tr><th>Spieler</th><th class="mid">Siege</th>${withDraws ? '<th class="mid">Unentschieden</th>' : ''}<th class="mid">Runden</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${coloredNameHtml(r.name)}</td><td class="mid">${r.wins}</td>${withDraws ? `<td class="mid">${r.draws}</td>` : ''}<td class="mid">${r.played}</td></tr>`).join('')}</tbody></table>`;
}

function groupPriority(g) {
  const me = currentUser.name;
  const { invites, myTurn, hostReady } = groupPendingInfo();
  if (invites.includes(g)) return 0;
  if (myTurn.includes(g) || hostReady.includes(g)) return 1;
  if (g.status === 'active') return 2;
  if (g.status === 'invited') return 3;
  return 4;
}

function groupCardHtml(g) {
  const me = currentUser.name;
  const meta = GAME_TYPES[g.type];
  const others = g.participants.filter((n) => n !== me);
  let info = '';
  let actions = '';
  if (g.status === 'invited') {
    if (g.host === me) {
      const pending = g.participants.filter((n) => !g.accepted.includes(n) && !g.declined.includes(n));
      const parts = [];
      const yes = g.accepted.filter((n) => n !== me);
      if (yes.length) parts.push(`zugesagt: ${joinNamesHtml(yes)}`);
      if (pending.length) parts.push(`noch offen: ${joinNamesHtml(pending)}`);
      if (g.declined.length) parts.push(`abgesagt: ${joinNamesHtml(g.declined)}`);
      info = `Du hast ${joinNamesHtml(others)} eingeladen<br><span class="games-muted">${parts.join(' · ')}</span>`;
      actions = `${g.accepted.length >= 2 ? `<button class="btn btn-primary btn-small" data-bl-start="${g.id}" data-bl-pending="${pending.length}">${pending.length ? 'Mit den Zugesagten starten' : 'Starten'}</button>` : ''}
                 <button class="btn btn-ghost btn-small" data-bl-cancel="${g.id}">Abbrechen</button>`;
    } else if (g.accepted.includes(me)) {
      info = `${coloredNameHtml(g.host)} hat dich eingeladen – du hast zugesagt, warte auf den Start`;
    } else {
      info = `${coloredNameHtml(g.host)} lädt dich ein${others.length > 1 ? ` (mit ${joinNamesHtml(others.filter((n) => n !== g.host))})` : ''}`;
      actions = `<button class="btn btn-primary btn-small" data-bl-accept="${g.id}">Annehmen</button>
                 <button class="btn btn-secondary btn-small" data-bl-decline="${g.id}">Ablehnen</button>`;
    }
  } else if (g.status === 'active') {
    const turnName = g.players[g.turn - 1];
    const mine = turnName === me;
    info = `Mit ${joinNamesHtml(others)} – ${mine ? '<strong>du bist dran</strong>' : `${coloredNameHtml(turnName)} ist dran`}`;
    actions = `<button class="btn btn-primary btn-small" data-bl-open="${g.id}">Öffnen</button>`;
  } else {
    const slot = g.players.indexOf(me) + 1;
    let result;
    if (!g.winners || g.winners.length !== 1) result = g.winners && g.winners.length ? `Unentschieden zwischen ${joinNamesHtml(g.winners)}` : 'beendet';
    else if (g.winner === me) result = '🏆 Du hast gewonnen';
    else result = `${coloredNameHtml(g.winner)} hat gewonnen`;
    info = `Mit ${joinNamesHtml(others)} – ${result}${slot ? ` (du: ${g.scores[slot - 1] > 0 ? '+' : ''}${g.scores[slot - 1]} Punkte)` : ''}`;
    actions = `<button class="btn btn-secondary btn-small" data-bl-open="${g.id}">Ansehen</button>
               <button class="btn btn-primary btn-small" data-bl-rematch="${g.id}">Revanche</button>
               <button class="btn btn-ghost btn-small" data-bl-hide="${g.id}">Entfernen</button>`;
  }
  return `<div class="game-card"><div>${info}</div>${actions ? `<div class="game-card-actions">${actions}</div>` : ''}</div>`;
}

function renderGroupLobby(el, titleEl, type) {
  const meta = GAME_TYPES[type];
  titleEl.textContent = meta.label;
  const me = currentUser.name;
  const mine = groupGamesRaw.filter((g) => g.type === type && !(g.hiddenBy || []).includes(me) && !(g.declined || []).includes(me))
    .sort((a, b) => groupPriority(a) - groupPriority(b));
  const others = Object.values(usersMap).map((u) => u.name).filter((n) => n.toLowerCase() !== me.toLowerCase()).sort((a, b) => a.localeCompare(b));
  blInviteSel = new Set([...blInviteSel].filter((n) => others.includes(n)));
  const count = blInviteSel.size;
  el.innerHTML = `
    <div class="games-section-title" style="margin-top:0;">Neue Runde</div>
    <div class="game-card">
      <div class="games-muted" style="margin-bottom:6px;">Wen möchtest du einladen? (1 bis 3 Mitspieler) – zu zweit wird auf dem kleinen Brett (14×14) gespielt, ab drei Spielern auf dem großen (20×20).</div>
      ${others.map((n) => `<label class="tn-check"><input type="checkbox" data-bl-invite="${escapeHtml(n)}" ${blInviteSel.has(n) ? 'checked' : ''}> ${coloredNameHtml(n)}</label>`).join('') || '<div class="games-muted">Es gibt noch keine anderen Nutzer.</div>'}
      <div class="game-card-actions"><button class="btn btn-primary btn-small" id="bl-create-btn" ${count >= 1 && count <= 3 ? '' : 'disabled'}>${count ? `Mit ${count} ${count === 1 ? 'Mitspieler' : 'Mitspielern'} einladen` : 'Einladen'}</button></div>
    </div>
    <div class="games-section-title">Meine Runden</div>
    ${mine.length ? mine.map(groupCardHtml).join('') : '<div class="games-muted">Noch keine Runden. Lade oben jemanden ein!</div>'}
    <div class="games-section-title">Siege und Runden</div>
    ${blStatsTableHtml(type)}`;

  el.querySelectorAll('[data-bl-invite]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) blInviteSel.add(cb.dataset.blInvite); else blInviteSel.delete(cb.dataset.blInvite);
    renderGames();
  }));
  const create = el.querySelector('#bl-create-btn');
  if (create) create.addEventListener('click', async () => {
    const ok = await blokusCreate([...blInviteSel]);
    if (ok) { blInviteSel = new Set(); renderGames(); }
  });
  el.querySelectorAll('[data-bl-accept]').forEach((b) => b.addEventListener('click', () => blokusRespond(b.dataset.blAccept, true)));
  el.querySelectorAll('[data-bl-decline]').forEach((b) => b.addEventListener('click', () => blokusRespond(b.dataset.blDecline, false)));
  el.querySelectorAll('[data-bl-start]').forEach((b) => b.addEventListener('click', async () => {
    const pending = parseInt(b.dataset.blPending, 10);
    if (pending > 0) {
      const ok = await confirmModal('Jetzt starten?', 'Wer noch nicht geantwortet hat, ist dann nicht dabei.', 'Starten');
      if (!ok) return;
    }
    blokusStart(b.dataset.blStart);
  }));
  el.querySelectorAll('[data-bl-cancel]').forEach((b) => b.addEventListener('click', () => blokusCancel(b.dataset.blCancel)));
  el.querySelectorAll('[data-bl-open]').forEach((b) => b.addEventListener('click', () => groupOpenBoard(b.dataset.blOpen)));
  el.querySelectorAll('[data-bl-hide]').forEach((b) => b.addEventListener('click', () => blokusHide(b.dataset.blHide)));
  el.querySelectorAll('[data-bl-rematch]').forEach((b) => b.addEventListener('click', async () => {
    const g = groupGameOf(b.dataset.blRematch);
    if (g) await blokusCreate(g.players.filter((n) => n !== currentUser.name));
  }));
}

function groupOpenBoard(gameId) {
  const g = groupGameOf(gameId);
  if (!g) return;
  openGroupId = gameId;
  gamesView = 'gboard';
  lastBoardSig = '';
  blUi = { gameId, piece: null, shape: null, at: null };
  renderGames();
}

function blSyncUi(g) {
  if (blUi.gameId !== g.id) blUi = { gameId: g.id, piece: null, shape: null, at: null };
}

// Vorschau des gewählten Stücks an der angetippten Stelle (die erste Zelle des Stücks liegt auf dem angetippten Feld)
function blGhost(g, slot) {
  if (!blUi.piece || !blUi.shape || !blUi.at) return null;
  const [tr, tc] = blUi.at;
  const [r0, c0] = blUi.shape[0];
  const size = g.size;
  const cells = blUi.shape.map(([r, c]) => [tr + (r - r0), tc + (c - c0)]);
  if (!cells.every(([r, c]) => r >= 0 && r < size && c >= 0 && c < size)) return { cells, idxs: null, problem: 'Das Stück ragt über den Rand.' };
  const idxs = cells.map(([r, c]) => r * size + c);
  const used = g['used' + slot] || [];
  return { cells, idxs, problem: blCheckMove(g.board, size, slot, idxs, used.length === 0) };
}

function blMiniPiece(name, fill) {
  const shape = blNormalize(BL_PIECES[name]);
  const w = Math.max(...shape.map((c) => c[1])) + 1;
  const h = Math.max(...shape.map((c) => c[0])) + 1;
  const on = new Set(shape.map(([r, c]) => r * w + c));
  let cells = '';
  for (let i = 0; i < w * h; i++) cells += on.has(i) ? `<i class="on" style="background:${fill}"></i>` : '<i></i>';
  return `<span class="bl-mini" style="grid-template-columns:repeat(${w}, 8px)">${cells}</span>`;
}

function renderBlokusBoard(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES[g.type].label;
  const me = currentUser.name;
  const slot = g.players.indexOf(me) + 1;
  if (slot < 1) { el.innerHTML = '<div class="games-muted">Du spielst in dieser Runde nicht mit.</div>'; return; }
  blSyncUi(g);
  const styles = groupStoneStyles(g.players);
  const isActive = g.status === 'active';
  const resigned = g.resigned || [];
  const outSlots = g.outSlots || [];
  const myTurn = isActive && g.turn === slot && !resigned.includes(slot);
  const usedList = blUsedList(g);

  // Nur neu zeichnen, wenn sich wirklich etwas geändert hat
  const sig = JSON.stringify([g.id, g.status, g.turn, g.moves, g.players, styles, resigned, outSlots, g.winners, myTurn ? blUi : null]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const size = g.size;
  const ghost = myTurn ? blGhost(g, slot) : null;
  const ghostMap = new Map();
  if (ghost) ghost.cells.forEach(([r, c]) => { if (r >= 0 && r < size && c >= 0 && c < size) ghostMap.set(r * size + c, ghost.problem ? 'bad' : 'ok'); });
  const lastSet = new Set(g.lastCells || []);
  const startMarks = new Map();
  if (isActive) g.players.forEach((_, i) => { if (usedList[i].length === 0) startMarks.set(blStartIdx(size, i + 1), i); });

  const cells = g.board.map((v, i) => {
    const classes = ['bl-cell'];
    let style = '';
    if (v) { classes.push('filled'); style = `background:${styles[v - 1].fill};--ring:${styles[v - 1].ring};`; }
    if (lastSet.has(i)) classes.push('last');
    if (!v && startMarks.has(i) && !ghostMap.has(i)) { classes.push('start'); style = `--ring:${styles[startMarks.get(i)].fill};`; }
    if (ghostMap.has(i)) { classes.push('ghost-' + ghostMap.get(i)); style += `background:${styles[slot - 1].fill};`; }
    return `<div class="${classes.join(' ')}" data-bl-cell="${i}" style="${style}"></div>`;
  }).join('');

  const chip = (idx) => {
    const n = idx + 1;
    const left = blRemainingSquares(usedList[idx]);
    const note = resigned.includes(n) ? 'aufgegeben' : (outSlots.includes(n) && isActive ? 'kann nicht mehr' : `${left} Felder`);
    return `
    <div class="c4-player ${isActive && g.turn === n ? 'turn' : ''} ${(resigned.includes(n) || (outSlots.includes(n) && isActive)) ? 'bl-out' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}<small class="ch-side">${note}</small>
    </div>`;
  };

  let status = '';
  let ranking = '';
  if (g.status === 'finished') {
    const order = g.players.map((_, i) => i + 1).sort((a, b) => (resigned.includes(a) - resigned.includes(b)) || (g.scores[b - 1] - g.scores[a - 1]));
    ranking = `<div class="bl-ranking">${order.map((s, i) => `<div class="${(g.winners || []).includes(g.players[s - 1]) ? 'win' : ''}">${i + 1}. ${coloredNameHtml(g.players[s - 1])} – ${g.scores[s - 1] > 0 ? '+' : ''}${g.scores[s - 1]} Punkte (${blRemainingSquares(usedList[s - 1])} Felder übrig)${resigned.includes(s) ? ', aufgegeben' : ''}</div>`).join('')}</div>`;
    status = (g.winners || []).length === 1
      ? `🏆 ${coloredNameHtml(g.winner)} hat gewonnen!${g.reason === 'resign' ? ' – die anderen haben aufgegeben' : ''}`
      : `🤝 Unentschieden zwischen ${joinNamesHtml(g.winners || [])}`;
  } else if (resigned.includes(slot)) {
    status = 'Du hast aufgegeben. Die anderen spielen weiter.';
  } else if (myTurn) {
    status = '<strong>Du bist dran</strong> – wähle ein Stück, tippe aufs Brett und setze es.';
  } else if (outSlots.includes(slot)) {
    status = `Du kannst kein Stück mehr legen. ${coloredNameHtml(g.players[g.turn - 1])} ist dran …`;
  } else {
    status = `${coloredNameHtml(g.players[g.turn - 1])} ist dran …`;
  }

  // Stück-Vorrat und Bedienung (nur wenn ich dran bin)
  let controls = '';
  if (myTurn) {
    const remaining = blRemaining(usedList[slot - 1]);
    const tray = remaining.map((n) => `<button class="bl-piece ${blUi.piece === n ? 'sel' : ''}" data-bl-piece="${n}" aria-label="Stück ${n}">${blMiniPiece(n, styles[slot - 1].fill)}</button>`).join('');
    let hint = 'Wähle ein Stück aus deinem Vorrat.';
    if (blUi.piece && !ghost) hint = 'Tippe aufs Brett, wohin das Stück soll (das erste Feld des Stücks liegt dort).';
    if (ghost) hint = ghost.problem ? `<span class="bl-bad">${escapeHtml(ghost.problem)}</span>` : '<span class="bl-good">Passt – tippe auf „Setzen“.</span>';
    const first = usedList[slot - 1].length === 0;
    controls = `
      <div class="games-muted" style="text-align:center;margin:10px 0 6px;">${first ? 'Dein erstes Stück muss das markierte Startfeld belegen. ' : ''}${remaining.length} Stücke im Vorrat</div>
      <div class="bl-tray">${tray}</div>
      <div class="bl-hint">${hint}</div>
      ${blUi.piece ? `<div class="bl-controls">
        <button class="btn btn-secondary btn-small" id="bl-rot">⟳ Drehen</button>
        <button class="btn btn-secondary btn-small" id="bl-flip">⇋ Spiegeln</button>
        ${ghost ? `<span class="bl-arrows"><button class="btn-icon" id="bl-left" aria-label="nach links">←</button><button class="btn-icon" id="bl-up" aria-label="nach oben">↑</button><button class="btn-icon" id="bl-down" aria-label="nach unten">↓</button><button class="btn-icon" id="bl-right" aria-label="nach rechts">→</button></span>` : ''}
        <button class="btn btn-primary btn-small" id="bl-place" ${ghost && !ghost.problem ? '' : 'disabled'}>Setzen</button>
      </div>` : ''}`;
  }

  let actions = '';
  if (isActive && !resigned.includes(slot)) actions = `<button class="btn btn-ghost btn-small" id="bl-resign-btn">Aufgeben</button>`;
  else if (g.status === 'finished') actions = `<button class="btn btn-primary btn-small" id="bl-rematch-btn">Revanche</button>`;

  el.innerHTML = `
    <div class="c4-players">${g.players.map((_, i) => chip(i)).join('')}</div>
    <div class="c4-status">${status}</div>
    ${ranking}
    <div class="bl-board" style="grid-template-columns:repeat(${size}, 1fr);">${cells}</div>
    ${controls}
    <div class="c4-actions">${actions}</div>`;

  // Bedienung
  el.querySelectorAll('[data-bl-piece]').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.blPiece;
    if (blUi.piece === name) { blUi = { gameId: g.id, piece: null, shape: null, at: null }; } else { blUi.piece = name; blUi.shape = blNormalize(BL_PIECES[name]); }
    renderGames();
  }));
  const board = el.querySelector('.bl-board');
  if (myTurn && board) board.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-bl-cell]');
    if (!cell) return;
    if (!blUi.piece) { toast('Wähle zuerst ein Stück aus deinem Vorrat.'); return; }
    const idx = parseInt(cell.dataset.blCell, 10);
    blUi.at = [Math.floor(idx / size), idx % size];
    renderGames();
  });
  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
  on('#bl-rot', () => { blUi.shape = blRotate(blUi.shape); renderGames(); });
  on('#bl-flip', () => { blUi.shape = blFlip(blUi.shape); renderGames(); });
  const nudge = (dr, dc) => () => { if (blUi.at) { blUi.at = [blUi.at[0] + dr, blUi.at[1] + dc]; renderGames(); } };
  on('#bl-left', nudge(0, -1)); on('#bl-right', nudge(0, 1)); on('#bl-up', nudge(-1, 0)); on('#bl-down', nudge(1, 0));
  on('#bl-place', async () => {
    const gh = blGhost(g, slot);
    if (!gh || gh.problem || !gh.idxs) return;
    const ok = await blokusPlay(g.id, blUi.piece, gh.idxs);
    if (ok) { blUi = { gameId: g.id, piece: null, shape: null, at: null }; renderGames(); }
  });
  on('#bl-resign-btn', () => blokusResign(g.id));
  on('#bl-rematch-btn', async () => {
    const ok = await blokusCreate(g.players.filter((n) => n !== me));
    if (ok) { gamesView = 'globby'; openGroupId = null; renderGames(); }
  });
}

// ----- Sudoku: Auswahl, Bestzeiten und Spielfeld -----
function subscribeSudoku() {
  const mine = db.collection('sudokuProgress').where('user', '==', currentUser.name).onSnapshot((snap) => {
    suProgress = {};
    snap.docs.forEach((d) => { const x = d.data(); if (x && SU_PUZZLES[x.level]) suProgress[suKey(x.level, x.idx)] = x; });
    if (gamesView === 'sudoku') renderGames();
  });
  const all = db.collection('sudokuStats').onSnapshot((snap) => {
    suStatsList = snap.docs.map((d) => d.data()).filter((x) => x && x.name);
    if (gamesView === 'sudoku') renderGames();
  });
  return () => { mine(); all(); };
}

// ----- Zeit und Speichern -----
function suStopTimer() {
  if (suUi && suUi.tickTimer) { clearInterval(suUi.tickTimer); suUi.tickTimer = null; }
}

function suStartTimer() {
  suStopTimer();
  if (suUi && !suUi.done) suUi.tickTimer = setInterval(suTick, 1000);
}

// Die Zeit läuft nur, solange das Spielfeld offen und die App sichtbar ist
function suTick() {
  if (!suUi || suUi.done || document.visibilityState !== 'visible' || gamesView !== 'sboard' || currentScreen !== 'games') return;
  suUi.seconds += 1;
  const el = document.getElementById('su-time');
  if (el) el.textContent = suFormatTime(suUi.seconds);
  if (suUi.seconds % 15 === 0) { suUi.dirty = true; suSaveSoon(); }
}

function suSaveSoon() {
  if (!suUi) return;
  clearTimeout(suUi.saveTimer);
  suUi.saveTimer = setTimeout(suSaveNow, 1200);
}

function suSaveNow() {
  if (!suUi || !suUi.dirty || suUi.done) return;
  clearTimeout(suUi.saveTimer);
  suUi.dirty = false;
  sudokuSaveProgress(suUi.level, suUi.idx, {
    grid: suUi.grid.join(''), notes: suUi.notes.slice(), seconds: suUi.seconds, hints: suUi.hints, checks: suUi.checks
  }).catch((err) => console.error('Sudoku-Stand nicht gespeichert', err));
}

// Spielfeld verlassen: Stand sichern, Zeit anhalten
function suLeave() {
  if (!suUi) return;
  suSaveNow();
  suStopTimer();
  clearTimeout(suUi.saveTimer);
  suUi = null;
}

// ----- Aufgabe öffnen / neu starten -----
function suOpen(level, idx) {
  const data = suPuzzle(level, idx);
  if (!data) return;
  suLeave();
  const key = suKey(level, idx);
  const saved = suProgress[key];
  const given = data.puzzle.map((v) => v !== 0);
  let grid = data.puzzle.slice();
  let notes = new Array(81).fill(0);
  let seconds = 0;
  let hints = 0;
  let checks = 0;
  let done = false;
  if (saved && saved.done) {
    grid = data.solution.slice();
    seconds = saved.finishedSeconds || saved.seconds || 0;
    hints = saved.hints || 0;
    done = true;
  } else if (saved && typeof saved.grid === 'string' && saved.grid.length === 81) {
    const g = Array.from(saved.grid, Number);
    if (g.every((v, i) => Number.isInteger(v) && v >= 0 && v <= 9 && (!given[i] || v === data.puzzle[i]))) grid = g;
    if (Array.isArray(saved.notes) && saved.notes.length === 81) notes = saved.notes.slice();
    seconds = saved.seconds || 0;
    hints = saved.hints || 0;
    checks = saved.checks || 0;
  }
  suUi = {
    level, idx, key, puzzle: data.puzzle, solution: data.solution, given, grid, notes, sel: -1, notesMode: false, history: [],
    seconds, hints, checks, bad: new Set(), done, msg: '', dirty: false, saveTimer: null, tickTimer: null
  };
  gamesView = 'sboard';
  lastBoardSig = '';
  renderGames();
  suStartTimer();
}

async function suRestart() {
  if (!suUi) return;
  if (!suUi.done) {
    const ok = await confirmModal('Neu starten?', 'Alle deine Eingaben und die Zeit dieser Aufgabe gehen verloren.', 'Neu starten');
    if (!ok) return;
  }
  const { level, idx, puzzle } = suUi;
  const ui = suUi;
  ui.grid = puzzle.slice(); ui.notes = new Array(81).fill(0); ui.history = []; ui.bad = new Set(); ui.sel = -1;
  ui.seconds = 0; ui.hints = 0; ui.checks = 0; ui.done = false; ui.msg = ''; ui.dirty = false;
  sudokuSaveProgress(level, idx, { grid: puzzle.join(''), notes: new Array(81).fill(0), seconds: 0, hints: 0, checks: 0, done: false })
    .catch((err) => console.error('Sudoku-Stand nicht gespeichert', err));
  suStartTimer();
  lastBoardSig = '';
  renderGames();
}

// ----- Eingaben -----
function suPush() {
  suUi.history.push({ grid: suUi.grid.slice(), notes: suUi.notes.slice() });
  if (suUi.history.length > 300) suUi.history.shift();
}

function suAfterChange() {
  const ui = suUi;
  ui.dirty = true;
  suSaveSoon();
  if (suEmptyCount(ui.grid) === 0) {
    if (suErrors(ui.grid, ui.solution).length === 0) { suFinishPuzzle(); return; }
    ui.msg = 'Alle Felder sind gefüllt, aber nicht alles stimmt. Tippe auf „Prüfen“.';
  } else if (/Alle Felder sind gefüllt/.test(ui.msg)) {
    ui.msg = '';
  }
  renderGames();
}

function suFinishPuzzle() {
  const ui = suUi;
  ui.done = true;
  ui.msg = '';
  ui.bad = new Set();
  ui.sel = -1;
  suStopTimer();
  clearTimeout(ui.saveTimer);
  ui.dirty = false;
  renderGames();
  sudokuFinish(ui.level, ui.idx, ui.seconds, ui.hints);
}

function suPlace(d) {
  const ui = suUi;
  if (!ui || ui.done || ui.sel < 0 || ui.given[ui.sel]) return;
  suPush();
  const i = ui.sel;
  if (ui.notesMode) {
    if (ui.grid[i] === 0) ui.notes[i] ^= (1 << d);
  } else if (ui.grid[i] === d) {
    ui.grid[i] = 0;
  } else {
    ui.grid[i] = d;
    ui.notes[i] = 0;
    SU_PEERS[i].forEach((p) => { ui.notes[p] &= ~(1 << d); });   // gesetzte Zahl aus den Notizen der Nachbarfelder streichen
  }
  ui.bad.delete(i);
  suAfterChange();
}

function suClear() {
  const ui = suUi;
  if (!ui || ui.done || ui.sel < 0 || ui.given[ui.sel]) return;
  const i = ui.sel;
  if (ui.grid[i] === 0 && ui.notes[i] === 0) return;
  suPush();
  ui.grid[i] = 0;
  ui.notes[i] = 0;
  ui.bad.delete(i);
  suAfterChange();
}

function suUndo() {
  const ui = suUi;
  if (!ui || ui.done || !ui.history.length) return;
  const prev = ui.history.pop();
  ui.grid = prev.grid;
  ui.notes = prev.notes;
  ui.bad = new Set();
  ui.msg = '';
  ui.dirty = true;
  suSaveSoon();
  renderGames();
}

// Alle Markierungen weg: keine Auswahl, keine Hervorhebung von Zeile/Spalte/Block/gleichen Zahlen, keine roten Prüf-Markierungen
function suDeselect() {
  const ui = suUi;
  if (!ui) return;
  ui.sel = -1;
  ui.bad = new Set();
  renderGames();
}

// Prüfen (nur auf Knopfdruck): falsche Felder werden rot markiert
function suCheck() {
  const ui = suUi;
  if (!ui || ui.done) return;
  ui.checks += 1;
  const wrong = suErrors(ui.grid, ui.solution);
  ui.bad = new Set(wrong);
  const empty = suEmptyCount(ui.grid);
  if (wrong.length) ui.msg = `${wrong.length} ${wrong.length === 1 ? 'Feld ist' : 'Felder sind'} falsch (rot markiert).`;
  else ui.msg = empty ? `Bisher ist alles richtig – noch ${empty} ${empty === 1 ? 'Feld' : 'Felder'} offen.` : '';
  ui.dirty = true;
  suSaveSoon();
  renderGames();
}

// Tipp: zeigt den nächsten sinnvollen Schritt; Läufe mit Tipp zählen nicht für die Bestzeit
function suGiveHint() {
  const ui = suUi;
  if (!ui || ui.done) return;
  const h = suHint(ui.grid, ui.solution);
  if (h.type === 'error') {
    ui.msg = 'Im Gitter ist ein Fehler. Tippe auf „Prüfen“, dann siehst du, welche Felder nicht stimmen.';
  } else if (h.type !== 'none') {
    ui.hints += 1;
    ui.sel = h.cell;
    if (h.type === 'naked') ui.msg = `Tipp: Im markierten Feld passt nur noch die ${h.value}, alle anderen Zahlen stehen schon in der Zeile, der Spalte oder im Block.`;
    else if (h.type === 'hidden') ui.msg = `Tipp: ${h.unit === 'Zeile' ? 'In dieser Zeile' : (h.unit === 'Spalte' ? 'In dieser Spalte' : 'In diesem Block')} passt die ${h.value} nur noch in das markierte Feld.`;
    else {
      suPush();
      ui.grid[h.cell] = h.value;
      ui.notes[h.cell] = 0;
      SU_PEERS[h.cell].forEach((p) => { ui.notes[p] &= ~(1 << h.value); });
      ui.msg = `Tipp: Ein Feld wurde verraten – im markierten Feld steht die ${h.value}.`;
      suAfterChange();
      return;
    }
  }
  ui.dirty = true;
  suSaveSoon();
  renderGames();
}

// ----- Anzeige: Auswahl der Aufgaben -----
function suLevelStatsRows(levelKey) {
  const rows = suStatsList
    .map((x) => ({ name: x.name, ...(((x.levels || {})[levelKey]) || { best: 0, bestIdx: -1, solved: 0 }) }))
    .filter((r) => r.solved > 0 || r.best > 0);
  return rows.sort((a, b) => ((a.best > 0 ? 0 : 1) - (b.best > 0 ? 0 : 1)) || (a.best - b.best) || (b.solved - a.solved) || a.name.localeCompare(b.name));
}

function renderSudokuMenu(el, titleEl) {
  titleEl.textContent = 'Sudoku';
  const lv = SU_LEVELS.find((l) => l.key === suLevelSel) || SU_LEVELS[0];
  const list = SU_PUZZLES[lv.key];
  const states = list.map((_, i) => {
    const p = suProgress[suKey(lv.key, i)];
    if (!p) return 'new';
    if (p.solvedOnce) return 'done';
    return (p.seconds > 0 || (typeof p.grid === 'string' && p.grid !== list[i].split(':')[0])) ? 'started' : 'new';
  });
  const solved = states.filter((s) => s === 'done').length;
  const chips = SU_LEVELS.map((l) => `<button class="sh-chip ${l.key === lv.key ? 'sel' : ''}" data-su-level="${l.key}">${l.label}</button>`).join('');
  const picks = states.map((s, i) => `<button class="su-pick ${s}" data-su-open="${i}" aria-label="Aufgabe ${i + 1}${s === 'done' ? ', gelöst' : (s === 'started' ? ', angefangen' : '')}">${i + 1}</button>`).join('');
  const rows = suLevelStatsRows(lv.key);
  const me = currentUser.name;
  const mine = rows.find((r) => r.name === me);
  const table = rows.length
    ? `<table class="games-table"><thead><tr><th>#</th><th>Spieler</th><th class="mid">Bestzeit</th><th class="mid">Gelöst</th></tr></thead><tbody>${rows.map((r, i) => `
        <tr><td>${i + 1}</td><td>${coloredNameHtml(r.name)}</td><td class="mid">${r.best > 0 ? `${suFormatTime(r.best)}<small>Aufgabe ${r.bestIdx + 1}</small>` : '–'}</td><td class="mid">${r.solved}</td></tr>`).join('')}</tbody></table>`
    : '<div class="games-muted">Noch niemand hat eine Aufgabe dieser Stufe gelöst.</div>';
  el.innerHTML = `
    <div class="sh-chips">${chips}</div>
    <div class="games-muted" style="text-align:center;margin-bottom:8px;">${escapeHtml(lv.label)}: ${solved} von ${list.length} gelöst${mine && mine.best > 0 ? ` · deine Bestzeit ${suFormatTime(mine.best)}` : ''}</div>
    <div class="su-picks">${picks}</div>
    <div class="games-muted" style="margin-top:8px;text-align:center;">✓ gelöst · ◐ angefangen. Aufgaben mit Tipp zählen nicht für die Bestzeit.</div>
    <div class="games-section-title">Bestzeiten – ${escapeHtml(lv.label)}</div>
    ${table}`;
  el.querySelectorAll('[data-su-level]').forEach((b) => b.addEventListener('click', () => { suLevelSel = b.dataset.suLevel; renderGames(); }));
  el.querySelectorAll('[data-su-open]').forEach((b) => b.addEventListener('click', () => suOpen(lv.key, parseInt(b.dataset.suOpen, 10))));
}

// ----- Anzeige: Spielfeld -----
function renderSudokuBoard(el, titleEl) {
  const ui = suUi;
  const lv = SU_LEVELS.find((l) => l.key === ui.level);
  titleEl.textContent = `Sudoku · ${lv.label} ${ui.idx + 1}`;
  const sig = JSON.stringify([ui.key, ui.grid, ui.notes, ui.sel, ui.notesMode, [...ui.bad], ui.done, ui.msg, ui.hints, ui.checks, ui.history.length]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const sel = ui.sel;
  const selVal = sel >= 0 ? ui.grid[sel] : 0;
  const peerSet = sel >= 0 ? new Set(SU_PEERS[sel]) : null;
  const myColor = (usersMap[currentUser.name.toLowerCase()] && userColor(usersMap[currentUser.name.toLowerCase()], 'color')) || '';
  const cells = ui.grid.map((v, i) => {
    const r = Math.floor(i / 9);
    const c = i % 9;
    const cls = ['su-cell'];
    if (ui.given[i]) cls.push('given');
    if (i === sel) cls.push('sel'); else if (peerSet && peerSet.has(i)) cls.push('peer');
    if (selVal && v === selVal && i !== sel) cls.push('same');
    if (ui.bad.has(i)) cls.push('bad');
    if (c === 2 || c === 5) cls.push('bR');
    if (r === 2 || r === 5) cls.push('bB');
    let inner = '';
    if (v) inner = String(v);
    else if (ui.notes[i]) inner = `<span class="su-notes">${Array.from({ length: 9 }, (_, k) => `<i>${ui.notes[i] & (1 << (k + 1)) ? k + 1 : ''}</i>`).join('')}</span>`;
    const style = (!ui.given[i] && v && myColor) ? ` style="color:${myColor};"` : '';
    return `<button class="${cls.join(' ')}" data-su-cell="${i}"${style} aria-label="Zeile ${r + 1}, Spalte ${c + 1}${v ? ', ' + v : ''}">${inner}</button>`;
  }).join('');

  const counts = new Array(10).fill(0);
  ui.grid.forEach((v) => { counts[v] += 1; });
  const pad = Array.from({ length: 9 }, (_, k) => {
    const d = k + 1;
    const left = Math.max(0, 9 - counts[d]);
    return `<button class="su-num" data-su-num="${d}" ${(ui.done || left === 0) && !ui.notesMode ? 'disabled' : ''}>${d}<small>${left}</small></button>`;
  }).join('');

  const nextIdx = ui.idx + 1 < SU_PUZZLES[ui.level].length ? ui.idx + 1 : -1;
  const banner = ui.done
    ? `<div class="game-card tn-winner">🎉 Geschafft in ${suFormatTime(ui.seconds)}!${ui.hints ? ` Mit ${ui.hints} ${ui.hints === 1 ? 'Tipp' : 'Tipps'} – das zählt nicht für die Bestzeit.` : ' Die Zeit zählt für die Bestzeiten.'}</div>`
    : '';
  const controls = ui.done
    ? `<div class="c4-actions">${nextIdx >= 0 ? '<button class="btn btn-primary btn-small" id="su-next-btn">Nächste Aufgabe</button>' : ''}
         <button class="btn btn-secondary btn-small" id="su-restart-btn">Noch einmal</button></div>`
    : `<div class="su-pad">${pad}</div>
       <div class="su-tools">
         <button class="btn btn-secondary btn-small" id="su-desel-btn" ${ui.sel < 0 && ui.bad.size === 0 ? 'disabled' : ''}>◌ Markierung aus</button>
         <button class="btn btn-secondary btn-small ${ui.notesMode ? 'su-on' : ''}" id="su-notes-btn" aria-pressed="${ui.notesMode}">✎ Notiz ${ui.notesMode ? 'an' : 'aus'}</button>
         <button class="btn btn-secondary btn-small" id="su-undo-btn" ${ui.history.length ? '' : 'disabled'}>↶ Rückgängig</button>
         <button class="btn btn-secondary btn-small" id="su-clear-btn">⌫ Löschen</button>
         <button class="btn btn-primary btn-small" id="su-check-btn">Prüfen</button>
         <button class="btn btn-secondary btn-small" id="su-hint-btn">💡 Tipp</button>
       </div>
       <div class="c4-actions"><button class="btn btn-ghost btn-small" id="su-restart-btn">Neu starten</button></div>`;

  el.innerHTML = `
    <div class="su-top"><span>Zeit <strong id="su-time">${suFormatTime(ui.seconds)}</strong></span><span>Tipps ${ui.hints}</span><span>Prüfungen ${ui.checks}</span></div>
    ${banner}
    <div class="su-msg">${ui.msg ? escapeHtml(ui.msg) : '&nbsp;'}</div>
    <div class="su-board">${cells}</div>
    ${controls}`;

  const board = el.querySelector('.su-board');
  board.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-su-cell]');
    if (!cell) return;
    ui.sel = parseInt(cell.dataset.suCell, 10);
    renderGames();
  });
  el.querySelectorAll('[data-su-num]').forEach((b) => b.addEventListener('click', () => suPlace(parseInt(b.dataset.suNum, 10))));
  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
  on('#su-desel-btn', suDeselect);
  on('#su-notes-btn', () => { ui.notesMode = !ui.notesMode; renderGames(); });
  on('#su-undo-btn', suUndo);
  on('#su-clear-btn', suClear);
  on('#su-check-btn', suCheck);
  on('#su-hint-btn', suGiveHint);
  on('#su-restart-btn', suRestart);
  on('#su-next-btn', () => suOpen(ui.level, nextIdx));
}

// Tastatur (am Computer): 1-9 setzen, Entf/Rücktaste löschen, Pfeiltasten bewegen
document.addEventListener('keydown', (e) => {
  if (!suUi || gamesView !== 'sboard' || currentScreen !== 'games' || suUi.done) return;
  if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
  if (e.key >= '1' && e.key <= '9') { suPlace(parseInt(e.key, 10)); e.preventDefault(); return; }
  if (e.key === 'Escape') { suDeselect(); e.preventDefault(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { suClear(); e.preventDefault(); return; }
  const move = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
  if (move) {
    const cur = suUi.sel < 0 ? 0 : suUi.sel;
    const r = Math.min(8, Math.max(0, Math.floor(cur / 9) + move[0]));
    const c = Math.min(8, Math.max(0, (cur % 9) + move[1]));
    suUi.sel = r * 9 + c;
    renderGames();
    e.preventDefault();
  }
});

// App im Hintergrund: Stand sichern (die Zeit läuft dann nicht weiter)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') suSaveNow();
});

function bindResignAndRematch(el, g, myIdx) {
  const resignBtn = el.querySelector('#g-resign-btn');
  if (resignBtn) resignBtn.addEventListener('click', () => gameResign(g.id));
  const rematchBtn = el.querySelector('#g-rematch-btn');
  if (rematchBtn) {
    rematchBtn.addEventListener('click', async () => {
      const opp = g.players[myIdx === 0 ? 1 : 0];
      const ok = await gameChallenge(gameTypeOf(g), opp);
      if (ok) { gamesView = 'lobby'; openGameId = null; chSel = null; renderGames(); }
    });
  }
}

// ----- Schach: Spielbrett -----
const CH_GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const CH_PROMO_LABELS = { q: 'Dame', r: 'Turm', b: 'Läufer', n: 'Springer' };
const CH_REASONS = {
  checkmate: 'Schachmatt', resign: 'Aufgabe', stalemate: 'Patt', insufficient: 'zu wenig Material',
  repetition: 'dreifache Stellungswiederholung', agreement: 'Einigung'
};

// Alle Figuren werden mit den "ausgefüllten" Symbolen gezeichnet und in der Farbe des Spielers eingefärbt.
// \uFE0E erzwingt die Textdarstellung (sonst zeigen manche Handys den Bauern als Emoji ohne Farbe).
function chGlyph(piece) {
  return CH_GLYPHS[piece.toLowerCase()] + '\uFE0E';
}

function renderChessBoard(el, titleEl, g) {
  titleEl.textContent = GAME_TYPES.chess.label;
  const myIdx = gamePlayerIndex(g, currentUser.name);
  const styles = gameStoneStyles(g);
  const isActive = g.status === 'active';
  const myTurn = isActive && myIdx >= 0 && g.turn === myIdx + 1;
  const state = { board: g.board, turn: g.turn, castling: g.castling || '', ep: Number.isInteger(g.ep) ? g.ep : -1 };

  // Eine Auswahl gilt nur, solange sich die Stellung nicht geändert hat und ich am Zug bin
  if (chSel && (chSel.gameId !== g.id || chSel.moves !== (g.moves || 0) || !myTurn)) chSel = null;

  const sig = JSON.stringify([g.id, g.status, g.turn, g.moves, g.winner, g.reason, g.drawOffer, g.players, styles, chSel]);
  if (sig === lastBoardSig) return;
  lastBoardSig = sig;

  const legal = myTurn ? chLegalMoves(state) : [];
  const targets = new Map();                       // Zielfeld -> true, wenn dort geschlagen wird
  if (chSel) legal.filter((m) => m.from === chSel.from).forEach((m) => targets.set(m.to, g.board[m.to] !== '' || m.flag === 'ep'));

  let checkKing = -1;
  if (g.status === 'finished' && g.reason === 'checkmate') checkKing = chKingSquare(g.board, g.winner === 2);
  else if (isActive && chInCheck(g.board, g.turn === 1)) checkKing = chKingSquare(g.board, g.turn === 1);

  const flipped = myIdx === 1;                     // Schwarz sieht das Brett von seiner Seite
  let squares = '';
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const r = flipped ? 7 - i : i;
      const c = flipped ? 7 - j : j;
      const idx = r * 8 + c;
      const p = g.board[idx];
      const classes = ['ch-sq', (r + c) % 2 === 0 ? 'light' : 'dark'];
      if (idx === g.lastFrom || idx === g.lastTo) classes.push('last');
      if (idx === checkKing) classes.push('check');
      if (chSel && chSel.from === idx) classes.push('sel');
      if (targets.has(idx)) classes.push(targets.get(idx) ? 'cap' : 'dot');
      const piece = p ? `<span class="ch-piece" style="color:${chIsWhite(p) ? styles[0].fill : styles[1].fill}">${chGlyph(p)}</span>` : '';
      squares += `<div class="${classes.join(' ')}" data-ch-sq="${idx}">${piece}</div>`;
    }
  }

  const chip = (idx) => `
    <div class="c4-player ${isActive && g.turn === idx + 1 ? 'turn' : ''}">
      <span class="c4-dot" style="background:${styles[idx].fill};--ring:${styles[idx].ring};"></span>${coloredNameHtml(g.players[idx])}<small class="ch-side">${idx === 0 ? 'Weiß' : 'Schwarz'}</small>
    </div>`;

  let status = '';
  if (g.status === 'finished') {
    const why = CH_REASONS[g.reason] || '';
    status = g.winner === 0
      ? `🤝 Remis${why ? ' – ' + why : ''}`
      : `🏆 ${coloredNameHtml(g.players[g.winner - 1])} hat gewonnen!${why ? ' (' + why + ')' : ''}`;
  } else {
    const check = checkKing >= 0 ? '<strong>Schach!</strong> ' : '';
    if (myTurn) status = check + '<strong>Du bist dran</strong>';
    else if (isActive) status = check + `${coloredNameHtml(g.players[g.turn - 1])} ist dran …`;
  }

  let promoHtml = '';
  if (chSel && chSel.promoTo !== null && chSel.promoTo !== undefined) {
    const color = styles[myIdx].fill;
    promoHtml = `<div class="ch-promo"><span class="games-muted">Umwandeln in:</span>
      ${['q', 'r', 'b', 'n'].map((k) => `<button class="btn btn-secondary btn-small" data-ch-promo="${k}"><span style="color:${color};font-size:1.2rem;">${chGlyph(k)}</span> ${CH_PROMO_LABELS[k]}</button>`).join('')}
      <button class="btn btn-ghost btn-small" id="ch-promo-cancel">Abbrechen</button></div>`;
  }

  let banner = '';
  let actions = '';
  if (isActive && myIdx >= 0) {
    if (g.drawOffer && g.drawOffer !== myIdx + 1) {
      banner = `<div class="ch-banner">🤝 ${coloredNameHtml(g.players[g.drawOffer - 1])} bietet Remis an
        <div class="c4-actions" style="margin-top:8px;"><button class="btn btn-primary btn-small" id="ch-draw-accept">Annehmen</button>
        <button class="btn btn-secondary btn-small" id="ch-draw-decline">Ablehnen</button></div></div>`;
      actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
    } else if (g.drawOffer) {
      banner = `<div class="ch-banner">🤝 Remis angeboten – warte auf Antwort
        <div class="c4-actions" style="margin-top:8px;"><button class="btn btn-secondary btn-small" id="ch-draw-withdraw">Zurückziehen</button></div></div>`;
      actions = `<button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
    } else {
      actions = `<button class="btn btn-secondary btn-small" id="ch-draw-offer">Remis anbieten</button>
                 <button class="btn btn-ghost btn-small" id="g-resign-btn">Aufgeben</button>`;
    }
  } else if (g.status === 'finished' && myIdx >= 0 && !g.tournamentId) {
    actions = `<button class="btn btn-primary btn-small" id="g-rematch-btn">Revanche</button>`;
  }

  el.innerHTML = `
    <div class="c4-players">${chip(0)}<span class="c4-vs">gegen</span>${chip(1)}</div>
    <div class="c4-status">${status}</div>
    <div class="ch-board">${squares}</div>
    ${promoHtml}
    ${banner}
    <div class="c4-actions">${actions}</div>`;

  el.querySelectorAll('[data-ch-sq]').forEach((sq) => sq.addEventListener('click', () => chessSquareClick(g, myIdx, legal, parseInt(sq.dataset.chSq, 10))));
  el.querySelectorAll('[data-ch-promo]').forEach((b) => b.addEventListener('click', () => {
    const sel = chSel;
    chSel = null;
    chessPlayMove(g.id, sel.from, sel.promoTo, b.dataset.chPromo);
  }));
  const cancel = el.querySelector('#ch-promo-cancel');
  if (cancel) cancel.addEventListener('click', () => { chSel = null; renderGames(); });
  const on = (id, fn) => { const b = el.querySelector(id); if (b) b.addEventListener('click', fn); };
  on('#ch-draw-offer', () => chessOfferDraw(g.id));
  on('#ch-draw-accept', () => chessAnswerDraw(g.id, true));
  on('#ch-draw-decline', () => chessAnswerDraw(g.id, false));
  on('#ch-draw-withdraw', () => chessWithdrawDraw(g.id));
  bindResignAndRematch(el, g, myIdx);
}

// Tippen auf ein Feld: eigene Figur auswählen -> Zielfeld antippen (bei Umwandlung danach die Figur wählen)
function chessSquareClick(g, myIdx, legal, idx) {
  if (!legal.length) return;
  if (chSel && chSel.promoTo !== null && chSel.promoTo !== undefined) return;   // erst die Umwandlung wählen
  if (chSel) {
    const cand = legal.filter((m) => m.from === chSel.from && m.to === idx);
    if (cand.length) {
      if (cand[0].promo) {
        chSel = { ...chSel, promoTo: idx };
        renderGames();
        return;
      }
      const from = chSel.from;
      chSel = null;
      chessPlayMove(g.id, from, idx);
      return;
    }
  }
  const p = g.board[idx];
  const mine = p !== '' && chIsWhite(p) === (myIdx === 0);
  if (mine && legal.some((m) => m.from === idx) && !(chSel && chSel.from === idx)) {
    chSel = { gameId: g.id, moves: g.moves || 0, from: idx, promoTo: null };
  } else {
    chSel = null;
  }
  renderGames();
}

// Zurück-Knopf: Brett -> Übersicht des Spiels -> Spiele-Menü -> Startseite
document.getElementById('games-back-btn').addEventListener('click', () => {
  if (gamesView === 'sboard') { suLeave(); gamesView = 'sudoku'; }
  else if (gamesView === 'sudoku') { gamesView = 'menu'; }
  else if (gamesView === 'gboard') { gamesView = 'globby'; openGroupId = null; }
  else if (gamesView === 'globby') { gamesView = 'menu'; }
  else if (gamesView === 'board') { gamesView = openTournamentId ? 'tournament' : 'lobby'; openGameId = null; chSel = null; }
  else if (gamesView === 'tournament') { gamesView = 'menu'; openTournamentId = null; }
  else if (gamesView === 'lobby') { gamesView = 'menu'; }
  else { showScreen('home'); return; }
  renderGames();
});

// <GAMES-END>

// ==========================================================
// GYM (Spezial Kalender) — Trainingstage pro Nutzer
// Alex legt fest, wer den Reiter sieht + die Zieltage pro Monat.
// Jeder sieht nur seinen eigenen Kalender, Alex alle freigegebenen.
// ==========================================================

let gymSettings = { allowedUsers: [], targets: {} }; // targets: lowercase username -> Zieltage (1-31)
let gymDaysMap = {};     // lowercase username -> array of 'YYYY-MM-DD'
let gymMonthState = {};  // lowercase username -> { year, month }

function subscribeGymSettings() {
  return db.collection('config').doc('gymSettings').onSnapshot((doc) => {
    const data = doc.exists ? doc.data() : {};
    gymSettings = {
      allowedUsers: Array.isArray(data.allowedUsers) ? data.allowedUsers : [],
      targets: (data.targets && typeof data.targets === 'object') ? data.targets : {}
    };
    updateGymVisibility();
    renderGym();
    renderSpezialKalender();
  });
}

function subscribeGymDays() {
  return db.collection('gymDays').onSnapshot((snap) => {
    const map = {};
    snap.forEach((doc) => { map[doc.id.toLowerCase()] = doc.data().dates || []; });
    gymDaysMap = map;
    renderGym();
  });
}

function gymAllowedLower() {
  return (gymSettings.allowedUsers || []).map((n) => n.toLowerCase());
}

// Der Reiter ist für alle versteckt, bis jemand freigegeben ist.
// Sichtbar für freigegebene Nutzer – und für Alex, sobald mindestens eine Person freigegeben ist.
function gymAccessForCurrentUser() {
  if (!currentUser) return false;
  const allowed = gymAllowedLower();
  return allowed.includes(currentUser.name.toLowerCase()) || (isAdmin(currentUser.name) && allowed.length > 0);
}

function updateGymVisibility() {
  const btn = document.getElementById('gym-tab-btn');
  if (!btn) return;
  const hasAccess = gymAccessForCurrentUser();
  btn.style.display = hasAccess ? '' : 'none';
  if (!hasAccess && document.getElementById('aktuell-panel-gym').classList.contains('active')) {
    document.querySelector('[data-tab="aktuell-panel-chat"]').click();
  }
}

function gymVisibleUsers() {
  const allowed = gymAllowedLower();
  let users = Object.values(usersMap).filter((u) => allowed.includes(u.name.toLowerCase()));
  if (!isAdmin(currentUser.name)) {
    users = users.filter((u) => u.name.toLowerCase() === currentUser.name.toLowerCase());
  }
  return users.sort((a, b) => a.name.localeCompare(b.name));
}

function gymTargetFor(user) {
  const t = (gymSettings.targets || {})[user.name.toLowerCase()];
  return Number.isInteger(t) ? t : null;
}

function gymCountForMonth(dates, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  return dates.filter((d) => d.startsWith(prefix)).length;
}

function buildGymGridHtml(userName, year, month, dateSet) {
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let cells = WEEKDAY_LABELS_DE.map((d) => `<div class="cal-weekday">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const trained = dateSet.has(dateStr);
    const isToday = dateStr === today;
    cells += `<div class="cal-cell ${trained ? 'trained' : ''} ${isToday ? 'today' : ''}" data-gym-day="${dateStr}" data-gym-user="${escapeHtml(userName)}">${day}</div>`;
  }
  return `<div class="cal-grid-wrap"><div class="cal-grid">${cells}</div></div>`;
}

function renderGym() {
  const el = document.getElementById('gym-calendars');
  if (!el || !currentUser) return;
  const users = gymVisibleUsers();
  if (!users.length) {
    el.innerHTML = `<div class="empty-state"><span class="emoji">🏋️</span>Noch kein Kalender freigegeben.</div>`;
    return;
  }

  el.innerHTML = users.map((u) => {
    const key = u.name.toLowerCase();
    const target = gymTargetFor(u);
    if (!gymMonthState[key]) {
      const now = new Date();
      gymMonthState[key] = { year: now.getFullYear(), month: now.getMonth() };
    }
    const { year, month } = gymMonthState[key];
    const dates = gymDaysMap[key] || [];
    const count = gymCountForMonth(dates, year, month);
    const nameColor = userColor(u, 'color') || 'inherit';
    const borderColor = userColor(u, 'border') || 'transparent';

    let missingHtml = `<span class="gym-num">–</span>`;
    if (target) {
      const missing = target - count;
      missingHtml = `<span class="gym-num ${missing > 0 ? 'bad' : 'good'}">${missing}</span>`;
    }

    return `
      <div class="user-sick-card" style="border-color:${borderColor}">
        <div class="cal-header">
          <button class="cal-nav-btn" data-gym-prev="${escapeHtml(u.name)}">‹</button>
          <span class="cal-title" style="color:${nameColor}">${escapeHtml(u.name)} — ${MONTH_LABELS_DE[month]} ${year}</span>
          <button class="cal-nav-btn" data-gym-next="${escapeHtml(u.name)}">›</button>
        </div>
        ${buildGymGridHtml(u.name, year, month, new Set(dates))}
        <div class="gym-stats">
          <div>Zieltage: <strong>${target ? target : '–'}</strong></div>
          <div>Trainingstage: <strong>${count}</strong></div>
          <div>Fehlende Trainingstage: ${missingHtml}</div>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-gym-prev]').forEach((btn) => {
    btn.addEventListener('click', () => shiftGymMonth(btn.dataset.gymPrev, -1));
  });
  el.querySelectorAll('[data-gym-next]').forEach((btn) => {
    btn.addEventListener('click', () => shiftGymMonth(btn.dataset.gymNext, 1));
  });
  el.querySelectorAll('[data-gym-day]').forEach((cell) => {
    cell.addEventListener('click', () => toggleGymDay(cell.dataset.gymUser, cell.dataset.gymDay));
  });
}

function shiftGymMonth(userName, delta) {
  const key = userName.toLowerCase();
  let { year, month } = gymMonthState[key];
  month += delta;
  if (month < 0) { month = 11; year -= 1; }
  if (month > 11) { month = 0; year += 1; }
  gymMonthState[key] = { year, month };
  renderGym();
}

async function toggleGymDay(userName, dateStr) {
  // Normale Nutzer dürfen nur ihren eigenen Kalender ändern, Alex alle sichtbaren.
  if (!isAdmin(currentUser.name) && userName.toLowerCase() !== currentUser.name.toLowerCase()) return;
  const ref = db.collection('gymDays').doc(userName);
  const current = gymDaysMap[userName.toLowerCase()] || [];
  try {
    if (current.includes(dateStr)) await ref.set({ dates: FieldValue.arrayRemove(dateStr) }, { merge: true });
    else await ref.set({ dates: FieldValue.arrayUnion(dateStr) }, { merge: true });
  } catch (err) {
    console.error(err);
    toast('Fehler beim Speichern: ' + err.message);
  }
}

// Beim Öffnen des Reiters: Ansicht auf den aktuellen Monat zurücksetzen, ggf. Hantel-Konfetti.
function onGymTabOpened() {
  gymMonthState = {};
  renderGym();
  checkGymConfetti();
}

function checkGymConfetti() {
  const now = new Date();
  const reached = gymVisibleUsers().some((u) => {
    const target = gymTargetFor(u);
    if (!target) return false;
    const count = gymCountForMonth(gymDaysMap[u.name.toLowerCase()] || [], now.getFullYear(), now.getMonth());
    return (target - count) <= 0;
  });
  if (reached) launchEmojiConfetti('🏋️', 40);
}

function launchEmojiConfetti(emoji, count) {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece confetti-emoji';
    piece.textContent = emoji;
    piece.style.left = Math.random() * 95 + 'vw';
    piece.style.fontSize = (18 + Math.random() * 16) + 'px';
    piece.style.animationDelay = (Math.random() * 0.8) + 's';
    piece.style.animationDuration = (2.8 + Math.random() * 1.6) + 's';
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 5500);
}

// ---------- Spezial Kalender (Einstellungen, nur Alex) ----------
function renderSpezialKalender() {
  const listEl = document.getElementById('spezial-gym-users');
  if (!listEl) return;

  // Bereits eingetippte, noch nicht gespeicherte Werte beim Neuzeichnen nicht verlieren
  const typed = {};
  listEl.querySelectorAll('[data-gym-target]').forEach((inp) => { typed[inp.dataset.gymTarget] = inp.value; });

  const allowed = gymAllowedLower();
  const users = Object.values(usersMap).sort((a, b) => a.name.localeCompare(b.name));
  listEl.innerHTML = users.map((u) => {
    const color = userColor(u, 'color');
    const stored = gymTargetFor(u);
    const value = Object.prototype.hasOwnProperty.call(typed, u.name) ? typed[u.name] : (stored ? stored : '');
    return `
      <div class="gym-user-row">
        <div class="gym-user-top">
          <label style="${color ? `color:${color};font-weight:600;` : ''}">${escapeHtml(u.name)}</label>
          <label class="gym-allow-label">Freigeben
            <input type="checkbox" data-gym-allow="${escapeHtml(u.name)}" ${allowed.includes(u.name.toLowerCase()) ? 'checked' : ''}>
          </label>
        </div>
        <div class="gym-user-target">
          <label>Zieltage pro Monat</label>
          <input type="number" min="1" max="31" step="1" placeholder="1–31" data-gym-target="${escapeHtml(u.name)}" value="${value}">
          <button class="btn-icon" data-gym-target-save="${escapeHtml(u.name)}" title="Speichern">✓</button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-gym-allow]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const name = cb.dataset.gymAllow;
      const ref = db.collection('config').doc('gymSettings');
      const op = e.target.checked ? FieldValue.arrayUnion(name) : FieldValue.arrayRemove(name);
      ref.set({ allowedUsers: op }, { merge: true });
    });
  });

  listEl.querySelectorAll('[data-gym-target-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveGymTarget(btn.dataset.gymTargetSave));
  });
  listEl.querySelectorAll('[data-gym-target]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveGymTarget(inp.dataset.gymTarget); });
  });
}

async function saveGymTarget(userName) {
  const input = document.querySelector(`[data-gym-target="${CSS.escape(userName)}"]`);
  if (!input) return;
  const raw = input.value.trim();
  const key = userName.toLowerCase();
  const ref = db.collection('config').doc('gymSettings');
  try {
    if (raw === '') {
      // Feld leer = Zieltage für diese Person wieder entfernen
      await ref.set({ targets: { [key]: FieldValue.delete() } }, { merge: true });
      toast(`Zieltage für ${userName} entfernt.`);
      return;
    }
    const value = parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1 || value > 31) {
      toast('Bitte eine Zahl zwischen 1 und 31 eingeben.');
      return;
    }
    await ref.set({ targets: { [key]: value } }, { merge: true });
    toast(`Zieltage für ${userName} gespeichert.`);
  } catch (err) {
    console.error(err);
    toast('Fehler beim Speichern: ' + err.message);
  }
}

// ==========================================================
// KRANK (sick days) — Admin manages, shown on Startseite
// ==========================================================

let sickDaysMap = {};      // lowercase username -> array of 'YYYY-MM-DD'
let sickSettings = { showToday: false, showStats: false };
let calendarMonthState = {}; // lowercase username -> { year, month(0-11) }
let sickCalendarOrder = []; // array of usernames, admin-defined display order

const WEEKDAY_LABELS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_LABELS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function subscribeSickDays() {
  return db.collection('sickDays').onSnapshot((snap) => {
    const map = {};
    snap.forEach((doc) => { map[doc.id.toLowerCase()] = (doc.data().dates || []); });
    sickDaysMap = map;
    renderHomeSickToday();
    renderHomeSickStats();
    if (isAdmin(currentUser.name)) renderAdminSickCalendars();
  });
}

function subscribeSickSettings() {
  return db.collection('config').doc('sickSettings').onSnapshot((doc) => {
    sickSettings = doc.exists ? { showToday: !!doc.data().showToday, showStats: !!doc.data().showStats } : { showToday: false, showStats: false };
    document.getElementById('admin-sick-today-toggle').checked = sickSettings.showToday;
    document.getElementById('admin-sick-stats-toggle').checked = sickSettings.showStats;
    renderHomeSickToday();
    renderHomeSickStats();
  });
}

function subscribeSickCalendarOrder() {
  return db.collection('config').doc('sickCalendarOrder').onSnapshot((doc) => {
    sickCalendarOrder = (doc.exists && Array.isArray(doc.data().order)) ? doc.data().order.slice() : [];
    if (isAdmin(currentUser.name)) renderAdminSickCalendars();
  });
}

function getOrderedSickUsers() {
  const allNames = Object.values(usersMap).map((u) => u.name);
  let order = sickCalendarOrder.filter((n) => allNames.some((a) => a.toLowerCase() === n.toLowerCase()));
  allNames.forEach((n) => { if (!order.some((o) => o.toLowerCase() === n.toLowerCase())) order.push(n); });
  return order.map((n) => usersMap[n.toLowerCase()]).filter(Boolean);
}

function moveSickCalendar(name, direction) {
  const names = getOrderedSickUsers().map((u) => u.name);
  const idx = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= names.length) return;
  const newOrder = names.slice();
  const [item] = newOrder.splice(idx, 1);
  newOrder.splice(newIdx, 0, item);
  db.collection('config').doc('sickCalendarOrder').set({ order: newOrder });
}

document.getElementById('admin-sick-today-toggle').addEventListener('change', (e) => {
  db.collection('config').doc('sickSettings').set({ showToday: e.target.checked }, { merge: true });
});
document.getElementById('admin-sick-stats-toggle').addEventListener('change', (e) => {
  db.collection('config').doc('sickSettings').set({ showStats: e.target.checked }, { merge: true });
});

function renderHomeSickToday() {
  const card = document.getElementById('home-card-krankHeute');
  if (!sickSettings.showToday) { card.style.display = 'none'; return; }
  card.style.display = '';
  const today = todayStr();
  const sickNow = Object.values(usersMap).filter((u) => (sickDaysMap[u.name.toLowerCase()] || []).includes(today));
  const el = document.getElementById('home-krank-heute-content');
  if (!sickNow.length) {
    el.innerHTML = `<div class="sick-empty">Aktuell ist niemand krank gemeldet. 🎉</div>`;
    return;
  }
  el.innerHTML = sickNow.map((u) => {
    const color = userColor(u, 'color') || 'var(--accent-coral)';
    return `<div class="sick-name-row" style="color:${color}"><span class="sick-dot"></span>${escapeHtml(u.name)}</div>`;
  }).join('');
}

function renderHomeSickStats() {
  const card = document.getElementById('home-card-krankStatistik');
  if (!sickSettings.showStats) { card.style.display = 'none'; return; }
  card.style.display = '';
  const users = Object.values(usersMap).sort((a, b) => a.name.localeCompare(b.name));
  const counts = users.map((u) => (sickDaysMap[u.name.toLowerCase()] || []).length);
  const max = Math.max(1, ...counts);
  const MAX_BAR_PX = 100;
  const el = document.getElementById('home-krank-stats-content');
  if (!users.length) { el.innerHTML = ''; return; }
  el.innerHTML = users.map((u, i) => {
    const count = counts[i];
    const color = userColor(u, 'color') || 'var(--accent-purple)';
    const heightPx = count > 0 ? Math.max(6, Math.round((count / max) * MAX_BAR_PX)) : 4;
    return `
      <div class="barchart-col">
        <div class="barchart-name" style="color:${color}">${escapeHtml(u.name)}</div>
        <div class="barchart-bar" style="height:${heightPx}px; background:${color};"></div>
        <div class="barchart-count">${count}</div>
      </div>`;
  }).join('');
}

async function toggleSickDay(userName, dateStr) {
  const ref = db.collection('sickDays').doc(userName);
  const current = sickDaysMap[userName.toLowerCase()] || [];
  if (current.includes(dateStr)) {
    await ref.set({ dates: FieldValue.arrayRemove(dateStr) }, { merge: true });
  } else {
    await ref.set({ dates: FieldValue.arrayUnion(dateStr) }, { merge: true });
  }
}

function renderAdminSickCalendars() {
  const el = document.getElementById('admin-sick-calendars');
  if (!el || !isAdmin(currentUser.name)) return;
  const users = getOrderedSickUsers();
  el.innerHTML = users.map((u, idx) => {
    const key = u.name.toLowerCase();
    if (!calendarMonthState[key]) {
      const now = new Date();
      calendarMonthState[key] = { year: now.getFullYear(), month: now.getMonth() };
    }
    const { year, month } = calendarMonthState[key];
    const sickDates = new Set(sickDaysMap[key] || []);
    const nameColor = userColor(u, 'color') || 'inherit';
    const borderColor = userColor(u, 'border') || 'transparent';
    return `
      <div class="user-sick-card" style="border-color:${borderColor}">
        <div class="cal-header">
          <button class="cal-nav-btn" data-cal-prev="${escapeHtml(u.name)}">‹</button>
          <span class="cal-title" style="color:${nameColor}">${escapeHtml(u.name)} — ${MONTH_LABELS_DE[month]} ${year}</span>
          <button class="cal-nav-btn" data-cal-next="${escapeHtml(u.name)}">›</button>
        </div>
        ${buildCalendarGridHtml(u.name, year, month, sickDates)}
        <div class="cal-order-controls" style="margin-top:10px;">
          <button class="btn-icon" data-move-cal-up="${escapeHtml(u.name)}" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-icon" data-move-cal-down="${escapeHtml(u.name)}" ${idx === users.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-cal-prev]').forEach((btn) => {
    btn.addEventListener('click', () => shiftCalendarMonth(btn.dataset.calPrev, -1));
  });
  el.querySelectorAll('[data-cal-next]').forEach((btn) => {
    btn.addEventListener('click', () => shiftCalendarMonth(btn.dataset.calNext, 1));
  });
  el.querySelectorAll('[data-cal-day]').forEach((cell) => {
    cell.addEventListener('click', () => toggleSickDay(cell.dataset.calUser, cell.dataset.calDay));
  });
  el.querySelectorAll('[data-move-cal-up]').forEach((btn) => {
    btn.addEventListener('click', () => moveSickCalendar(btn.dataset.moveCalUp, -1));
  });
  el.querySelectorAll('[data-move-cal-down]').forEach((btn) => {
    btn.addEventListener('click', () => moveSickCalendar(btn.dataset.moveCalDown, 1));
  });
}

function shiftCalendarMonth(userName, delta) {
  const key = userName.toLowerCase();
  const state = calendarMonthState[key];
  let { year, month } = state;
  month += delta;
  if (month < 0) { month = 11; year -= 1; }
  if (month > 11) { month = 0; year += 1; }
  calendarMonthState[key] = { year, month };
  renderAdminSickCalendars();
}

function buildCalendarGridHtml(userName, year, month, sickDates) {
  const firstDay = new Date(year, month, 1);
  // getDay(): 0=Sun..6=Sat -> convert to Monday-first index 0..6
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let cells = WEEKDAY_LABELS_DE.map((d) => `<div class="cal-weekday">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isSick = sickDates.has(dateStr);
    const isToday = dateStr === today;
    cells += `<div class="cal-cell ${isSick ? 'sick' : ''} ${isToday ? 'today' : ''}" data-cal-day="${dateStr}" data-cal-user="${escapeHtml(userName)}">${day}</div>`;
  }
  return `<div class="cal-grid-wrap"><div class="cal-grid">${cells}</div></div>`;
}



let adminUsersExpanded = new Set(); // lowercase names of currently opened user cards

function renderAdminUsers() {
  const el = document.getElementById('admin-user-list');
  if (!el || !isAdmin(currentUser.name)) return;
  const users = Object.values(usersMap).sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = users.map((u) => {
    const open = adminUsersExpanded.has(u.name.toLowerCase());
    const nameColor = userColor(u, 'color');
    return `
    <div class="user-admin-card ${open ? 'open' : ''}">
      <button class="user-admin-toggle" data-toggle-user="${escapeHtml(u.name)}" aria-expanded="${open}">
        <span class="user-admin-name" style="${nameColor ? `color:${nameColor};` : ''}">${escapeHtml(u.name)}${u.name === ADMIN_NAME ? ' (Admin)' : ''}</span>
        <span class="user-admin-chev">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `
      <div class="user-admin-body">
        <div class="color-grid">
          ${colorFieldHtml(u, 'colorLight', 'Farbe (Hell)')}
          ${colorFieldHtml(u, 'borderLight', 'Rahmen (Hell)')}
          ${colorFieldHtml(u, 'colorDark', 'Farbe (Dunkel)')}
          ${colorFieldHtml(u, 'borderDark', 'Rahmen (Dunkel)')}
        </div>
        ${u.name !== ADMIN_NAME ? `<button class="btn btn-danger btn-small" data-delete-user="${escapeHtml(u.name)}">🗑️ Nutzer löschen</button>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');

  el.querySelectorAll('[data-toggle-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggleUser.toLowerCase();
      if (adminUsersExpanded.has(key)) adminUsersExpanded.delete(key);
      else adminUsersExpanded.add(key);
      renderAdminUsers();
    });
  });

  el.querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.deleteUser;
      const ok = await confirmModal('Nutzer löschen?', `${name} wird aus der App entfernt (Konto & Daten bleiben erhalten).`);
      if (ok) db.collection('users').doc(name).delete();
    });
  });

  el.querySelectorAll('[data-color-field]').forEach((input) => {
    input.addEventListener('change', () => {
      const name = input.dataset.userName;
      const field = input.dataset.colorField;
      const value = input.value;
      db.collection('users').doc(name).set({ [field]: value }, { merge: true });
      // keep the paired text/color inputs in sync visually
      el.querySelectorAll(`[data-user-name="${CSS.escape(name)}"][data-color-field="${field}"]`).forEach((el2) => { el2.value = value; });
    });
  });
}

// ==========================================================
// LOGS (Admin) — wann wurde die Startseite geöffnet (= eingeloggt)
// Einträge werden nach 14 Tagen automatisch gelöscht.
// ==========================================================

const LOG_RETENTION_DAYS = 14;
let loginLogsRaw = [];
let adminLogsOpen = false;

function logCutoffDate() {
  return new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

// Pro Person höchstens EIN Eintrag innerhalb von 10 Minuten – egal ob Login, Tippen auf "Start",
// Zurückholen aus dem Hintergrund, Neuladen oder ein zweites Gerät. Damit das auch geräte- und
// neuladen-übergreifend klappt, steht der Zeitpunkt des letzten Eintrags in der Datenbank
// (loginLogMeta/<Name>) und wird zusammen mit dem Log-Eintrag in einer Transaktion geprüft.
const LOG_MIN_INTERVAL_MS = 10 * 60 * 1000;
let lastHomeLogAt = 0;
let lastLogCleanupAt = 0;

async function logHomeView() {
  if (!currentUser) return;
  const now = Date.now();
  if (now - lastHomeLogAt < LOG_MIN_INTERVAL_MS) return;   // schnelle Vorprüfung ohne Datenbank
  const previousLocal = lastHomeLogAt;
  lastHomeLogAt = now;                                      // parallele Aufrufe sofort abfangen
  const metaRef = db.collection('loginLogMeta').doc(currentUser.name);
  const logRef = db.collection('loginLogs').doc();
  let lastInDb = 0;
  let wrote = false;
  try {
    await db.runTransaction(async (tx) => {
      wrote = false;
      const snap = await tx.get(metaRef);
      lastInDb = snap.exists && typeof snap.data().lastLogAt === 'number' ? snap.data().lastLogAt : 0;
      if (now - lastInDb < LOG_MIN_INTERVAL_MS) return;     // vor kurzem schon eingetragen (z.B. anderes Gerät)
      tx.set(logRef, { user: currentUser.name, createdAt: FieldValue.serverTimestamp() });
      tx.set(metaRef, { lastLogAt: now }, { merge: true });
      wrote = true;
    });
    if (!wrote) lastHomeLogAt = Math.max(previousLocal, lastInDb);
  } catch (err) {
    lastHomeLogAt = previousLocal;                          // bei Fehler beim nächsten Aufruf erneut versuchen
    console.error('Login-Log fehlgeschlagen', err);
    return;
  }
  // Alte Einträge höchstens alle 6 Stunden aufräumen (die App bleibt oft tagelang offen)
  if (now - lastLogCleanupAt > 6 * 60 * 60 * 1000) {
    lastLogCleanupAt = now;
    cleanupOldLogs();
  }
}

// App wird aus dem Hintergrund zurückgeholt und zeigt die Startseite -> auch das zählt
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && currentScreen === 'home') {
    logHomeView();
  }
});

async function cleanupOldLogs() {
  try {
    const cutoff = firebase.firestore.Timestamp.fromDate(logCutoffDate());
    const snap = await db.collection('loginLogs').where('createdAt', '<', cutoff).limit(400).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (err) {
    console.error('Log-Bereinigung fehlgeschlagen', err);
  }
}

function subscribeLoginLogs() {
  const cutoff = firebase.firestore.Timestamp.fromDate(logCutoffDate());
  return db.collection('loginLogs').where('createdAt', '>=', cutoff).orderBy('createdAt', 'desc').onSnapshot((snap) => {
    loginLogsRaw = snap.docs.map((d) => {
      const data = d.data({ serverTimestamps: 'estimate' });
      return { id: d.id, user: data.user, createdAt: data.createdAt };
    });
    renderLoginLogs();
  });
}

function renderLoginLogs() {
  const listEl = document.getElementById('admin-log-list');
  const countEl = document.getElementById('admin-logs-count');
  if (!listEl || !countEl) return;
  const cutoff = logCutoffDate();
  const entries = loginLogsRaw.filter((e) => e.createdAt && e.createdAt.toDate && e.createdAt.toDate() >= cutoff);
  countEl.textContent = `(${entries.length})`;
  if (!entries.length) {
    listEl.innerHTML = `<div class="empty-state">Noch keine Einträge.</div>`;
    return;
  }
  listEl.innerHTML = entries.map((e) => {
    const d = e.createdAt.toDate();
    const userData = usersMap[(e.user || '').toLowerCase()];
    const color = userData ? userColor(userData, 'color') : null;
    const border = userData ? userColor(userData, 'border') : null;
    const dateLabel = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeLabel = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="log-row" style="${color ? `color:${color};` : ''}${border ? `border-left-color:${border};` : ''}">
        <span class="log-name">${escapeHtml(e.user)}</span>
        <span class="log-time">${dateLabel} · ${timeLabel} Uhr</span>
        <button class="btn-icon" data-delete-log="${e.id}" title="Eintrag löschen">🗑️</button>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-delete-log]').forEach((btn) => {
    btn.addEventListener('click', () => deleteLoginLog(btn.dataset.deleteLog));
  });
}

async function deleteLoginLog(logId) {
  const ok = await confirmModal('Log-Eintrag löschen?', 'Dieser Eintrag wird endgültig entfernt.');
  if (!ok) return;
  try {
    await db.collection('loginLogs').doc(logId).delete();
  } catch (err) {
    console.error(err);
    toast('Fehler beim Löschen: ' + err.message);
  }
}

document.getElementById('admin-logs-toggle').addEventListener('click', () => {
  adminLogsOpen = !adminLogsOpen;
  document.getElementById('admin-logs-body').style.display = adminLogsOpen ? '' : 'none';
  document.getElementById('admin-logs-chev').textContent = adminLogsOpen ? '▾' : '▸';
});

function colorFieldHtml(u, field, label) {
  const val = u[field] || '#888888';
  return `
    <div class="color-field">
      <label>${label}</label>
      <div class="color-input-row">
        <input type="color" value="${val}" data-user-name="${escapeHtml(u.name)}" data-color-field="${field}">
        <input type="text" value="${val}" data-user-name="${escapeHtml(u.name)}" data-color-field="${field}">
      </div>
    </div>`;
}

document.getElementById('admin-add-user-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('admin-new-user-input');
  const passInput = document.getElementById('admin-new-user-password-input');
  const name = nameInput.value.trim();
  const password = passInput.value;
  if (!name || !password) { toast('Bitte Name und Passwort angeben.'); return; }
  if (password.length < 6) { toast('Passwort muss mindestens 6 Zeichen haben.'); return; }

  const btn = document.getElementById('admin-add-user-btn');
  btn.disabled = true;
  try {
    // Ein zweites, temporäres Firebase-App-Objekt, damit das Anlegen des neuen
    // Kontos NICHT die aktuell eingeloggte Admin-Sitzung ersetzt.
    const secondary = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
    const email = name.toLowerCase() + AUTH_EMAIL_DOMAIN;
    await secondary.auth().createUserWithEmailAndPassword(email, password);
    await secondary.auth().signOut();
    await secondary.delete();

    if (!usersMap[name.toLowerCase()]) {
      const idx = Object.keys(usersMap).length;
      await db.collection('users').doc(name).set({ name, ...defaultUserColors(idx), createdAt: FieldValue.serverTimestamp() });
      toast(`${name} wurde mit Zugangsdaten angelegt.`);
    } else {
      toast(`Passwort für ${name} wurde eingerichtet.`);
    }
    nameInput.value = '';
    passInput.value = '';
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      toast('Für diesen Namen gibt es schon ein Passwort. Zum Ändern zuerst in der Firebase-Konsole löschen.');
    } else {
      toast('Fehler: ' + err.message);
    }
  } finally {
    btn.disabled = false;
  }
});

// ==========================================================
// BACKUP / EXPORT (Admin)
// ==========================================================

function sanitizeForExport(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && typeof value.toDate === 'function' && typeof value.seconds === 'number') {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) return value.map(sanitizeForExport);
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => { out[k] = sanitizeForExport(value[k]); });
    return out;
  }
  return value;
}

async function exportBackup() {
  const statusEl = document.getElementById('admin-backup-status');
  const btn = document.getElementById('admin-backup-btn');
  btn.disabled = true;
  statusEl.textContent = 'Backup wird erstellt…';
  try {
    const data = { exportedAt: new Date().toISOString(), exportedBy: currentUser.name };

    const simpleCollections = ['shopping', 'tasks', 'chat', 'ideas', 'dailyActivity', 'meals', 'sickDays', 'users', 'settings', 'dishes', 'appointments', 'nerdEntries', 'customLists', 'birthdays', 'gymDays', 'games', 'gameStats', 'tournaments', 'groupGames', 'sudokuProgress', 'sudokuStats'];
    for (const col of simpleCollections) {
      const snap = await db.collection(col).get();
      data[col] = snap.docs.map((d) => ({ id: d.id, ...sanitizeForExport(d.data()) }));
    }

    data.config = {};
    for (const docId of ['important', 'homeOrder', 'sickSettings', 'sickCalendarOrder', 'gymSettings', 'settingsOrder']) {
      const docSnap = await db.collection('config').doc(docId).get();
      data.config[docId] = docSnap.exists ? sanitizeForExport(docSnap.data()) : null;
    }

    const accountsSnap = await db.collection('accounts').get();
    data.accounts = [];
    for (const accDoc of accountsSnap.docs) {
      const txSnap = await db.collection('accounts').doc(accDoc.id).collection('transactions').orderBy('createdAt', 'asc').get();
      data.accounts.push({
        id: accDoc.id,
        balance: accDoc.data().balance || 0,
        transactions: txSnap.docs.map((t) => ({ id: t.id, ...sanitizeForExport(t.data()) }))
      });
    }

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `familien-app-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    statusEl.textContent = `Fertig – Backup vom ${new Date().toLocaleString('de-DE')} heruntergeladen.`;
    toast('Backup heruntergeladen ✅');
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Fehler beim Erstellen des Backups. Bitte nochmal versuchen.';
    toast('Backup fehlgeschlagen ⚠️');
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('admin-backup-btn').addEventListener('click', exportBackup);

// Tabs (scoped per tab-group: Admin screen, Aufgaben/Einkaufen screen, ...)
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const group = btn.closest('.screen') || document;
    group.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    group.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
    if (btn.dataset.trackVisit && DAILY_MENUS.includes(btn.dataset.trackVisit)) {
      markMenuVisited(btn.dataset.trackVisit);
    }
    if (btn.dataset.tab === 'aktuell-panel-chat') {
      scrollChatToBottom();
      markChatSeen();
      markMenuVisited('chat');
    }
    if (btn.dataset.tab === 'aktuell-panel-kalender') {
      renderMonthCalendar();
    }
    if (btn.dataset.tab === 'aktuell-panel-gym') {
      onGymTabOpened();
    }
  });
});

const DEFAULT_SETTINGS_ORDER = ['darkmode', 'geburtstage', 'ideen', 'admin', 'spezialkalender'];
let settingsOrder = DEFAULT_SETTINGS_ORDER.slice();

// Fehlende Einträge (z.B. "ideen") werden an ihrer Standard-Position in eine gespeicherte Reihenfolge eingefügt,
// unbekannte Einträge werden entfernt.
function mergeSettingsOrder(stored) {
  let order = Array.isArray(stored) ? stored.slice() : [];
  order = order.filter((k) => DEFAULT_SETTINGS_ORDER.includes(k));
  DEFAULT_SETTINGS_ORDER.forEach((k, defaultIdx) => {
    if (!order.includes(k)) order.splice(Math.min(defaultIdx, order.length), 0, k);
  });
  return order;
}

function subscribeSettingsOrder() {
  return db.collection('config').doc('settingsOrder').onSnapshot((doc) => {
    settingsOrder = mergeSettingsOrder(doc.exists ? doc.data().order : []);
    renderSettingsOrder();
  });
}

function renderSettingsOrder() {
  const container = document.getElementById('settings-orderable');
  if (!container) return;
  settingsOrder.forEach((key, idx) => {
    const el = document.getElementById('settings-item-' + key);
    if (!el) return;
    container.appendChild(el);
    const upBtn = el.querySelector('[data-move-setting-up]');
    const downBtn = el.querySelector('[data-move-setting-down]');
    if (upBtn) upBtn.disabled = idx === 0;
    if (downBtn) downBtn.disabled = idx === settingsOrder.length - 1;
  });
}

function moveSettingsItem(key, direction) {
  const idx = settingsOrder.indexOf(key);
  if (idx < 0) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= settingsOrder.length) return;
  const newOrder = settingsOrder.slice();
  const [item] = newOrder.splice(idx, 1);
  newOrder.splice(newIdx, 0, item);
  db.collection('config').doc('settingsOrder').set({ order: newOrder });
}

document.querySelectorAll('[data-move-setting-up]').forEach((btn) => {
  btn.addEventListener('click', () => moveSettingsItem(btn.dataset.moveSettingUp, -1));
});
document.querySelectorAll('[data-move-setting-down]').forEach((btn) => {
  btn.addEventListener('click', () => moveSettingsItem(btn.dataset.moveSettingDown, 1));
});

document.getElementById('settings-admin-link').addEventListener('click', () => showScreen('admin'));
document.getElementById('admin-back-btn').addEventListener('click', () => showScreen('settings'));
document.getElementById('settings-birthdays-link').addEventListener('click', () => showScreen('birthdays'));
document.getElementById('settings-ideen-link').addEventListener('click', () => showScreen('ideen'));
document.getElementById('ideen-back-btn').addEventListener('click', () => showScreen('settings'));
document.getElementById('birthdays-back-btn').addEventListener('click', () => showScreen('settings'));
document.getElementById('settings-spezial-link').addEventListener('click', () => showScreen('spezial'));
document.getElementById('spezial-back-btn').addEventListener('click', () => showScreen('settings'));

// Home order
// Ergänzt in einer gespeicherten Reihenfolge fehlende Karten an ihrer Standard-Position
// (z.B. "bonus" ganz oben, wie bisher) und entfernt unbekannte Einträge.
function mergeHomeOrder(stored) {
  let order = Array.isArray(stored) ? stored.slice() : [];
  order = order.filter((key) => DEFAULT_ORDER.includes(key));
  DEFAULT_ORDER.forEach((key, defaultIdx) => {
    if (!order.includes(key)) order.splice(Math.min(defaultIdx, order.length), 0, key);
  });
  return order;
}

function subscribeHomeOrder() {
  return db.collection('config').doc('homeOrder').onSnapshot((doc) => {
    homeOrder = mergeHomeOrder(doc.exists ? doc.data().order : []);
    renderHomeOrder();
    if (isAdmin(currentUser.name)) renderAdminOrderList();
  });
}

const ORDER_LABELS = { bonus: '⭐ 50-Cent-Bonus', konto: '💰 Kontostand', essen: '🍽️ Essen', wichtig: '📌 Wichtig', krankHeute: '🤒 Krank heute', krankStatistik: '📊 Krank-Statistik', termine: '📅 Termine heute', spiele: '🎮 Spiele-Hinweise', letzterSieg: '🏆 Letzter Sieg' };

function renderAdminOrderList() {
  const el = document.getElementById('admin-order-list');
  el.innerHTML = homeOrder.map((key, idx) => `
    <li>
      <span>${ORDER_LABELS[key]}</span>
      <div class="order-controls">
        <button class="btn-icon" data-move="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-icon" data-move="down" data-idx="${idx}" ${idx === homeOrder.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </li>`).join('');

  el.querySelectorAll('[data-move]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const dir = btn.dataset.move === 'up' ? -1 : 1;
      const newOrder = homeOrder.slice();
      const [item] = newOrder.splice(idx, 1);
      newOrder.splice(idx + dir, 0, item);
      db.collection('config').doc('homeOrder').set({ order: newOrder });
    });
  });
}

// ==========================================================
// APP BOOTSTRAP
// ==========================================================

function startAppListeners() {
  renderHomeGreeting();
  renderHomeBalance();
  initDarkModePreference();
  renderTaskAssigneeOptions();

  unsubscribers.push(subscribeDailyActivity());
  unsubscribers.push(subscribeShopping());
  unsubscribers.push(subscribeTasks());
  unsubscribers.push(subscribeDishes());
  unsubscribers.push(subscribeCustomLists());
  migrateNerdListsOnce();
  unsubscribers.push(subscribeAppointments());
  unsubscribers.push(subscribeChat());
  unsubscribers.push(subscribeIdeas());
  unsubscribers.push(...subscribeAccounts());
  subscribeAllTransactions();
  unsubscribers.push(subscribeMeals());
  unsubscribers.push(subscribeImportant());
  unsubscribers.push(subscribeHomeOrder());
  unsubscribers.push(subscribeBirthdays());
  unsubscribers.push(subscribeSettingsOrder());
  unsubscribers.push(subscribeGymSettings());
  unsubscribers.push(subscribeGymDays());
  unsubscribers.push(subscribeGames());
  unsubscribers.push(subscribeGameStats());
  unsubscribers.push(subscribeGroupGames());
  unsubscribers.push(subscribeSudoku());
  unsubscribers.push(subscribeTournaments());
  tnTimer = setInterval(tournamentsAdvanceAll, 60000);
  unsubscribers.push(() => clearInterval(tnTimer));
  unsubscribers.push(subscribeSickDays());
  unsubscribers.push(subscribeSickSettings());
  unsubscribers.push(subscribeSickCalendarOrder());

  if (isAdmin(currentUser.name)) {
    renderAdminUsers();
    unsubscribers.push(subscribeLoginLogs());
  }
}

subscribeUsers();
