/*
  RPpilot static database loader for GitHub Pages.

  Куда положить:
  - database.json
  - database.js

  Оба файла положить рядом с index.html и app.js.

  В index.html подключить после app.js:

  <script src="database.js"></script>

  Важно:
  GitHub Pages не может записывать изменения в database.json.
  Поэтому новые регистрации сохраняются в localStorage пользователя.
  Сам database.json используется как стартовая база и список заранее созданных аккаунтов.
*/

window.RPPILOT_DB = {
  raw: null,

  async load() {
    const response = await fetch("./database.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Не удалось загрузить database.json");
    }

    this.raw = await response.json();

    const localUsers = this.getLocalUsers();
    const fileUsers = this.raw.users || [];

    const merged = {};
    for (const user of fileUsers) merged[user.staticId] = user;
    for (const user of localUsers) merged[user.staticId] = user;

    localStorage.setItem("rppilot_users", JSON.stringify(Object.values(merged)));
    return this.raw;
  },

  getLocalUsers() {
    try {
      return JSON.parse(localStorage.getItem("rppilot_users") || "[]");
    } catch {
      return [];
    }
  },

  saveLocalUsers(users) {
    localStorage.setItem("rppilot_users", JSON.stringify(users));
  },

  getUsers() {
    return this.getLocalUsers();
  },

  findUser(staticId) {
    return this.getUsers().find((user) => user.staticId === staticId) || null;
  },

  registerUser(profile) {
    const users = this.getUsers();

    if (users.some((user) => user.staticId === profile.staticId)) {
      throw new Error("Пользователь с таким Static ID уже есть");
    }

    const user = {
      staticId: profile.staticId,
      login: profile.login || profile.staticId,
      password: profile.password,
      firstName: profile.firstName || "",
      lastName: profile.lastName || "",
      rank: profile.rank || "Рядовой",
      callsign: profile.callsign || "",
      roles: ["user"],
      isActive: true,
      createdAt: new Date().toISOString()
    };

    users.push(user);
    this.saveLocalUsers(users);
    return user;
  },

  login(staticId, password) {
    const user = this.findUser(staticId);

    if (!user || !user.isActive || user.password !== password) {
      throw new Error("Неверный Static ID или пароль");
    }

    localStorage.setItem("rppilot_current_static", user.staticId);
    return user;
  },

  logout() {
    localStorage.removeItem("rppilot_current_static");
  },

  currentUser() {
    const staticId = localStorage.getItem("rppilot_current_static");
    return staticId ? this.findUser(staticId) : null;
  },

  getRole(roleCode) {
    return this.raw?.roles?.[roleCode] || null;
  },

  hasRole(user, roleCode) {
    return Boolean(user?.roles?.includes(roleCode));
  },

  hasPermission(user, permission) {
    if (!user) return false;

    for (const roleCode of user.roles || []) {
      const role = this.getRole(roleCode);
      const permissions = role?.permissions || [];

      if (permissions.includes("*") || permissions.includes(permission)) {
        return true;
      }
    }

    return false;
  },

  grantRole(staticId, roleCode) {
    const current = this.currentUser();

    if (!this.hasPermission(current, "access.give")) {
      throw new Error("Недостаточно прав");
    }

    const users = this.getUsers();
    const user = users.find((item) => item.staticId === staticId);

    if (!user) {
      throw new Error("Пользователь не найден");
    }

    user.roles = Array.from(new Set([...(user.roles || []), roleCode]));
    this.saveLocalUsers(users);
    return user;
  },

  revokeRole(staticId, roleCode) {
    const current = this.currentUser();

    if (!this.hasPermission(current, "access.revoke")) {
      throw new Error("Недостаточно прав");
    }

    const users = this.getUsers();
    const user = users.find((item) => item.staticId === staticId);

    if (!user) {
      throw new Error("Пользователь не найден");
    }

    user.roles = (user.roles || []).filter((item) => item !== roleCode);
    this.saveLocalUsers(users);
    return user;
  }
};

document.addEventListener("DOMContentLoaded", () => {
  window.RPPILOT_DB.load()
    .then(() => console.log("RPpilot database loaded"))
    .catch((error) => console.error(error));
});
