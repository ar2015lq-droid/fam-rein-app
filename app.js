/* ==========================================================
   Familien-App – app.js
   Vanilla JS, keine Frameworks. Firebase Firestore (compat SDK)
   für die geräteübergreifende Synchronisierung.
   ========================================================== */

const ADMIN_NAME = 'Alex';
const DAILY_MENUS = ['kalender', 'tasks', 'chat', 'konto', 'ideen'];
const MENU_LABELS = { kalender: 'Kalender', tasks: 'Aufgaben', chat: 'Chat', konto: 'Konto', ideen: 'Ideen' };
const DEFAULT_ORDER = ['konto', 'essen', 'wichtig', 'krankHeute', 'krankStatistik', 'termine'];
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

function confirmModal(title, text) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-box">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(text)}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" id="modal-cancel">Abbrechen</button>
            <button class="btn btn-danger" id="modal-confirm">Löschen</button>
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
  document.getElementById('settings-admin-link').style.display = isAdmin(currentUser.name) ? '' : 'none';
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
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === name || ((name === 'admin' || name === 'birthdays') && b.dataset.target === 'settings')));

  if (name === 'home') {
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
  }
  if (name === 'ideen') {
    markIdeasSeen();
  }
  if (name === 'tasks') {
    markTasksSeen();
  }

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
      const clickAttrs = (o.isHoliday || o.isFerien || o.isBirthday) ? '' : `data-appt-id="${o.apptId}" data-appt-date="${o.occurrenceStart}"`;
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



function renderAdminUsers() {
  const el = document.getElementById('admin-user-list');
  if (!el || !isAdmin(currentUser.name)) return;
  const users = Object.values(usersMap).sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = users.map((u) => `
    <div class="user-admin-card">
      <div class="user-admin-head">
        <span class="user-admin-name">${escapeHtml(u.name)}${u.name === ADMIN_NAME ? ' (Admin)' : ''}</span>
        ${u.name !== ADMIN_NAME ? `<button class="btn-icon" data-delete-user="${escapeHtml(u.name)}">🗑️</button>` : ''}
      </div>
      <div class="color-grid">
        ${colorFieldHtml(u, 'colorLight', 'Farbe (Hell)')}
        ${colorFieldHtml(u, 'borderLight', 'Rahmen (Hell)')}
        ${colorFieldHtml(u, 'colorDark', 'Farbe (Dunkel)')}
        ${colorFieldHtml(u, 'borderDark', 'Rahmen (Dunkel)')}
      </div>
    </div>`).join('');

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

    const simpleCollections = ['shopping', 'tasks', 'chat', 'ideas', 'dailyActivity', 'meals', 'sickDays', 'users', 'settings', 'dishes', 'appointments', 'nerdEntries', 'customLists', 'birthdays'];
    for (const col of simpleCollections) {
      const snap = await db.collection(col).get();
      data[col] = snap.docs.map((d) => ({ id: d.id, ...sanitizeForExport(d.data()) }));
    }

    data.config = {};
    for (const docId of ['important', 'homeOrder', 'sickSettings', 'sickCalendarOrder']) {
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
  });
});

const DEFAULT_SETTINGS_ORDER = ['darkmode', 'geburtstage', 'admin'];
let settingsOrder = DEFAULT_SETTINGS_ORDER.slice();

function subscribeSettingsOrder() {
  return db.collection('config').doc('settingsOrder').onSnapshot((doc) => {
    let order = (doc.exists && Array.isArray(doc.data().order)) ? doc.data().order.slice() : [];
    DEFAULT_SETTINGS_ORDER.forEach((k) => { if (!order.includes(k)) order.push(k); });
    order = order.filter((k) => DEFAULT_SETTINGS_ORDER.includes(k));
    settingsOrder = order;
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
document.getElementById('birthdays-back-btn').addEventListener('click', () => showScreen('settings'));

// Home order
function subscribeHomeOrder() {
  return db.collection('config').doc('homeOrder').onSnapshot((doc) => {
    let order = (doc.exists && Array.isArray(doc.data().order)) ? doc.data().order.slice() : [];
    // Backward-compat: append any new order keys that aren't in an older saved order yet
    DEFAULT_ORDER.forEach((key) => { if (!order.includes(key)) order.push(key); });
    // Drop unknown/stale keys
    order = order.filter((key) => DEFAULT_ORDER.includes(key));
    homeOrder = order;
    renderHomeOrder();
    if (isAdmin(currentUser.name)) renderAdminOrderList();
  });
}

const ORDER_LABELS = { konto: '💰 Kontostand', essen: '🍽️ Essen', wichtig: '📌 Wichtig', krankHeute: '🤒 Krank heute', krankStatistik: '📊 Krank-Statistik', termine: '📅 Termine heute' };

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
  unsubscribers.push(subscribeSickDays());
  unsubscribers.push(subscribeSickSettings());
  unsubscribers.push(subscribeSickCalendarOrder());

  if (isAdmin(currentUser.name)) {
    renderAdminUsers();
  }
}

subscribeUsers();
