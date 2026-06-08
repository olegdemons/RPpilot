// online-auth.js
// Онлайн-регистрация, роли, автоперенос локальных аккаунтов и панель разработчика через Supabase.
// Первый аккаунт в пустой базе автоматически становится главным.

(() => {
  const ONLINE_SESSION_KEY = "rppilot-online-current-static";
  const LEGACY_STATE_KEY = "postovoy-v2";
  const LEGACY_ACCOUNTS_KEY = "postovoy-accounts-v1";
  const PASSWORD_SALT = "rppilot-static-site-v3";

  const roleLabels = {
    owner: "Главный",
    developer: "Разработчик",
    admin: "Админ",
    earnings: "Заработок",
    user: "Пользователь"
  };

  let db = null;
  let cachedAccounts = {};
  let originalSwitchTab = null;
  let originalUpdateProfileUI = null;
  let originalRenderAccountList = null;
  let started = false;

  function qs(selector) { return document.querySelector(selector); }
  function qsa(selector) { return [...document.querySelectorAll(selector)]; }

  function notify(title, text = "") {
    if (typeof showToast === "function") showToast(title, text);
    else console.log(title, text);
  }

  function normalizeStaticId(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 6);
    return digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
  }

  function validStaticId(value) {
    return /^\d{3}-\d{3}$/.test(normalizeStaticId(value));
  }

  function cleanText(value, fallback = "") {
    const text = String(value || "").trim();
    return text || fallback;
  }

  function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function makePasswordHash(staticId, password) {
    return sha256(`${PASSWORD_SALT}:${normalizeStaticId(staticId)}:${password}`);
  }

  async function makeLegacyPasswordHash(password) {
    return sha256(password);
  }

  function normalizeRoles(roles, forceOwner = false) {
    const set = new Set(Array.isArray(roles) ? roles : ["user"]);
    set.add("user");

    if (forceOwner || set.has("owner")) {
      set.add("owner");
      set.add("developer");
      set.add("admin");
      set.add("earnings");
    }

    return [...set].filter((role) => roleLabels[role]);
  }

  function ownerExists() {
    return Object.values(cachedAccounts).some((account) => account.roles?.includes("owner"));
  }

  function rolesFromLegacyAccount(account, forceOwner = false) {
    const roles = new Set(Array.isArray(account?.roles) ? account.roles : ["user"]);
    roles.add("user");
    if (account?.earningsAccess) roles.add("earnings");
    if (account?.isAdmin) roles.add("admin");
    if (account?.isDeveloper) roles.add("developer");
    if (account?.isOwner || forceOwner) roles.add("owner");
    return normalizeRoles([...roles], forceOwner || roles.has("owner"));
  }

  function accountFromRow(row) {
    const roles = normalizeRoles(row.roles);
    return {
      firstName: row.first_name,
      lastName: row.last_name,
      rank: row.rank || "Рядовой",
      staticId: row.static_id,
      callsign: row.callsign || "",
      login: row.login || row.static_id,
      passwordHash: row.password_hash,
      roles,
      isActive: row.is_active !== false,
      isOwner: roles.includes("owner"),
      isDeveloper: roles.includes("developer") || roles.includes("owner"),
      isAdmin: roles.includes("admin") || roles.includes("owner"),
      earningsAccess: roles.includes("earnings") || roles.includes("admin") || roles.includes("developer") || roles.includes("owner"),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function rowFromProfile(profile, passwordHash, forceOwner = false) {
    const staticId = normalizeStaticId(profile.staticId);
    return {
      static_id: staticId,
      login: cleanText(profile.login, staticId),
      password_hash: passwordHash,
      first_name: cleanText(profile.firstName),
      last_name: cleanText(profile.lastName),
      rank: cleanText(profile.rank, "Рядовой"),
      callsign: cleanText(profile.callsign),
      roles: normalizeRoles(profile.roles || ["user"], forceOwner),
      is_active: profile.isActive !== false
    };
  }

  function currentOnlineAccount() {
    const staticId = state?.currentStatic || localStorage.getItem(ONLINE_SESSION_KEY);
    return staticId ? cachedAccounts[staticId] || null : null;
  }

  function canOpenDeveloperPanel(account = currentOnlineAccount()) {
    return Boolean(account?.isOwner || account?.isDeveloper || account?.roles?.includes("developer"));
  }

  function canGrantRole(role, actor = currentOnlineAccount()) {
    if (!actor) return false;
    if (actor.isOwner) return true;
    if (role === "earnings" && canOpenDeveloperPanel(actor)) return true;
    return false;
  }

  async function logAction(action, targetStaticId, payload = {}) {
    try {
      await db.from("rppilot_audit_logs").insert({
        actor_static_id: currentOnlineAccount()?.staticId || null,
        action,
        target_static_id: targetStaticId || null,
        payload
      });
    } catch (error) {
      console.warn("Audit log skipped", error);
    }
  }

  async function loadAllUsers() {
    const { data, error } = await db
      .from("rppilot_users")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) throw error;

    cachedAccounts = {};
    for (const row of data || []) {
      const account = accountFromRow(row);
      cachedAccounts[account.staticId] = account;
    }

    return cachedAccounts;
  }

  async function getUser(staticId) {
    staticId = normalizeStaticId(staticId);
    if (cachedAccounts[staticId]) return cachedAccounts[staticId];

    const { data, error } = await db
      .from("rppilot_users")
      .select("*")
      .eq("static_id", staticId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const account = accountFromRow(data);
    cachedAccounts[account.staticId] = account;
    return account;
  }

  async function saveUser(profile, passwordHash, options = {}) {
    const forceOwner = Boolean(options.forceOwner);
    const row = rowFromProfile(profile, passwordHash, forceOwner);
    const { data, error } = await db
      .from("rppilot_users")
      .upsert(row, { onConflict: "static_id" })
      .select("*")
      .single();

    if (error) throw error;

    const saved = accountFromRow(data);
    cachedAccounts[saved.staticId] = saved;
    await logAction("user.upsert", saved.staticId, { roles: saved.roles, forceOwner });
    return saved;
  }

  async function setRoles(staticId, roles) {
    staticId = normalizeStaticId(staticId);
    roles = normalizeRoles(roles);

    const { data, error } = await db
      .from("rppilot_users")
      .update({ roles })
      .eq("static_id", staticId)
      .select("*")
      .single();

    if (error) throw error;

    const saved = accountFromRow(data);
    cachedAccounts[saved.staticId] = saved;
    await logAction("roles.update", saved.staticId, { roles });
    return saved;
  }

  async function setActive(staticId, isActive) {
    staticId = normalizeStaticId(staticId);
    const { data, error } = await db
      .from("rppilot_users")
      .update({ is_active: isActive })
      .eq("static_id", staticId)
      .select("*")
      .single();

    if (error) throw error;

    const saved = accountFromRow(data);
    cachedAccounts[saved.staticId] = saved;
    await logAction("user.status", saved.staticId, { isActive });
    return saved;
  }

  function getLegacyAccounts() {
    const result = {};

    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_ACCOUNTS_KEY) || "{}");
      if (Array.isArray(legacy)) {
        for (const account of legacy) {
          const staticId = normalizeStaticId(account?.staticId || account?.static_id);
          if (validStaticId(staticId)) result[staticId] = account;
        }
      } else if (legacy && typeof legacy === "object") {
        for (const [key, account] of Object.entries(legacy)) {
          const staticId = normalizeStaticId(account?.staticId || account?.static_id || key);
          if (validStaticId(staticId)) result[staticId] = { ...account, staticId };
        }
      }
    } catch {}

    try {
      const savedState = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY) || "{}");
      const profile = savedState?.profile;
      const staticId = normalizeStaticId(profile?.staticId || savedState?.currentStatic);
      if (profile && validStaticId(staticId)) result[staticId] = { ...profile, staticId };
    } catch {}

    return result;
  }

  async function migrateLocalAccountsToDatabase() {
    const legacyAccounts = getLegacyAccounts();
    const entries = Object.values(legacyAccounts)
      .filter((account) => validStaticId(account?.staticId))
      .sort((a, b) => {
        const current = normalizeStaticId(localStorage.getItem(ONLINE_SESSION_KEY) || state?.currentStatic || "");
        if (normalizeStaticId(a.staticId) === current) return -1;
        if (normalizeStaticId(b.staticId) === current) return 1;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      });

    if (!entries.length) return 0;

    let migrated = 0;
    let hasOwner = ownerExists();

    for (const oldAccount of entries) {
      const staticId = normalizeStaticId(oldAccount.staticId);
      if (cachedAccounts[staticId]) continue;

      const passwordHash = oldAccount.passwordHash || oldAccount.password_hash ||
        (oldAccount.password ? await makePasswordHash(staticId, oldAccount.password) : null);

      if (!passwordHash) continue;

      const forceOwner = !hasOwner;
      const profile = {
        staticId,
        login: oldAccount.login || staticId,
        firstName: cleanText(oldAccount.firstName || oldAccount.first_name, "Без имени"),
        lastName: cleanText(oldAccount.lastName || oldAccount.last_name, "Без фамилии"),
        rank: cleanText(oldAccount.rank, "Рядовой"),
        callsign: cleanText(oldAccount.callsign),
        roles: rolesFromLegacyAccount(oldAccount, forceOwner),
        isActive: oldAccount.isActive !== false && oldAccount.is_active !== false
      };

      const saved = await saveUser(profile, passwordHash, { forceOwner });
      migrated += 1;
      if (saved.isOwner) hasOwner = true;

      if (state?.currentStatic === staticId || localStorage.getItem(ONLINE_SESSION_KEY) === staticId) {
        localStorage.setItem(ONLINE_SESSION_KEY, staticId);
      }
    }

    if (migrated) {
      await loadAllUsers();
      notify("Аккаунты перенесены", `${migrated} локальных аккаунтов добавлено в базу`);
    }

    return migrated;
  }

  function patchOriginalFunctions() {
    if (!originalSwitchTab && typeof switchTab === "function") originalSwitchTab = switchTab;
    if (!originalUpdateProfileUI && typeof updateProfileUI === "function") originalUpdateProfileUI = updateProfileUI;
    if (!originalRenderAccountList && typeof renderAccountList === "function") originalRenderAccountList = renderAccountList;

    try {
      getAccounts = function getOnlineAccounts() { return cachedAccounts; };
      saveAccounts = function saveOnlineAccounts() {};
      currentAccount = currentOnlineAccount;
      hasEarningsAccess = function onlineEarningsAccess() {
        const account = currentOnlineAccount();
        return Boolean(account?.earningsAccess || account?.isOwner || account?.isAdmin || account?.isDeveloper);
      };
      switchTab = function guardedSwitchTab(tabId) {
        if (tabId === "developer" && !canOpenDeveloperPanel()) {
          notify("Доступ закрыт", "Панель выдаёт главный аккаунт");
          return;
        }
        return originalSwitchTab(tabId);
      };
      updateProfileUI = function onlineUpdateProfileUI() {
        if (originalUpdateProfileUI) originalUpdateProfileUI();
        updateProtectedUI();
        renderDeveloperPanel();
      };
      renderAccountList = function onlineRenderAccountList() {
        if (originalRenderAccountList) originalRenderAccountList();
        renderDeveloperPanel();
      };
    } catch (error) {
      console.warn("RPpilot online auth: patch failed", error);
    }
  }

  function setSignedIn(account) {
    localStorage.setItem(ONLINE_SESSION_KEY, account.staticId);
    state.currentStatic = account.staticId;
    state.profile = account;

    if (typeof saveState === "function") saveState();
    if (typeof updateProfileUI === "function") updateProfileUI();
    if (typeof renderReports === "function") renderReports();
    if (typeof renderAccountList === "function") renderAccountList();

    return account;
  }

  function clearSignedIn() {
    localStorage.removeItem(ONLINE_SESSION_KEY);
    state.currentStatic = null;
    state.profile = null;

    if (typeof saveState === "function") saveState();
    if (typeof updateProfileUI === "function") updateProfileUI();
    if (typeof renderReports === "function") renderReports();
  }

  function updateProtectedUI() {
    const account = currentOnlineAccount();
    const devButton = qs("#developer-tab-button");
    if (devButton) devButton.hidden = !canOpenDeveloperPanel(account);

    const earningsButton = qs("#earnings-tab-button");
    if (earningsButton) earningsButton.hidden = !Boolean(account?.earningsAccess || account?.isOwner || account?.isDeveloper || account?.isAdmin);

    const accessManager = qs("#access-manager");
    if (accessManager) accessManager.hidden = !Boolean(account?.isOwner);

    const dbStatus = qs("#developer-db-status");
    const dbMeta = qs("#developer-db-meta");
    if (dbStatus) dbStatus.textContent = db ? "Подключено" : "Не подключено";
    if (dbMeta) {
      const owner = Object.values(cachedAccounts).find((item) => item.isOwner);
      dbMeta.textContent = owner
        ? `${Object.keys(cachedAccounts).length} аккаунтов · главный: ${owner.staticId}`
        : `${Object.keys(cachedAccounts).length} аккаунтов · первый зарегистрированный станет главным`;
    }
  }

  function renderDeveloperPanel() {
    const box = qs("#developer-users");
    if (!box) return;

    const actor = currentOnlineAccount();
    updateProtectedUI();

    if (!canOpenDeveloperPanel(actor)) {
      box.innerHTML = '<p class="modal-description">Нет доступа к панели разработчика.</p>';
      return;
    }

    const accounts = Object.values(cachedAccounts).sort((a, b) => a.staticId.localeCompare(b.staticId));
    if (!accounts.length) {
      box.innerHTML = '<p class="modal-description">В базе пока нет аккаунтов. Первый зарегистрированный аккаунт станет главным.</p>';
      return;
    }

    box.innerHTML = accounts.map((user) => {
      const roles = normalizeRoles(user.roles);
      const roleButtons = ["developer", "admin", "earnings"].map((role) => {
        const active = roles.includes(role);
        const disabled = user.isOwner || !canGrantRole(role, actor);
        return `<button class="role-toggle ${active ? "active" : ""}" data-role-toggle="${role}" data-static="${safe(user.staticId)}" type="button" ${disabled ? "disabled" : ""}>${safe(roleLabels[role])}</button>`;
      }).join("");
      const activeDisabled = user.isOwner || !actor?.isOwner;
      return `
        <div class="developer-row">
          <div class="developer-row-header">
            <strong>${safe(user.rank)} ${safe(user.firstName)} ${safe(user.lastName)}</strong>
            <small>Static ${safe(user.staticId)} · ${safe(user.callsign || "без позывного")}</small>
            <div class="role-pills">${roles.map((role) => `<span class="role-pill active">${safe(roleLabels[role] || role)}</span>`).join("")}</div>
            <div class="developer-row-meta">Создан: ${safe(user.createdAt ? new Date(user.createdAt).toLocaleString("ru-RU") : "—")}</div>
          </div>
          <div class="developer-row-actions">
            ${roleButtons}
            <button class="role-toggle danger ${user.isActive ? "" : "active"}" data-active-toggle="${user.isActive ? "off" : "on"}" data-static="${safe(user.staticId)}" type="button" ${activeDisabled ? "disabled" : ""}>${user.isActive ? "Отключить" : "Включить"}</button>
          </div>
        </div>`;
    }).join("");

    qsa("[data-role-toggle]").forEach((button) => {
      button.addEventListener("click", async () => {
        await toggleRole(button.dataset.static, button.dataset.roleToggle);
      });
    });

    qsa("[data-active-toggle]").forEach((button) => {
      button.addEventListener("click", async () => {
        const staticId = button.dataset.static;
        const turnOn = button.dataset.activeToggle === "on";
        await toggleActive(staticId, turnOn);
      });
    });
  }

  async function toggleRole(staticId, role) {
    try {
      const actor = currentOnlineAccount();
      if (!canGrantRole(role, actor)) {
        notify("Недостаточно прав", role === "developer" ? "Панель разработчика выдаёт только главный аккаунт" : "Недоступная роль");
        return;
      }

      const user = await getUser(staticId);
      if (!user) {
        notify("Аккаунт не найден", "Пользователь должен сначала зарегистрироваться");
        return;
      }

      if (user.isOwner) {
        notify("Главный аккаунт защищён", `Static ${user.staticId}`);
        return;
      }

      const roles = new Set(normalizeRoles(user.roles));
      if (roles.has(role)) roles.delete(role);
      else roles.add(role);
      roles.add("user");

      const saved = await setRoles(staticId, [...roles]);
      await loadAllUsers();
      if (state.currentStatic === saved.staticId) setSignedIn(saved);
      updateProfileUI();
      notify(roles.has(role) ? "Роль выдана" : "Роль отозвана", `${roleLabels[role]} · Static ${staticId}`);
    } catch (error) {
      notify("Роль не изменена", error.message);
    }
  }

  async function toggleActive(staticId, active) {
    try {
      const actor = currentOnlineAccount();
      if (!actor?.isOwner) {
        notify("Недостаточно прав", "Отключать аккаунты может только главный");
        return;
      }
      const user = await getUser(staticId);
      if (user?.isOwner) {
        notify("Главный аккаунт защищён", `Static ${staticId}`);
        return;
      }
      await setActive(staticId, active);
      await loadAllUsers();
      renderDeveloperPanel();
      notify(active ? "Аккаунт включён" : "Аккаунт отключён", `Static ${staticId}`);
    } catch (error) {
      notify("Статус не изменён", error.message);
    }
  }

  async function refreshSession() {
    await loadAllUsers();
    const staticId = normalizeStaticId(localStorage.getItem(ONLINE_SESSION_KEY) || state.currentStatic || "");
    if (!validStaticId(staticId)) {
      clearSignedIn();
      updateProtectedUI();
      return;
    }

    const account = await getUser(staticId);
    if (!account || !account.isActive) {
      clearSignedIn();
      updateProtectedUI();
      return;
    }

    setSignedIn(account);
  }

  function takeOverLoginForm() {
    const form = qs("#login-form");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      try {
        const staticId = normalizeStaticId(qs("#login-static").value);
        const password = String(qs("#login-password").value || "");

        if (!validStaticId(staticId) || !password) {
          notify("Введите Static ID и пароль", "Формат Static ID: 123-456");
          return;
        }

        const account = await getUser(staticId);
        const hash = await makePasswordHash(staticId, password);
        const legacyHash = await makeLegacyPasswordHash(password);

        if (!account || !account.isActive || ![hash, legacyHash].includes(account.passwordHash)) {
          notify("Не удалось войти", "Проверьте Static ID и пароль");
          return;
        }

        if (account.passwordHash === legacyHash) {
          await saveUser(account, hash, { forceOwner: account.isOwner });
          await loadAllUsers();
        }

        setSignedIn(cachedAccounts[staticId] || account);
        if (typeof toggleModal === "function") toggleModal("profile-modal", false);
        notify("Вход выполнен", `${account.rank} ${account.lastName}`);
      } catch (error) {
        notify("Ошибка входа", error.message);
      }
    }, true);
  }

  function takeOverProfileForm() {
    const form = qs("#profile-form");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      try {
        await loadAllUsers();

        const staticId = normalizeStaticId(qs("#static-id").value);
        const password = String(qs("#password").value || "");
        const confirmation = String(qs("#password-confirm").value || "");
        const signedIn = currentOnlineAccount();
        const existing = await getUser(staticId);

        if (!validStaticId(staticId)) {
          notify("Неверный Static ID", "Введите 6 цифр в формате 123-456");
          return;
        }

        const firstName = cleanText(qs("#first-name").value);
        const lastName = cleanText(qs("#last-name").value);
        if (!firstName || !lastName) {
          notify("Заполни имя и фамилию", "Эти поля обязательны");
          return;
        }

        if (existing && (!signedIn || signedIn.staticId !== staticId)) {
          notify("Static ID уже зарегистрирован", "Войди в существующий аккаунт");
          if (typeof showAuthMode === "function") showAuthMode("login");
          qs("#login-static").value = staticId;
          return;
        }

        if (!existing && password.length < 6) {
          notify("Нужен пароль", "Минимум 6 символов");
          qs("#password").focus();
          return;
        }

        if (password && password !== confirmation) {
          notify("Пароли не совпадают", "Проверь оба поля");
          qs("#password-confirm").focus();
          return;
        }

        const passwordHash = password ? await makePasswordHash(staticId, password) : existing?.passwordHash;
        if (!passwordHash) {
          notify("Нужен пароль", "Минимум 6 символов");
          return;
        }

        const makeThisOwner = !existing && !ownerExists() && Object.keys(cachedAccounts).length === 0;
        const profile = {
          staticId,
          login: staticId,
          firstName,
          lastName,
          rank: qs("#rank").value,
          callsign: qs("#callsign").value.trim(),
          roles: existing?.roles || (makeThisOwner ? ["owner", "developer", "admin", "earnings", "user"] : ["user"]),
          isActive: true
        };

        const saved = await saveUser(profile, passwordHash, { forceOwner: makeThisOwner || Boolean(existing?.isOwner) });
        await loadAllUsers();
        setSignedIn(cachedAccounts[saved.staticId] || saved);

        if (typeof toggleModal === "function") toggleModal("profile-modal", false);
        notify("Профиль сохранён", `${saved.rank} ${saved.lastName}`);

        if (saved.isOwner || makeThisOwner) notify("Ты главный на сайте", "Это первый аккаунт в базе");
      } catch (error) {
        notify("Профиль не сохранён", error.message);
      }
    }, true);
  }

  function takeOverLogoutButton() {
    const button = qs("#logout-button");
    if (!button) return;

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearSignedIn();
      if (typeof switchTab === "function") switchTab("shift");
      if (typeof showAuthMode === "function") showAuthMode("login");
      button.hidden = true;
      notify("Вы вышли", "Сессия очищена");
    }, true);
  }

  function takeOverAccessForm() {
    const form = qs("#access-form");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      try {
        const owner = currentOnlineAccount();
        if (!owner?.isOwner) {
          notify("Недостаточно прав", "Доступ выдаёт только главный аккаунт");
          return;
        }
        await toggleRole(normalizeStaticId(qs("#access-static").value), "earnings");
        form.reset();
      } catch (error) {
        notify("Права не изменены", error.message);
      }
    }, true);
  }

  function takeOverDeveloperControls() {
    ["#developer-role-static"].forEach((selector) => {
      const input = qs(selector);
      if (input) input.addEventListener("input", (event) => { event.target.value = normalizeStaticId(event.target.value); });
    });

    const refresh = qs("#developer-refresh");
    if (refresh) refresh.addEventListener("click", async () => {
      try {
        await loadAllUsers();
        await migrateLocalAccountsToDatabase();
        renderDeveloperPanel();
        notify("Список обновлён", `${Object.keys(cachedAccounts).length} аккаунтов`);
      } catch (error) {
        notify("Не удалось обновить", error.message);
      }
    });

    const exportButton = qs("#developer-export");
    if (exportButton) exportButton.addEventListener("click", () => {
      const data = JSON.stringify(Object.values(cachedAccounts), null, 2);
      const blob = new Blob([data], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `rppilot-users-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify("Backup скачан", "JSON со списком аккаунтов");
    });

    const form = qs("#developer-role-form");
    if (form) form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const staticId = normalizeStaticId(qs("#developer-role-static").value);
      const role = qs("#developer-role-select").value;
      await toggleRole(staticId, role);
      form.reset();
    });
  }

  function updateTexts() {
    const modalText = document.querySelector("#profile-modal .modal-description");
    if (modalText) modalText.textContent = "Аккаунты сохраняются в общей базе сайта. Первый зарегистрированный аккаунт становится главным.";
    const hint = document.querySelector("#profile-form .form-hint");
    if (hint) hint.textContent = "При первой регистрации пароль обязателен. Уже созданные локальные аккаунты автоматически переносятся в базу.";
    const developerIntro = document.querySelector("#developer .page-heading p:last-child");
    if (developerIntro) developerIntro.textContent = "Управление общей базой, пользователями и правами. Первый аккаунт в базе является главным.";
  }

  async function start() {
    if (started) return;
    started = true;

    if (!window.supabase?.createClient) {
      notify("Supabase не подключён", "Проверь CDN-скрипт в index.html");
      return;
    }

    if (!window.RPPILOT_SUPABASE_URL || !window.RPPILOT_SUPABASE_ANON_KEY ||
        window.RPPILOT_SUPABASE_URL.includes("PASTE-YOUR-PROJECT") ||
        window.RPPILOT_SUPABASE_ANON_KEY.includes("PASTE-YOUR-ANON")) {
      notify("База не настроена", "Нужны URL и anon key Supabase; без них сайт не знает, куда сохранять аккаунты");
      return;
    }

    db = window.supabase.createClient(window.RPPILOT_SUPABASE_URL, window.RPPILOT_SUPABASE_ANON_KEY);

    patchOriginalFunctions();
    updateTexts();
    takeOverLoginForm();
    takeOverProfileForm();
    takeOverLogoutButton();
    takeOverAccessForm();
    takeOverDeveloperControls();

    try {
      await loadAllUsers();
      await migrateLocalAccountsToDatabase();
      await refreshSession();
      updateProtectedUI();
      renderDeveloperPanel();
      notify("База подключена", ownerExists() ? "Регистрация сохраняется онлайн" : "Первый зарегистрированный станет главным");
    } catch (error) {
      notify("База не подключилась", error.message);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
