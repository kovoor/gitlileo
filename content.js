(() => {
  const STATE = {
    owner: null,
    repo: null,
    page: 1,
    hasMore: false,
    loading: false,
    token: null,
    mode: "session",
    loggedIn: false
  };

  const SELECTORS = {
    starForms: [
      "form[action$='/star']",
      "form[action$='/unstar']"
    ].join(",")
  };

  const STORAGE_KEY = "gitlileo_pat";
  let ui = null;
  let scanTimer = null;

  function debounceScan() {
    if (scanTimer) {
      window.clearTimeout(scanTimer);
    }
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      injectButtons();
      injectPinnedCardButtons();
      injectPopularRepoButtons();
    }, 160);
  }

  function parseRepoFromAction(action) {
    if (!action) return null;
    const match = action.match(/\/([^/]+)\/([^/]+)\/(?:un)?star(?:\?|$)/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2]
    };
  }

  function parseRepoFromHref(href) {
    if (!href) return null;
    const clean = href.split("?")[0].split("#")[0].replace(/\/$/, "");
    const match = clean.match(/^\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2]
    };
  }

  function parseRepoFromStargazersHref(href) {
    if (!href) return null;
    const clean = href.split("?")[0].split("#")[0].replace(/\/$/, "");
    const match = clean.match(/^\/([^/]+)\/([^/]+)\/stargazers$/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2]
    };
  }

  function isLoggedIn() {
    const loginMeta = document.querySelector("meta[name='user-login']");
    return Boolean(loginMeta && loginMeta.getAttribute("content"));
  }

  function htmlToDoc(text) {
    return new DOMParser().parseFromString(text, "text/html");
  }

  function uniqByUsername(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.username)) {
        return false;
      }
      seen.add(item.username);
      return true;
    });
  }

  function usernameFromHref(href) {
    if (!href) return "";
    const clean = href.split("?")[0].split("#")[0];
    if (!/^\/[A-Za-z0-9-]+$/.test(clean)) return "";
    return clean.slice(1);
  }

  async function getToken() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve(window.localStorage.getItem(STORAGE_KEY) || "");
        return;
      }
      chrome.storage.sync.get([STORAGE_KEY], (result) => {
        resolve(result[STORAGE_KEY] || "");
      });
    });
  }

  async function setToken(token) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        window.localStorage.setItem(STORAGE_KEY, token);
        resolve();
        return;
      }
      chrome.storage.sync.set({ [STORAGE_KEY]: token }, () => resolve());
    });
  }

  async function clearToken() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        window.localStorage.removeItem(STORAGE_KEY);
        resolve();
        return;
      }
      chrome.storage.sync.remove([STORAGE_KEY], () => resolve());
    });
  }

  function updateMode() {
    STATE.mode = STATE.token ? "token" : "session";
  }

  async function fetchStargazersByApi(owner, repo, page, token) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=30&page=${page}`,
      {
        headers
      }
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(token ? "Token auth failed or hit API limits." : "GitHub API rate limit reached.");
      }
      if (response.status === 404) {
        throw new Error("Repository not found or private.");
      }
      throw new Error("GitHub API request failed.");
    }

    const data = await response.json();
    const linkHeader = response.headers.get("link") || "";
    const hasMore = /rel="next"/.test(linkHeader);
    const users = data.map((item) => ({
      username: item.login,
      profileUrl: item.html_url,
      avatarUrl: item.avatar_url,
      source: "api"
    }));

    return { users, hasMore };
  }

  async function fetchStargazersBySession(owner, repo, page) {
    const response = await fetch(
      `https://github.com/${owner}/${repo}/stargazers?page=${page}`,
      {
        credentials: "include"
      }
    );

    if (!response.ok) {
      throw new Error("Could not load stargazers page.");
    }

    if (response.redirected && /\/login/.test(response.url)) {
      const error = new Error("Please log in to GitHub.");
      error.code = "LOGIN_REQUIRED";
      throw error;
    }

    const text = await response.text();
    if (/name="login"/.test(text) && /Sign in to GitHub/.test(text)) {
      const error = new Error("Please log in to GitHub.");
      error.code = "LOGIN_REQUIRED";
      throw error;
    }

    const doc = htmlToDoc(text);
    const users = [];

    const roots = [
      ...doc.querySelectorAll(".follow-list, .Box")
    ];
    const scanRoots = roots.length ? roots : [doc];

    scanRoots.forEach((root) => {
      const avatarImages = root.querySelectorAll("img.avatar, img.avatar-user");
      avatarImages.forEach((img) => {
        const link = img.closest("a[href^='/']");
        if (!link) return;
        const href = link.getAttribute("href") || "";
        const username = usernameFromHref(href);
        if (!username) return;

        users.push({
          username,
          profileUrl: `https://github.com/${username}`,
          avatarUrl: img.getAttribute("src") || "",
          source: "session"
        });
      });
    });

    if (!users.length) {
      const profileLinks = doc.querySelectorAll("a[data-hovercard-type='user'][href^='/'], a.Link--primary[href^='/']");
      profileLinks.forEach((link) => {
        if (!(link instanceof HTMLAnchorElement)) return;
        const href = link.getAttribute("href") || "";
        const username = usernameFromHref(href);
        if (!username) return;
        const img = link.querySelector("img.avatar, img.avatar-user") || link.closest("li, div")?.querySelector("img.avatar, img.avatar-user");

        users.push({
          username,
          profileUrl: `https://github.com/${username}`,
          avatarUrl: img ? img.getAttribute("src") || "" : "",
          source: "session"
        });
      });
    }

    return {
      users: uniqByUsername(users),
      hasMore: Boolean(doc.querySelector("a[rel='next']"))
    };
  }

  async function fetchStargazers(owner, repo, page) {
    if (STATE.token) {
      return fetchStargazersByApi(owner, repo, page, STATE.token);
    }

    try {
      return await fetchStargazersByApi(owner, repo, page, "");
    } catch (error) {
      return fetchStargazersBySession(owner, repo, page);
    }
  }

  function renderRows(users, append = false) {
    const list = ui.list;
    if (!append) {
      list.innerHTML = "";
    }

    users.forEach((user, index) => {
      const row = document.createElement("a");
      row.className = "gitlileo-user";
      row.href = user.profileUrl;
      row.target = "_blank";
      row.rel = "noreferrer";
      row.style.animationDelay = `${index * 30}ms`;
      row.innerHTML = [
        `<img src="${user.avatarUrl || "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png"}" alt="${user.username} avatar" class="gitlileo-avatar" />`,
        `<div class="gitlileo-user-meta">`,
        `<strong>@${user.username}</strong>`,
        `<span>${user.source === "api" ? "Token mode" : "Session mode"}</span>`,
        `</div>`,
        `<span class="gitlileo-link">Profile</span>`
      ].join("");
      list.appendChild(row);
    });
  }

  function setStatus(kind, message) {
    ui.status.className = `gitlileo-status ${kind}`;
    ui.status.textContent = message;
    ui.status.hidden = !message;
  }

  function updateHeader() {
    ui.repoName.textContent = STATE.owner && STATE.repo
      ? `${STATE.owner}/${STATE.repo}`
      : "-";
    ui.modeChip.textContent = STATE.mode === "token"
      ? "Token mode"
      : "Session mode";
  }

  async function loadPage(nextPage, append) {
    if (!STATE.owner || !STATE.repo || STATE.loading) return;
    STATE.loading = true;
    ui.loadMore.disabled = true;
    ui.loadMore.textContent = append ? "Loading..." : "Load more";
    if (!append) {
      setStatus("loading", "Gathering stargazers...");
    }

    try {
      const result = await fetchStargazers(STATE.owner, STATE.repo, nextPage);
      STATE.page = nextPage;
      STATE.hasMore = result.hasMore;

      if (!result.users.length && !append) {
        setStatus("empty", "No stargazers found yet.");
        renderRows([]);
      } else {
        setStatus("", "");
        renderRows(result.users, append);
      }

      ui.loadMore.hidden = !STATE.hasMore;
      ui.loadMore.disabled = false;
      ui.loadMore.textContent = "Load more";
    } catch (error) {
      if (error.code === "LOGIN_REQUIRED") {
        setStatus("error", "You are logged out. Log in to GitHub to use session mode.");
        ui.loginCta.hidden = false;
      } else {
        setStatus("error", error.message || "Something went wrong while fetching stargazers.");
      }
      ui.loadMore.hidden = true;
    } finally {
      STATE.loading = false;
    }
  }

  async function applySettingsState() {
    STATE.token = (await getToken()).trim();
    STATE.loggedIn = isLoggedIn();
    updateMode();
    updateHeader();

    ui.tokenInput.value = STATE.token;
    ui.tokenStatus.textContent = STATE.token
      ? "Token saved. Using API mode."
      : "No token saved. Using session mode.";

    if (!STATE.token && !STATE.loggedIn) {
      ui.loginCta.hidden = false;
      setStatus("error", "Please log in to GitHub, or add a token for API mode.");
    } else {
      ui.loginCta.hidden = true;
    }
  }

  async function openPanel(owner, repo) {
    if (!ui) {
      buildUI();
    }
    STATE.owner = owner;
    STATE.repo = repo;
    STATE.page = 1;
    STATE.hasMore = false;

    ui.root.hidden = false;
    requestAnimationFrame(() => ui.root.classList.add("is-open"));

    await applySettingsState();
    await loadPage(1, false);
  }

  function closePanel() {
    if (!ui) return;
    ui.root.classList.remove("is-open");
    window.setTimeout(() => {
      ui.root.hidden = true;
    }, 180);
  }

  function buildUI() {
    const root = document.createElement("section");
    root.className = "gitlileo-overlay";
    root.hidden = true;

    root.innerHTML = `
      <div class="gitlileo-backdrop" data-close="true"></div>
      <aside class="gitlileo-panel" role="dialog" aria-modal="true" aria-label="View Who Starred Your Project">
        <header class="gitlileo-header">
          <div>
            <p class="gitlileo-eyebrow">gitlileo</p>
            <h2>View Who Starred Your Project</h2>
            <p class="gitlileo-repo"></p>
          </div>
          <button class="gitlileo-close" type="button" aria-label="Close panel">Close</button>
        </header>

        <div class="gitlileo-toolbar">
          <span class="gitlileo-chip"></span>
          <button class="gitlileo-settings-toggle" type="button">Settings</button>
        </div>

        <section class="gitlileo-settings" hidden>
          <p>Add a GitHub Personal Access Token for stronger API reliability.</p>
          <label>
            <span>Token (optional)</span>
            <input class="gitlileo-token-input" type="password" autocomplete="off" placeholder="ghp_..." />
          </label>
          <div class="gitlileo-settings-actions">
            <button class="gitlileo-save-token" type="button">Save token</button>
            <button class="gitlileo-clear-token" type="button">Clear</button>
          </div>
          <small class="gitlileo-token-status"></small>
        </section>

        <div class="gitlileo-status" hidden></div>
        <a class="gitlileo-login" href="https://github.com/login" target="_blank" rel="noreferrer" hidden>Log in to GitHub</a>
        <div class="gitlileo-list" aria-live="polite"></div>
        <button class="gitlileo-load-more" type="button" hidden>Load more</button>
      </aside>
    `;

    document.body.appendChild(root);

    ui = {
      root,
      repoName: root.querySelector(".gitlileo-repo"),
      modeChip: root.querySelector(".gitlileo-chip"),
      status: root.querySelector(".gitlileo-status"),
      list: root.querySelector(".gitlileo-list"),
      loadMore: root.querySelector(".gitlileo-load-more"),
      loginCta: root.querySelector(".gitlileo-login"),
      settings: root.querySelector(".gitlileo-settings"),
      settingsToggle: root.querySelector(".gitlileo-settings-toggle"),
      tokenInput: root.querySelector(".gitlileo-token-input"),
      tokenStatus: root.querySelector(".gitlileo-token-status"),
      saveToken: root.querySelector(".gitlileo-save-token"),
      clearToken: root.querySelector(".gitlileo-clear-token")
    };

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.close === "true" || target.classList.contains("gitlileo-close")) {
        closePanel();
      }
    });

    ui.loadMore.addEventListener("click", () => {
      loadPage(STATE.page + 1, true);
    });

    ui.settingsToggle.addEventListener("click", () => {
      ui.settings.hidden = !ui.settings.hidden;
    });

    ui.saveToken.addEventListener("click", async () => {
      const token = ui.tokenInput.value.trim();
      if (!token) {
        ui.tokenStatus.textContent = "Paste a token before saving.";
        return;
      }
      await setToken(token);
      STATE.token = token;
      updateMode();
      updateHeader();
      ui.tokenStatus.textContent = "Token saved. Reloading stargazers in API mode...";
      await loadPage(1, false);
    });

    ui.clearToken.addEventListener("click", async () => {
      await clearToken();
      STATE.token = "";
      updateMode();
      updateHeader();
      ui.tokenInput.value = "";
      ui.tokenStatus.textContent = "Token removed. Back to session mode.";
      await loadPage(1, false);
    });
  }

  function createTrigger(owner, repo, variant = "default") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gitlileo-trigger";
    if (variant === "header") {
      button.classList.add("gitlileo-trigger-header");
    }
    button.dataset.owner = owner;
    button.dataset.repo = repo;
    button.innerHTML = [
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">',
      '<path d="M8 .75l2.1 4.26 4.7.68-3.4 3.32.8 4.69L8 11.49 3.8 13.7l.8-4.69L1.2 5.69l4.7-.68L8 .75z"></path>',
      "</svg>",
      "<span>View Who Starred</span>"
    ].join("");
    button.title = "View Who Starred";
    button.setAttribute("aria-label", "View Who Starred");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel(owner, repo);
    });
    return button;
  }

  function injectButtons() {
    const forms = document.querySelectorAll(SELECTORS.starForms);
    forms.forEach((form) => {
      if (!(form instanceof HTMLElement)) return;
      if (form.dataset.gitlileoAttached === "true") return;

      const action = form.getAttribute("action") || "";
      const parsed = parseRepoFromAction(action);
      if (!parsed) return;

      const group = form.closest(".BtnGroup");
      const insertionAnchor = group || form;
      const wrapper = insertionAnchor.parentElement;
      if (!wrapper) return;

      const isHeaderSocialContainer = wrapper.matches(
        ".js-social-container.starring-container, .js-social-container.js-toggler-container.starring-container"
      );

      const alreadyInjected = wrapper.querySelector(`.gitlileo-trigger[data-owner="${parsed.owner}"][data-repo="${parsed.repo}"]`)
        || wrapper.parentElement?.querySelector(`.gitlileo-trigger[data-owner="${parsed.owner}"][data-repo="${parsed.repo}"]`);
      if (alreadyInjected) {
        form.dataset.gitlileoAttached = "true";
        return;
      }

      const trigger = createTrigger(
        parsed.owner,
        parsed.repo,
        isHeaderSocialContainer ? "header" : "default"
      );

      wrapper.insertBefore(trigger, insertionAnchor);
      form.dataset.gitlileoAttached = "true";
    });
  }

  function injectPinnedCardButtons() {
    const cards = document.querySelectorAll(".pinned-item-list-item-content");
    cards.forEach((card) => {
      if (!(card instanceof HTMLElement)) return;

      const repoLink = card.querySelector(
        "a[itemprop='name codeRepository'][href^='/'], h3 a[href^='/'], h2 a[href^='/']"
      );
      if (!(repoLink instanceof HTMLAnchorElement)) return;

      const parsed = parseRepoFromHref(repoLink.getAttribute("href") || "");
      if (!parsed) return;

      const existing = card.querySelector(
        `.gitlileo-trigger-card[data-owner="${parsed.owner}"][data-repo="${parsed.repo}"]`
      );
      if (existing) return;

      const trigger = createTrigger(parsed.owner, parsed.repo);
      trigger.classList.add("gitlileo-trigger-card");

      const metaRow = card.querySelector(".pinned-item-meta");
      if (metaRow instanceof HTMLElement) {
        metaRow.appendChild(trigger);
      } else {
        card.appendChild(trigger);
      }
    });
  }

  function injectPopularRepoButtons() {
    const stargazerLinks = document.querySelectorAll("a[href$='/stargazers']");
    stargazerLinks.forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) return;

      const parsed = parseRepoFromStargazersHref(link.getAttribute("href") || "");
      if (!parsed) return;

      const card = link.closest("article, li, .pinned-item-list-item, .pinned-item-list-item-content, .Box-row, .col-12");
      if (!(card instanceof HTMLElement)) return;

      const existing = card.querySelector(
        `.gitlileo-trigger-popular[data-owner="${parsed.owner}"][data-repo="${parsed.repo}"]`
      );
      if (existing) return;

      const trigger = createTrigger(parsed.owner, parsed.repo);
      trigger.classList.add("gitlileo-trigger-popular");
      link.insertAdjacentElement("afterend", trigger);
    });
  }

  function boot() {
    injectButtons();
    injectPinnedCardButtons();
    injectPopularRepoButtons();

    const observer = new MutationObserver(() => {
      debounceScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    document.addEventListener("pjax:end", debounceScan);
    document.addEventListener("turbo:render", debounceScan);
  }

  boot();
})();
