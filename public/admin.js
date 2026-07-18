const state = {
  token: localStorage.getItem("session_token") || "",
  user: JSON.parse(localStorage.getItem("session_user") || "null"),
  users: [],
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-session-token": state.token,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function denyAccess(message) {
  document.getElementById("admin-app").classList.add("hidden");
  document.getElementById("denied-message").textContent = message;
  document.getElementById("denied-screen").classList.remove("hidden");
}

async function loadUsers() {
  state.users = await api("/api/admin/users");
  renderUsers();
}

function roleLabel(role) {
  return role === "admin" ? "Admin" : "User";
}

function renderUsers() {
  const body = document.getElementById("users-body");
  body.innerHTML = "";
  state.users.forEach((u) => {
    const isSelf = u.id === state.user.id;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="label-cell">${escapeHtml(u.username)}${isSelf ? ' <span class="muted small">(คุณ)</span>' : ""}</td>
      <td class="label-cell">${roleLabel(u.role)}</td>
      <td class="muted small">${u.createdAt ? new Date(u.createdAt).toLocaleDateString("th-TH") : "–"}</td>
      <td class="row-actions">
        <button class="icon-btn" data-action="reset" title="ตั้งรหัสผ่านใหม่">✎</button>
        <button class="icon-btn" data-action="delete" title="ลบผู้ใช้" ${isSelf ? "disabled" : ""}>✕</button>
      </td>
    `;
    tr.querySelector('[data-action="reset"]').onclick = () => openResetPassword(u);
    tr.querySelector('[data-action="delete"]').onclick = () => deleteUser(u);
    body.appendChild(tr);
  });
}

async function deleteUser(u) {
  if (!confirm(`ลบผู้ใช้ "${u.username}"? การลบนี้จะลบ portfolio และ transaction ทั้งหมดของผู้ใช้นี้ไปด้วย และไม่สามารถกู้คืนได้`)) return;
  try {
    await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
    await loadUsers();
  } catch (err) {
    alert("ลบไม่สำเร็จ: " + err.message);
  }
}

// ---------- Add user ----------
const addUserModal = document.getElementById("adduser-modal");
document.getElementById("btn-add-user").addEventListener("click", () => {
  document.getElementById("adduser-form").reset();
  addUserModal.classList.remove("hidden");
});
document.getElementById("btn-cancel-adduser").addEventListener("click", () => {
  addUserModal.classList.add("hidden");
});
document.getElementById("adduser-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("adduser-username").value.trim();
  const password = document.getElementById("adduser-password").value;
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password }) });
    addUserModal.classList.add("hidden");
    await loadUsers();
    alert(`สร้างผู้ใช้ "${username}" สำเร็จ — แจ้งรหัสผ่านนี้ให้ผู้ใช้เพื่อเข้าสู่ระบบ (แนะนำให้เปลี่ยนภายหลัง)`);
  } catch (err) {
    alert("สร้างผู้ใช้ไม่สำเร็จ: " + err.message);
  }
});

// ---------- Reset password ----------
const resetPwModal = document.getElementById("resetpw-modal");
let resetPwUserId = null;
function openResetPassword(u) {
  resetPwUserId = u.id;
  document.getElementById("resetpw-username").textContent = u.username;
  document.getElementById("resetpw-form").reset();
  resetPwModal.classList.remove("hidden");
}
document.getElementById("btn-cancel-resetpw").addEventListener("click", () => {
  resetPwModal.classList.add("hidden");
});
document.getElementById("resetpw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = document.getElementById("resetpw-password").value;
  try {
    await api(`/api/admin/users/${resetPwUserId}/password`, { method: "PUT", body: JSON.stringify({ password }) });
    resetPwModal.classList.add("hidden");
    alert("ตั้งรหัสผ่านใหม่สำเร็จ");
  } catch (err) {
    alert("ตั้งรหัสผ่านไม่สำเร็จ: " + err.message);
  }
});

// ---------- Init ----------
(async function init() {
  if (!state.token || !state.user) {
    denyAccess("กรุณาเข้าสู่ระบบก่อน");
    return;
  }
  if (state.user.role !== "admin") {
    denyAccess("หน้านี้สำหรับ admin เท่านั้น");
    return;
  }
  document.getElementById("admin-app").classList.remove("hidden");
  try {
    await loadUsers();
  } catch (e) {
    denyAccess("โหลดข้อมูลไม่สำเร็จ: " + e.message);
  }
})();
