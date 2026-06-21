/* =========================================================
   R. NOTE — Restricted Notebook
   Client-side encryption + UI logic
   Zero servers. Zero accounts. Zero cloud storage.
   File format: .rna (RNA_NOTEBOOK_V1)
   ========================================================= */

(() => {
  "use strict";

  // ---- Constants ----
  const RNA_FORMAT = "RNA";
  const RNA_VERSION = 1;
  const RNA_SIGNATURE = "RNA_NOTEBOOK_V1::"; // hidden validation marker, never shown to the user
  const PBKDF2_ITERATIONS = 250000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12; // recommended for AES-GCM

  // ---- DOM shortcuts ----
  const $ = (id) => document.getElementById(id);

  const screens = {
    home: $("screen-home"),
    new: $("screen-new"),
    upload: $("screen-upload"),
    view: $("screen-view"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    window.scrollTo(0, 0);
  }

  // =========================================================
  // CRYPTO CORE — Web Crypto API only. No custom algorithms.
  // =========================================================

  function randomBytes(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return arr;
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * Derives an AES-256-GCM key from a password using PBKDF2.
   * Salt must be unique per file. Iteration count is intentionally high
   * to slow down brute-force attempts on a leaked .rna file.
   */
  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypts notebook data into the .rna JSON envelope.
   * The hidden signature is prepended before encryption so that
   * decryption can verify the password was correct without ever
   * storing the password itself.
   */
  async function encryptNotebook(title, body, password) {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = await deriveKey(password, salt);

    const payload = JSON.stringify({ title, body, savedAt: new Date().toISOString() });
    const signed = RNA_SIGNATURE + payload;

    const enc = new TextEncoder();
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(signed)
    );

    return {
      format: RNA_FORMAT,
      version: RNA_VERSION,
      salt: bufToBase64(salt),
      iv: bufToBase64(iv),
      ciphertext: bufToBase64(ciphertextBuf),
    };
  }

  /**
   * Attempts to decrypt an .rna envelope. Returns { ok: true, title, body }
   * on success, or { ok: false } if the password is wrong or the file
   * is corrupted / not a genuine RNA file.
   */
  async function decryptNotebook(envelope, password) {
    try {
      if (envelope.format !== RNA_FORMAT) return { ok: false };

      const salt = base64ToBuf(envelope.salt);
      const iv = base64ToBuf(envelope.iv);
      const ciphertext = base64ToBuf(envelope.ciphertext);
      const key = await deriveKey(password, salt);

      const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      const plainText = new TextDecoder().decode(plainBuf);

      if (!plainText.startsWith(RNA_SIGNATURE)) {
        return { ok: false };
      }

      const json = plainText.slice(RNA_SIGNATURE.length);
      const data = JSON.parse(json);
      return { ok: true, title: data.title || "", body: data.body || "" };
    } catch (err) {
      // Wrong password produces a decrypt failure (GCM auth tag mismatch)
      // or, rarely, a parse error — both mean "incorrect password or corrupted file".
      return { ok: false };
    }
  }

  function triggerDownload(filename, jsonObject) {
    const blob = new Blob([JSON.stringify(jsonObject)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".rna") ? filename : filename + ".rna";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function sanitizeFilename(name) {
    const trimmed = (name || "Untitled Notebook").trim() || "Untitled Notebook";
    return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
  }

  // =========================================================
  // STATS (word count / char count / reading time)
  // =========================================================

  function computeStats(text) {
    const trimmed = text.trim();
    const words = trimmed.length ? trimmed.split(/\s+/).length : 0;
    const chars = text.length;
    const minutes = words / 200; // average reading speed
    let readTime;
    if (words === 0) readTime = "0 min";
    else if (minutes < 1) readTime = "<1 min";
    else readTime = Math.ceil(minutes) + " min";
    return { words, chars, readTime };
  }

  function bindStats(textarea, wordsEl, charsEl, readTimeEl) {
    const update = () => {
      const { words, chars, readTime } = computeStats(textarea.value);
      wordsEl.textContent = words;
      charsEl.textContent = chars;
      readTimeEl.textContent = readTime;
    };
    textarea.addEventListener("input", update);
    update();
    return update;
  }

  // =========================================================
  // PASSWORD VISIBILITY TOGGLES
  // =========================================================

  function bindPasswordToggle(toggleBtn, input) {
    toggleBtn.addEventListener("click", () => {
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      toggleBtn.textContent = isHidden ? "🙈" : "👁";
      toggleBtn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    });
  }

  // =========================================================
  // HOME NAVIGATION
  // =========================================================

  $("btnNewNotebook").addEventListener("click", () => {
    resetNewScreen();
    showScreen("new");
  });

  $("btnUploadNotebook").addEventListener("click", () => {
    resetUploadScreen();
    showScreen("upload");
  });

  $("backFromNew").addEventListener("click", () => showScreen("home"));
  $("backFromUpload").addEventListener("click", () => showScreen("home"));
  $("backFromView").addEventListener("click", () => showScreen("home"));

  // =========================================================
  // NEW NOTEBOOK SCREEN
  // =========================================================

  const titleInput = $("titleInput");
  const bodyInput = $("bodyInput");
  const passwordInput = $("passwordInput");
  const encryptStatus = $("encryptStatus");

  bindStats(bodyInput, $("statWords"), $("statChars"), $("statReadTime"));
  bindPasswordToggle($("pwToggleNew"), passwordInput);

  function resetNewScreen() {
    titleInput.value = "";
    bodyInput.value = "";
    passwordInput.value = "";
    passwordInput.type = "password";
    $("pwToggleNew").textContent = "👁";
    encryptStatus.textContent = "";
    encryptStatus.className = "status-line";
    bodyInput.dispatchEvent(new Event("input"));
  }

  function setStatus(el, message, kind) {
    el.textContent = message;
    el.className = "status-line" + (kind ? " " + kind : "");
  }

  $("btnEncrypt").addEventListener("click", async () => {
    const title = titleInput.value.trim() || "Untitled Notebook";
    const body = bodyInput.value;
    const password = passwordInput.value;

    if (!body.trim()) {
      setStatus(encryptStatus, "Write something before encrypting.", "error");
      return;
    }
    if (!password) {
      setStatus(encryptStatus, "Choose a password to protect this notebook.", "error");
      return;
    }
    if (password.length < 4) {
      setStatus(encryptStatus, "Use a longer password — at least 4 characters.", "error");
      return;
    }

    setStatus(encryptStatus, "Encrypting locally in your browser…", "info");
    try {
      const envelope = await encryptNotebook(title, body, password);
      triggerDownload(sanitizeFilename(title), envelope);
      setStatus(encryptStatus, "Encrypted and downloaded as " + sanitizeFilename(title) + ".rna", "success");
    } catch (err) {
      setStatus(encryptStatus, "Encryption failed. Please try again.", "error");
    }
  });

  $("btnClearNew").addEventListener("click", () => {
    resetNewScreen();
  });

  // =========================================================
  // UPLOAD / UNLOCK SCREEN
  // =========================================================

  const dropzone = $("dropzone");
  const fileInput = $("fileInput");
  const unlockCard = $("unlockCard");
  const dropzoneFilename = $("dropzoneFilename");
  const unlockPassword = $("unlockPassword");
  const unlockStatus = $("unlockStatus");

  bindPasswordToggle($("pwToggleUnlock"), unlockPassword);

  let pendingEnvelope = null;
  let pendingFilenameBase = "Untitled Notebook";

  function resetUploadScreen() {
    pendingEnvelope = null;
    pendingFilenameBase = "Untitled Notebook";
    dropzoneFilename.textContent = "";
    unlockCard.hidden = true;
    unlockPassword.value = "";
    unlockPassword.type = "password";
    $("pwToggleUnlock").textContent = "👁";
    setStatus(unlockStatus, "", "");
    fileInput.value = "";
  }

  $("btnBrowseFile").addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target.id !== "btnBrowseFile") fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) handleFile(file);
  });

  function handleFile(file) {
    pendingFilenameBase = file.name.replace(/\.rna$/i, "");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const envelope = JSON.parse(reader.result);
        if (envelope.format !== RNA_FORMAT) {
          dropzoneFilename.textContent = "This does not look like a valid .rna file.";
          pendingEnvelope = null;
          unlockCard.hidden = true;
          return;
        }
        pendingEnvelope = envelope;
        dropzoneFilename.textContent = "Loaded: " + file.name;
        unlockCard.hidden = false;
        unlockPassword.focus();
        setStatus(unlockStatus, "", "");
      } catch (err) {
        dropzoneFilename.textContent = "Could not read this file. Is it a genuine .rna file?";
        pendingEnvelope = null;
        unlockCard.hidden = true;
      }
    };
    reader.onerror = () => {
      dropzoneFilename.textContent = "Failed to read the file.";
    };
    reader.readAsText(file);
  }

  $("btnUnlock").addEventListener("click", async () => {
    if (!pendingEnvelope) {
      setStatus(unlockStatus, "Upload an .rna file first.", "error");
      return;
    }
    const password = unlockPassword.value;
    if (!password) {
      setStatus(unlockStatus, "Enter the notebook password.", "error");
      return;
    }

    setStatus(unlockStatus, "Decrypting locally…", "info");
    const result = await decryptNotebook(pendingEnvelope, password);

    if (!result.ok) {
      setStatus(unlockStatus, "Incorrect password or corrupted RNA file.", "error");
      return;
    }

    setStatus(unlockStatus, "Unlocked.", "success");
    openViewScreen(result.title, result.body);
  });

  // =========================================================
  // VIEW / RE-ENCRYPT SCREEN
  // =========================================================

  const viewTitleInput = $("viewTitleInput");
  const viewBodyInput = $("viewBodyInput");
  const reEncryptStatus = $("reEncryptStatus");
  let currentUnlockPassword = "";

  bindStats(viewBodyInput, $("viewStatWords"), $("viewStatChars"), $("viewStatReadTime"));

  function openViewScreen(title, body) {
    viewTitleInput.value = title;
    viewBodyInput.value = body;
    currentUnlockPassword = unlockPassword.value;
    viewBodyInput.dispatchEvent(new Event("input"));
    setStatus(reEncryptStatus, "", "");
    showScreen("view");
  }

  $("btnReEncrypt").addEventListener("click", async () => {
    const title = viewTitleInput.value.trim() || "Untitled Notebook";
    const body = viewBodyInput.value;

    if (!currentUnlockPassword) {
      setStatus(reEncryptStatus, "Original password unavailable — please re-open via Upload.", "error");
      return;
    }

    setStatus(reEncryptStatus, "Encrypting locally…", "info");
    try {
      const envelope = await encryptNotebook(title, body, currentUnlockPassword);
      triggerDownload(sanitizeFilename(title), envelope);
      setStatus(reEncryptStatus, "Re-encrypted and downloaded as " + sanitizeFilename(title) + ".rna", "success");
    } catch (err) {
      setStatus(reEncryptStatus, "Encryption failed. Please try again.", "error");
    }
  });

  // =========================================================
  // PANIC LOCK
  // =========================================================

  const panicFlash = $("panicFlash");

  function panicLock() {
    // Immediately wipe all visible content — no save, no trace.
    titleInput.value = "";
    bodyInput.value = "";
    passwordInput.value = "";
    viewTitleInput.value = "";
    viewBodyInput.value = "";
    unlockPassword.value = "";
    currentUnlockPassword = "";
    pendingEnvelope = null;
    resetUploadScreen();
    bodyInput.dispatchEvent(new Event("input"));
    viewBodyInput.dispatchEvent(new Event("input"));

    panicFlash.classList.add("flashing");
    setTimeout(() => {
      showScreen("home");
      panicFlash.classList.remove("flashing");
    }, 140);
  }

  $("panicLockNew").addEventListener("click", panicLock);
  $("panicLockView").addEventListener("click", panicLock);

  // Quick keyboard panic shortcut: Escape, twice within 600ms
  let lastEscape = 0;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const now = Date.now();
      if (now - lastEscape < 600) panicLock();
      lastEscape = now;
    }
  });

  // =========================================================
  // DARK MODE
  // =========================================================

  const darkToggle = $("darkToggle");
  const darkIcon = darkToggle.querySelector(".dark-toggle-icon");
  const DARK_KEY = "r-note-dark-mode"; // UI preference only — never notebook content

  function applyDarkMode(isDark) {
    document.body.classList.toggle("dark", isDark);
    darkIcon.textContent = isDark ? "☀" : "🌙";
    darkToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  }

  function initDarkMode() {
    let preferred = null;
    try {
      preferred = localStorage.getItem(DARK_KEY);
    } catch (e) {
      /* localStorage unavailable — fall back to system preference */
    }
    if (preferred === null) {
      preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "1" : "0";
    }
    applyDarkMode(preferred === "1");
  }

  darkToggle.addEventListener("click", () => {
    const isDark = !document.body.classList.contains("dark");
    applyDarkMode(isDark);
    try {
      localStorage.setItem(DARK_KEY, isDark ? "1" : "0");
    } catch (e) {
      /* ignore storage errors */
    }
  });

  initDarkMode();

  // =========================================================
  // INIT
  // =========================================================
  showScreen("home");
})();
