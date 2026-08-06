const $ = (id) => document.getElementById(id);

      // Register the service worker so the dashboard is an installable PWA.
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
      }

      // --- Theme: System / Light / Dark (persisted) ---
      // The control is icon-only in the header, so the icon has to carry the
      // whole message: which mode is selected, and — for "system" — which way
      // the OS has currently resolved it.
      const themeSel = $("themeSel");
      const THEME_ICONS = {
        light:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6' +
          'M5.4 5.4l1.9 1.9M16.7 16.7l1.9 1.9M5.4 18.6l1.9-1.9M16.7 7.3l1.9-1.9"/></svg>',
        dark:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4z"/></svg>',
        // Half-filled disc: the "follow the system" state, tilted to whichever
        // side the system is actually on.
        system:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
      };
      function applyTheme() {
        const pref = localStorage.getItem("tessera_theme") || "system";
        themeSel.value = pref;
        const resolved =
          pref === "system"
            ? window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light"
            : pref;
        document.documentElement.setAttribute("data-theme", resolved);
        const ico = $("themeIco");
        if (ico) ico.innerHTML = THEME_ICONS[pref] || THEME_ICONS.system;
        const wrap = $("themeWrap");
        if (wrap) {
          wrap.title =
            pref === "system" ? `Theme: follow system (currently ${resolved})` : `Theme: ${pref}`;
        }
      }
      themeSel.addEventListener("change", () => {
        localStorage.setItem("tessera_theme", themeSel.value);
        applyTheme();
      });
      if (window.matchMedia) {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
          if ((localStorage.getItem("tessera_theme") || "system") === "system") applyTheme();
        });
      }
      applyTheme();
      /**
       * DeFi panels are always rendered so every capability is discoverable.
       * When the underlying contract isn't deployed yet we surface the panel's
       * "not ready" notice and disable its inputs instead of hiding the card.
       */
      function setPanelReady(name, ready, controlIds, deployed) {
        const notice = $(name + "NotReady");
        if (notice) {
          // Remember the authored "not deployed" copy so we can restore it.
          if (!notice.dataset.orig) notice.dataset.orig = notice.textContent.trim();
          notice.style.display = ready ? "none" : "block";
          // Deployed but values haven't arrived yet: say *that*, instead of
          // wrongly claiming the contract isn't deployed.
          if (!ready && deployed) {
            notice.textContent =
              "Contract is live on Arc — reading current values from the network… " +
              "(the public RPC is rate-limited, so this can take a few seconds).";
          } else if (!ready && notice.dataset.orig) {
            notice.textContent = notice.dataset.orig;
          }
        }
        for (const id of controlIds) {
          const el = $(id);
          if (!el) continue;
          el.disabled = !ready;
          el.style.opacity = ready ? "" : "0.5";
          el.style.cursor = ready ? "" : "not-allowed";
        }
      }

      /* The header is fixed, so everything that sits under it needs to know how
       * tall it actually is. Measuring beats hard-coding: the height changes with
       * the platform's font metrics, a zoom level, and whether the drawer is open.
       *
       * The whole `.topbar` is measured, drawer included — not just the button
       * row. The drawer is remembered across visits, so measuring only the row
       * left an open drawer floating over the first ~90px of the page: the top
       * card, and on the Agent workspace the tab strip, were covered and
       * unclickable. Since a ResizeObserver fires per frame, the body's padding
       * follows the drawer's open/close animation rather than jumping. */
      (function trackHeaderHeight() {
        const bar = document.querySelector(".topbar");
        if (!bar) return;
        const apply = () => {
          const h = Math.round(bar.getBoundingClientRect().height);
          if (h > 0) document.documentElement.style.setProperty("--headerH", h + "px");
        };
        apply();
        if (window.ResizeObserver) new ResizeObserver(apply).observe(bar);
        window.addEventListener("orientationchange", () => setTimeout(apply, 250));
        window.addEventListener("resize", apply, { passive: true });
      })();

      /* ====================================================================
       * Router — landing page ⇄ in-app tabs, with no page reload.
       * The hash drives it (#/dashboard, #/defi, …) so links and the browser
       * back button work, and "#" (or no hash) is the landing page.
       * ==================================================================== */
      const TABS = ["dashboard", "defi", "agents", "other"];
      // Plain names: the icons live in the drawer markup as SVG now, so the
      // labels no longer smuggle a glyph that would end up in the tab title.
      const NAV_LABELS = {
        home: "Home",
        dashboard: "Dashboard",
        defi: "DeFi",
        agents: "Agent workspace",
        other: "Treasury & system",
      };
      const NAV_OPEN_KEY = "tessera_nav_open";
      /** Open/close the menu drawer, remembering the choice across visits. */
      function setNavOpen(open, persist) {
        $("navDrawer").classList.toggle("open", open);
        $("navToggle").setAttribute("aria-expanded", open ? "true" : "false");
        if (persist !== false) {
          try { localStorage.setItem(NAV_OPEN_KEY, open ? "1" : "0"); } catch {}
        }
      }
      function showView(route) {
        const isApp = TABS.includes(route);
        $("viewLanding").hidden = isApp;
        $("viewApp").hidden = !isApp;
        // The Start button belongs to the landing page only.
        $("startDock").style.display = isApp ? "none" : "";
        if (isApp) {
          for (const t of TABS) {
            const pane = $("pane" + t[0].toUpperCase() + t.slice(1));
            if (pane) pane.hidden = t !== route;
          }
        }
        // The document title is now the only "where am I" indicator besides the
        // drawer's own highlight, which is deliberate — the breadcrumb strip it
        // replaces was a third band competing for the top of a phone screen.
        document.title = isApp
          ? `${NAV_LABELS[route] || route} · Tessera`
          : "Tessera — agentic payments on Arc";
        // Highlight the current section in the drawer. This is the only place
        // that marks "where you are" now that the tab strip is gone, so it has
        // to stay right even when navigation came from a hash change or a
        // landing-page card rather than from a click in here.
        document.querySelectorAll("[data-nav]").forEach((b) => {
          const on = b.dataset.nav === route;
          b.setAttribute("aria-current", on ? "page" : "false");
        });
        // The drawer deliberately stays open across navigation — it is a menu
        // the user chose to pin, not a popup.
      }
      function routeFromHash() {
        const h = (location.hash || "").replace(/^#\/?/, "");
        return TABS.includes(h) ? h : "home";
      }
      function navigate(route, opts) {
        const target = route === "home" ? "#" : "#/" + route;
        if (location.hash !== target) {
          // replace on first paint so we don't stack history entries
          if (opts && opts.replace) history.replaceState(null, "", target);
          else location.hash = target;
        }
        showView(route === "home" ? "home" : route);
        if (!opts || !opts.keepScroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
      }
      window.addEventListener("hashchange", () => showView(routeFromHash()));

      /* ---- DeFi sub-tabs -------------------------------------------------
       * One tab per function instead of four long cards stacked in a column.
       * Purely a view switch: no fetching hangs off it, because the DeFi panels
       * are all fed by the same `/api/state` poll. */
      const DEFI_PANES = {
        lending: "defiLending", vault: "defiVault", swap: "defiSwap", amm: "defiAmm", fees: "defiFees",
      };
      /** Which tab owns each card, so a deep link can open the right one. */
      const DEFI_CARD_TAB = {
        lendingCard: "lending", vaultCard: "vault", swapCard: "swap", ammCard: "amm", feesCard: "fees",
      };
      const DEFI_TAB_KEY = "tessera_defi_tab";
      let defiTab = "lending";

      /* Per-venue state for the holder leaderboards and fee charts. Declared
         here, above setDefiTab: that runs while the script is still evaluating
         (it restores the saved tab), so anything it reaches must already exist. */
      const HOLD_VENUES = {
        Lending: { kind: "lending", series: "toLending", label: "lending pool" },
        Vault: { kind: "vault", series: "toVault", label: "vault" },
        Swap: { kind: "swap", series: "toSwap", label: "AMM pools" },
        Amm: { kind: "amm", series: "toSwap", label: "AMM pools" },
      };
      const HOLD_SIZES = [5, 10, 25, 50];
      const holdState = {};
      for (const k of Object.keys(HOLD_VENUES)) {
        holdState[k] = { rows: [], assets: [], page: 1, size: 10, loading: false, report: null };
      }
      /** Shared across all four venue charts; one /api/fees read serves them. */
      let feeDailyCache = null;
      /* Same reason: setDefiTab calls loadFees() during initial evaluation when
         the App fees tab was the one last open. */
      let feesLoading = false;
      /** Retry handle while the collector's history is still being read. */
      let feesRetry = null;

      function setDefiTab(tab, opts) {
        if (!(tab in DEFI_PANES)) tab = "lending";
        defiTab = tab;
        try { localStorage.setItem(DEFI_TAB_KEY, tab); } catch {}
        for (const [name, id] of Object.entries(DEFI_PANES)) {
          const el = $(id);
          if (el) el.hidden = name !== tab;
        }
        document.querySelectorAll("[data-defitab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.defitab === tab));
        if (tab === "fees") loadFees();
        // Each venue tab carries its own holder leaderboard and fee history.
        // Loaded on switch rather than up front: a holder scan is a windowed
        // log sweep, and doing four of them for tabs nobody opened is waste.
        const venueKey = { lending: "Lending", vault: "Vault", swap: "Swap", amm: "Amm" }[tab];
        if (venueKey) loadVenuePanels(venueKey);
        // Switching tabs shouldn't leave you halfway down the previous pane.
        if (!opts || opts.scroll !== false) {
          const dock = document.querySelector("#paneDefi .tabDock");
          if (dock) {
            const top = dock.getBoundingClientRect().top + window.scrollY - (headerHeight() + 8);
            if (window.scrollY > top) window.scrollTo({ top, behavior: "instant" in window ? "instant" : "auto" });
          }
        }
      }
      const headerHeight = () =>
        parseInt(getComputedStyle(document.documentElement).getPropertyValue("--headerH"), 10) || 56;

      if ($("defiTabs")) {
        document.querySelectorAll("[data-defitab]").forEach((b) =>
          b.addEventListener("click", () => setDefiTab(b.dataset.defitab)));
        let saved = "lending";
        try { saved = localStorage.getItem(DEFI_TAB_KEY) || "lending"; } catch {}
        setDefiTab(saved, { scroll: false });
      }

      // Brand → home; Start / CTA → dashboard.
      $("brandBtn").addEventListener("click", () => navigate("home"));
      ["startBtn", "heroStart", "ctaStart"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("click", () => navigate("dashboard"));
      });
      // Landing capability cards deep-link into the panel that implements them:
      // "defi#vaultCard" switches to the DeFi tab, scrolls to the vault card and
      // flashes it so it's obvious where you landed.
      function gotoTarget(spec) {
        const [tab, anchor] = String(spec).split("#");
        navigate(tab, { keepScroll: true });
        // A DeFi card now lives inside a tab, so opening its pane has to happen
        // before the scroll — `scrollIntoView` on a `hidden` element does
        // nothing, which would land the user on whichever tab was already open.
        if (anchor && DEFI_CARD_TAB[anchor]) setDefiTab(DEFI_CARD_TAB[anchor], { scroll: false });
        requestAnimationFrame(() => {
          const el = anchor && $(anchor);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.remove("flashTarget");
            void el.offsetWidth; // restart the animation
            el.classList.add("flashTarget");
          } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        });
      }
      document.querySelectorAll("[data-goto]").forEach((el) => {
        el.addEventListener("click", (e) => {
          // `preventDefault` matters: some of these are anchors, and letting the
          // browser follow `href="#"` rewrites the hash to "" *after* we set the
          // route — which sent a deep link to the landing page instead.
          e.preventDefault();
          gotoTarget(el.dataset.goto);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); gotoTarget(el.dataset.goto); }
        });
      });

      document.querySelectorAll("[data-nav]").forEach((b) =>
        b.addEventListener("click", () => navigate(b.dataset.nav, { keepScroll: true })));
      $("navToggle").addEventListener("click", () => {
        setNavOpen(!$("navDrawer").classList.contains("open"));
      });
      // Restore the remembered drawer state without animating it on first paint.
      (function restoreNav() {
        let open = false;
        try { open = localStorage.getItem(NAV_OPEN_KEY) === "1"; } catch {}
        if (!open) return;
        const d = $("navDrawer");
        d.style.transition = "none";
        setNavOpen(true, false);
        requestAnimationFrame(() => { d.style.transition = ""; });
      })();

      // Start button: hidden at rest, appears on scroll-up, leaves on scroll-down.
      //
      // Hidden at rest matters. At the top of the landing page the hero's own
      // "Launch the app" button is right there, so a floating duplicate pinned
      // under the header was covering the page for no gain. The dock exists for
      // the case where you have read down the page and want back to the top of
      // the funnel — which is exactly the scroll-up gesture.
      (function startButtonAutoHide() {
        const dock = $("startDock");
        const REVEAL_AFTER = 260; // roughly past the hero CTA
        const JITTER = 6; // ignore sub-pixel/rubber-band noise
        let last = window.scrollY;
        dock.classList.add("hide");
        const onScroll = () => {
          const y = Math.max(0, window.scrollY);
          const dy = y - last;
          if (Math.abs(dy) < JITTER) return;
          // Scrolling up, and far enough down that the hero CTA is gone.
          if (dy < 0 && y > REVEAL_AFTER) dock.classList.remove("hide");
          else dock.classList.add("hide");
          last = y;
        };
        window.addEventListener("scroll", onScroll, { passive: true });
      })();

      // Reveal landing sections as they enter the viewport.
      (function scrollReveal() {
        const items = document.querySelectorAll(".reveal");
        if (!("IntersectionObserver" in window)) {
          items.forEach((el) => el.classList.add("in"));
          return;
        }
        const io = new IntersectionObserver(
          (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
          { rootMargin: "0px 0px -12% 0px" },
        );
        items.forEach((el) => io.observe(el));
      })();

      // Write agent-state into a field unless the user's own value owns it.
      function setUnlessMine(id, text) {
        const el = $(id);
        if (!el || el.dataset.mine) return;
        el.textContent = text;
      }

      // Tolerates a short value (e.g. "operator") rather than mangling it.
      const short = (a) => (!a ? "—" : a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a);
      const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      /**
       * Post-transaction refresh: re-read the chain now, then once more shortly
       * after, because a state change can land a moment after the receipt.
       */
      function afterTx() {
        tick({ fresh: true });
        refreshMyPositions().catch(() => {});
        // A deposit or withdrawal changes the leaderboard and may have moved
        // fees, so both cached views are stale. Only the visible venue is
        // re-scanned — re-running all four log sweeps would be gratuitous.
        feeDailyCache = null;
        setTimeout(() => {
          tick({ fresh: true });
          refreshMyPositions().catch(() => {});
          const key = { lending: "Lending", vault: "Vault", swap: "Swap", amm: "Amm" }[defiTab];
          if (key && typeof loadHolders === "function") {
            loadHolders(key, { refresh: true });
            loadVenueChart(key);
          }
        }, 4000);
      }

      // Visible connection state. Without this a failing /api/state just left
      // every field at "—", which looks identical to a healthy-but-empty app.
      function showConnError(detail) {
        let bar = $("connErr");
        if (!bar) {
          bar = document.createElement("div");
          bar.id = "connErr";
          bar.style.cssText =
            "margin:12px 0;padding:10px 14px;border:1px solid #7f1d1d;background:#2a1212;" +
            "color:#fca5a5;border-radius:10px;font-size:13px;line-height:1.5";
          document.body.insertBefore(bar, document.body.firstChild);
        }
        bar.textContent = "⚠ Can't reach the Tessera server (/api/state): " + detail +
          " — the app container may be down. Check: docker compose ps · docker compose logs tessera --tail=50";
        bar.style.display = "block";
      }
      const clearConnError = () => { const b = $("connErr"); if (b) b.style.display = "none"; };

      /**
       * Poll the server. `fresh` forces it to re-read the chain before replying,
       * which is what makes balances update the instant a transaction lands
       * instead of after the next cache window.
       */
      async function tick(opts) {
        let s;
        try {
          // Bound the wait: a hung read (rate-limited RPC, wedged container)
          // should report itself, not leave the page spinning on "—" forever.
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 25000);
          const url = opts && opts.fresh ? "/api/state?fresh=1" : "/api/state";
          const res = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(timer));
          if (!res.ok) { showConnError("HTTP " + res.status); return; }
          s = await res.json();
        } catch (e) {
          const m = e && e.name === "AbortError" ? "timed out after 25s" : String(e && e.message ? e.message : e);
          showConnError(m);
          return;
        }
        // A well-formed state always carries meta/task/agent. Anything else means
        // the server answered but isn't healthy — say so rather than crashing.
        if (!s || !s.meta || !s.task || !s.agent) {
          showConnError("server returned an incomplete state payload");
          return;
        }
        clearConnError();

        $("brainPill").textContent = "brain: " + s.meta.brain;
        $("chainPill").textContent = s.meta.chain;
        $("goal").textContent = s.task.goal;
        $("budget").textContent = s.task.budgetUsdc + " USDC";
        $("spent").textContent = s.summary.spentUsdc + " USDC";
        $("summary").textContent =
          `${s.summary.settled} settled · ${s.summary.refunded} refunded · ${s.summary.skipped} skipped`;

        // A balance the server could not read is not a balance of zero. Showing
        // "0.0000" for a funded wallet is worse than showing nothing, because it
        // reads as a fact and invites someone to go top the agent up.
        if (s.agent.balanceUnavailable || s.agent.balanceUsdc == null) {
          $("agentBal").innerHTML = '<span class="muted">unavailable</span>';
        } else {
          $("agentBal").innerHTML = (+s.agent.balanceUsdc).toFixed(4) + '<span class="u">USDC</span>';
        }
        $("agentAddr").textContent = s.agent.address;
        const start = +s.agent.startBalanceUsdc || 1;
        const balNum = s.agent.balanceUsdc == null ? null : +s.agent.balanceUsdc;
        $("balBar").style.width =
          balNum == null ? "0%" : Math.max(0, Math.min(100, (100 * balNum) / start)) + "%";
        const delta = balNum == null ? 0 : balNum - start;
        $("balDelta").textContent = (delta >= 0 ? "+" : "") + delta.toFixed(4) + " vs start";
        $("balDelta").style.color = delta < 0 ? "var(--muted)" : "var(--good)";

        $("providers").innerHTML = s.providers
          .map(
            (p) => `
          <div class="row">
            <span class="dot ${p.behavior}"></span>
            <div>
              <div class="name">${esc(p.name)}</div>
              <div class="addr">${short(p.address)} · ${p.behavior}${p.billing === "tab" ? " · ⚡nanopay" : ""}</div>
            </div>
            <div class="rep">
              <span class="f">${p.reputation.fulfilled}✓</span>
              <span class="x">${p.reputation.failed}✗</span><br/>
              <span style="color:var(--muted)">earned ${p.reputation.earnedUsdc} · 🔒 stake ${p.stakeUsdc}</span>
            </div>
          </div>`
          )
          .join("");

        $("ledger").innerHTML = s.ledger.length
          ? s.ledger
              .map(
                (e) => `<tr>
              <td>${esc(e.name)}</td>
              <td class="mono" style="font-size:11px;color:var(--muted)">${short(e.provider)}</td>
              <td class="num">${e.priceUsdc}</td>
              <td><span class="badge ${e.status}">${e.status}</span></td>
              <td style="color:var(--muted)">${esc(e.reason)}</td>
              <td class="mono" style="font-size:11px">${e.paymentId ? "#" + e.paymentId : "—"}</td>
            </tr>`
              )
              .join("")
          : `<tr><td colspan="6" style="color:var(--muted)">No purchases yet…</td></tr>`;

        $("log").innerHTML = s.events
          .slice(-40)
          .reverse()
          .map(
            (e) => `<div class="line lv-${e.level}">
              <span class="t">${fmtTime(e.ts)}</span>
              <span class="src">${e.source === "agent" ? "agent" : esc(e.resource || "provider")}</span>
              <span class="msg">${esc(e.message)}</span>
            </div>`
          )
          .join("");

        if (s.policy) {
          $("policyPill").textContent = `🛡 auto ≤ ${s.policy.autoApproveMaxUsdc} USDC`;
        }

        // Guardian approval queue — the human co-signer UI.
        const approvals = s.approvals || [];
        $("approvalsCard").style.display = approvals.length ? "block" : "none";
        $("approvals").innerHTML = approvals
          .map(
            (a) => `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #533a14;border-radius:11px;background:#1c170c">
            <div style="flex:1">
              <b>${esc(a.name)}</b> wants <b style="color:var(--warn)">${a.priceUsdc} USDC</b>
              <div style="color:var(--muted);font-size:12px">${esc(a.reason)} · provider ${short(a.provider)}</div>
            </div>
            <button class="btn" style="border-color:#14532d;background:#0c2c1e;color:var(--good)" onclick="verdict(${a.id},'approve')">Approve ✓</button>
            <button class="btn" style="border-color:#531414;background:#2c0c0c;color:var(--bad)" onclick="verdict(${a.id},'reject')">Reject ✗</button>
          </div>`
          )
          .join("");

        // Payment requests — provider invoices + the agent's verdict on each.
        const invoices = s.invoices || [];
        $("invoices").innerHTML = invoices.length
          ? invoices
              .map((inv) => {
                const v = inv.agentVerdict;
                const badge = v
                  ? v.verdict === "paid"
                    ? '<span class="badge settled">paid</span>'
                    : '<span class="badge refunded">declined</span>'
                  : '<span class="badge skipped">pending</span>';
                return `
            <div style="display:flex;gap:8px;align-items:center">
              <span>🧾</span>
              <span style="flex:1">${esc(inv.memo)} <span style="color:var(--muted)">· ${inv.amountUsdc} USDC</span>
                ${v && v.verdict === "declined" ? `<br/><span style="color:var(--warn);font-size:11.5px">${esc(v.reason)}</span>` : ""}
              </span>
              ${badge}
            </div>`;
              })
              .join("")
          : '<span style="color:var(--muted)">No invoices…</span>';

        // Contacts — the agent's personal memory of providers.
        const contacts = s.contacts || [];
        $("contacts").innerHTML = contacts.length
          ? contacts
              .map(
                (c) => `
            <div style="display:flex;gap:8px;align-items:center">
              <span>${c.refunded > 0 ? "🚫" : "🤝"}</span>
              <span style="flex:1">${esc(c.name)}</span>
              <span style="color:var(--muted)">${c.settled}✓ ${c.refunded}✗ of ${c.dealings}</span>
            </div>`
              )
              .join("")
          : '<span style="color:var(--muted)">No dealings yet…</span>';

        // Balance sparkline (single series — the card title names it).
        const hist = s.balanceHistory || [];
        if (hist.length > 1) {
          const vals = hist.map((h) => +h.balance);
          const min = Math.min(...vals), max = Math.max(...vals);
          const pad = (max - min) * 0.15 || 0.0001;
          const y = (v) => 52 - ((v - (min - pad)) / (max + pad - (min - pad))) * 48;
          const x = (i) => (i / (vals.length - 1)) * 296 + 2;
          const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          $("spark").innerHTML =
            `<path d="${d}" fill="none" stroke="#3a7bff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
            `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="3.5" fill="#3a7bff" stroke="var(--panel)" stroke-width="2"/>`;
          $("sparkRange").textContent = `${min.toFixed(4)} – ${max.toFixed(4)}`;
        }

        $("briefing").innerHTML =
          s.briefing && s.briefing.length
            ? s.briefing
                .map(
                  (l) =>
                    `<div style="padding:7px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);${l.startsWith("⚠") ? "color:var(--warn)" : ""}">${esc(l)}</div>`
                )
                .join("")
            : '<span style="color:var(--muted)">Waiting for the agent…</span>';

        $("stream").innerHTML = s.stream
          ? `<div style="color:var(--text)">⚡ <b>${s.stream.ticks}</b> micro-calls streamed for <b>${s.stream.spentUsdc} USDC</b> total<br/>
             <span style="color:var(--muted);font-size:12px">${s.stream.ticks} signed vouchers off-chain · 2 transactions on-chain</span></div>`
          : '<span style="color:var(--muted)">No stream yet…</span>';

        $("escrowLink").textContent = s.meta.escrowAddress;
        $("note").textContent = s.meta.note || "";
        schedulePoll(s.meta.pollMs || 800);
        const liveMode = s.meta.mode === "live";
        $("chainPill").style.background = liveMode ? "rgba(255,107,107,.15)" : "";
        $("chainPill").style.color = liveMode ? "#ff6b6b" : "";
        $("runBtn").disabled = s.running;
        $("runBtn").textContent = s.running ? "Running…" : liveMode ? "Run live on Arc ↻" : "Run again ↻";

        // Treasury & faucet workflow.
        const tr = s.treasury;
        if (tr) {
          $("trBal").textContent =
            tr.balanceUsdc == null ? "unavailable" : (+tr.balanceUsdc).toFixed(4) + " USDC";
          $("trRunway").textContent = tr.runwayCalls != null ? tr.runwayCalls + " calls" : "—";
          $("trLow").textContent = tr.lowWaterUsdc + " USDC";
          const net = tr.settlement ? +tr.settlement.netUsdc : 0;
          $("trNet").textContent = (net >= 0 ? "+" : "") + net.toFixed(4) + " USDC";
          $("trNet").style.color = net < 0 ? "var(--muted)" : "var(--good)";
          $("trHealth").textContent = tr.healthy ? "healthy ✓" : "LOW ⚠";
          $("trHealth").style.color = tr.healthy ? "var(--good)" : "var(--warn)";
          if (tr.faucetUrl) $("faucetLink").href = tr.faucetUrl;
        }

        window.__ledger = s.ledger || [];
        // Kept for the account-status sheet, which renders from the same state
        // rather than issuing its own reads.
        window.__lastState = s;
        window.__explorer = (s.live && s.live.explorer) || "";

        // ---- Dashboard tab + landing stat strip -------------------------------
        // Same numbers in both places, so the landing page shows real live state.
        const setAll = (id, text) => { const el = $(id); if (el) el.textContent = text; };
        setAll("dashSettled", String(s.summary.settled));
        setAll("dashRefunded", String(s.summary.refunded));
        setAll("dashSkipped", String(s.summary.skipped));
        setAll("dashSpent", s.summary.spentUsdc + " USDC");
        setAll("landSettled", String(s.summary.settled));
        setAll("landChain", (s.meta.chain || "Arc").replace(/\s*\(.*\)$/, ""));

        const vaultTvl = s.vault && s.vault.ready ? s.vault.totalAssets + " USDC" : "—";
        setAll("dashVaultTvl", vaultTvl);
        setAll("landTvl", vaultTvl);
        setAll("dashBuffer", s.vault && s.vault.ready ? s.vault.bufferPct + "%" : "—");
        setAll("dashAmmPools", s.amm && s.amm.ready ? String((s.amm.pools || []).length) : "—");

        if (s.lending && s.lending.ready && s.lending.assets.length) {
          // Headline the pool on its USDC reserve, falling back to the first asset.
          const u = s.lending.assets.find((a) => a.symbol === "USDC") || s.lending.assets[0];
          setAll("dashPoolCash", u.reserve.cash + " " + u.symbol);
          setAll("dashPoolBorrows", u.reserve.borrows + " " + u.symbol);
          setAll("landLiquidity", u.reserve.cash + " " + u.symbol);
        } else {
          setAll("dashPoolCash", "—"); setAll("dashPoolBorrows", "—"); setAll("landLiquidity", "—");
        }
        if (s.swap && s.swap.ready && s.swap.assets.length) {
          setAll("dashSwapInv", s.swap.assets.map((a) => `${a.liquidity} ${a.symbol}`).join(" · "));
        } else {
          setAll("dashSwapInv", "—");
        }

        // Lending & borrowing (TesseraPool) — multi-asset. The card is always
        // visible; when the pool isn't deployed we show the not-ready notice and
        // disable the controls rather than hiding the whole feature.
        const ln = s.lending;
        const lnReady = !!(ln && ln.ready && ln.assets && ln.assets.length);
        // Three states, not two: absent (never deployed), deployed-but-pending
        // (chain read hasn't landed), and ready.
        setPanelReady("lending", lnReady, ["lnAsset", "lnAction", "lnAmount", "lnMax", "lnExecute"], ln && ln.deployed);
        if (lnReady) {
          $("lnSupplied").textContent = "$" + ln.account.suppliedUsd;
          $("lnBorrowed").textContent = "$" + ln.account.borrowedUsd;
          $("lnLimit").textContent = "$" + ln.account.borrowLimitUsd;
          // Only shown when the pool exposes it. An older pool returns null and
          // the field says so rather than repeating the borrow limit as if the
          // two lines were the same.
          if ($("lnLiqLimit")) {
            $("lnLiqLimit").textContent = ln.account.liquidationLimitUsd
              ? "$" + ln.account.liquidationLimitUsd
              : "n/a on this pool";
          }
          // The collateral limit alone reads as a promise the pool may not be
          // able to keep — a $66,500 limit against $100 of lendable USDC. Show
          // what can actually be drawn, and say which constraint binds.
          if ($("lnBorrowable")) {
            $("lnBorrowable").textContent = "$" + (ln.account.borrowableNowUsd ?? "0.00");
            const by = ln.account.limitedBy;
            const note = $("lnLimitedBy");
            if (note) {
              note.textContent =
                by === "liquidity"
                  ? `capped by pool liquidity ($${ln.account.poolLiquidityUsd})`
                  : by === "collateral"
                    ? "capped by your collateral"
                    : "";
              note.style.color = by === "liquidity" ? "var(--warn)" : "var(--muted)";
            }
          }
          $("lnHealth").textContent = ln.account.healthFactor;
          window.__lending = ln;
          const sel = $("lnAsset");
          // Hidden reserves drop out of the picker, but only for people who
          // hold nothing in them: hiding is presentation, and a supplier must
          // always be able to reach their own funds.
          const visible = ln.assets.filter(
            (a) => !a.hidden || Number(a.position.supplied) > 0 || Number(a.position.borrowed) > 0,
          );
          const list = visible.length ? visible : ln.assets;
          // (Re)build the asset dropdown only when the set of symbols changes,
          // so it doesn't reset the user's selection on every poll.
          const symbols = list.map((a) => a.symbol).join(",");
          if (sel.dataset.symbols !== symbols) {
            const keep = sel.value;
            sel.innerHTML = list.map((a) => `<option value="${esc(a.symbol)}">${esc(a.symbol)}</option>`).join("");
            sel.dataset.symbols = symbols;
            if (list.some((a) => a.symbol === keep)) sel.value = keep;
          }
          renderCfgLending();
          if (window.renderLendingAsset) window.renderLendingAsset();
        }

        // Vault (auto-yield on USDC) — always visible.
        const vt = s.vault;
        const vtReady = !!(vt && vt.ready);
        setPanelReady("vault", vtReady, ["vAction", "vAmount", "vMax", "vExecute"], vt && vt.deployed);
        if (vtReady) {
          window.__vault = vt;
          window.__agentUsdc = vt.walletUsdc || (s.agent && s.agent.balanceUsdc != null ? s.agent.balanceUsdc : "0");
          setUnlessMine("vWallet", (vt.walletUsdc || "0") + " USDC");
          // These come straight from the contract each refresh, so an admin
          // change to the ratio or fee shows up here as soon as it lands.
          $("vReserve").textContent = vt.reserveRatioPct;
          $("vFee").textContent = vt.performanceFeePct;
          $("vTvl").textContent = vt.totalAssets + " USDC";
          setUnlessMine("vYours", vt.yourAssets + " USDC");
          $("vApr").textContent = vt.supplyApr + "%";
          $("vBuffer").textContent = vt.bufferPct + "%";
        }

        // Swap — always visible.
        const sw = s.swap;
        const swReady = !!(sw && sw.ready && sw.assets && sw.assets.length);
        setPanelReady("swap", swReady, ["swAmount", "swIn", "swOut", "swQuote", "swExecute"], sw && sw.deployed);
        if (swReady) {
          window.__swap = sw;
          // Depth first, and independently of the quote panel. It must not
          // depend on the pickers being populated: `renderSwapBalances` bails out
          // when no valid pair is selected, which on the very first paint (and
          // when only one asset has depth) is exactly when you most want to see
          // that there is nothing to trade against.
          renderSwapInventory();
          renderSwapBalances();
          const syms = sw.assets.map((a) => a.symbol).join(",");
          if ($("swIn").dataset.symbols !== syms) {
            const opts = sw.assets.map((a) => `<option value="${esc(a.address)}" data-sym="${esc(a.symbol)}" data-dec="${Number(a.decimals) || 6}">${esc(a.symbol)}</option>`).join("");
            $("swIn").innerHTML = opts;
            $("swOut").innerHTML = opts;
            $("swIn").dataset.symbols = syms;
            $("swOut").dataset.symbols = syms;
            if (sw.assets.length > 1) $("swOut").selectedIndex = 1;
          }
        }

        // AMM liquidity pools — always visible.
        const am = s.amm;
        const amReady = !!(am && am.ready && am.pools && am.pools.length);
        setPanelReady(
          "amm",
          amReady,
          ["amPool", "amSwapAmount", "amSwapIn", "amSwapOut", "amSwapExec", "amLpAction", "amLpMax", "amLpExec"],
          am && am.deployed,
        );
        if (am && am.deployed) {
          window.__amm = am;
          renderAmm();
        }

        // Live Arc testnet deployment (from deployments/arc.json).
        const live = s.live;
        if (live && live.agent) {
          $("liveCard").style.display = "block";
          $("liveChain").textContent = live.chainId;
          const ex = live.explorer || "https://testnet.arcscan.app";
          const liveRow = (label, addr, tag) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
               <span style="color:var(--muted)">${label}${tag ? ` <span style="opacity:.7">${tag}</span>` : ""}</span>
               <a class="mono" href="${ex}/address/${addr}" target="_blank" rel="noopener"
                  style="color:var(--accent);text-decoration:none">${short(addr)} ↗</a>
             </div>`;
          $("liveRows").innerHTML =
            liveRow("Agent wallet", live.agent, "") +
            liveRow("Provider wallet", live.provider, "") +
            liveRow("TesseraEscrow", live.tesseraEscrow, "contract") +
            liveRow("TesseraTab", live.tesseraTab, "contract") +
            liveRow("USDC", live.usdc, "gas token");
        }
      }

      window.verdict = async (id, v) => {
        await postAuthed(`/api/approvals/${id}/${v}`).catch(() => {});
        tick();
      };

      $("runBtn").addEventListener("click", async () => {
        $("runBtn").disabled = true;
        await postAuthed("/api/run").catch(() => {});
      });

      $("faucetBtn").addEventListener("click", async () => {
        const btn = $("faucetBtn");
        btn.disabled = true;
        btn.textContent = "Requesting…";
        const msg = $("faucetMsg");
        try {
          const r = await (await postAuthed("/api/faucet")).json();
          msg.style.display = "block";
          msg.textContent = r.message || (r.ok ? "Testnet USDC requested." : "Faucet request failed.");
          msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
        } catch {
          msg.style.display = "block";
          msg.textContent = "Faucet request failed — try faucet.circle.com.";
          msg.style.color = "var(--warn)";
        } finally {
          btn.disabled = false;
          btn.textContent = "Get testnet USDC ⛽";
          tick();
        }
      });

      // --- Auth token (shared by Web3 wallet + admin login) ---
      const authToken = () => localStorage.getItem("tessera_token");
      const authHeaders = () => {
        const t = authToken();
        return t ? { Authorization: "Bearer " + t } : {};
      };
      // POST wrapper that attaches the token and explains the two auth levels:
      // 401 = not signed in at all; 403 = signed in, but the action spends the
      // agent's own wallet and is therefore operator-only.
      async function postAuthed(url, opts = {}) {
        const res = await fetch(url, { method: "POST", ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
        if (res.status === 401) {
          alert("Please sign in first — Connect Wallet or use the Admin button.");
        } else if (res.status === 403) {
          alert(
            "This action spends the agent's own wallet, so it's operator-only — sign in with the Admin button.\n\n" +
              "Connected wallets can view everything and get live quotes."
          );
        }
        return res;
      }
      /** POST a JSON body with the auth headers attached. */
      const postJson = (url, body) =>
        postAuthed(url, { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });


      /* ====================================================================
       * Sign-in / change-password dialog.
       * Replaces window.prompt(), which showed the password in clear text and
       * couldn't mask input. Fields are type=password with a reveal toggle.
       * ==================================================================== */
      function bindEye(btnId, inputId) {
        const b = $(btnId), i = $(inputId);
        if (!b || !i) return;
        b.addEventListener("click", () => {
          const show = i.type === "password";
          i.type = show ? "text" : "password";
          b.textContent = show ? "🙈" : "👁";
          b.setAttribute("aria-label", show ? "Hide password" : "Show password");
          i.focus();
        });
      }
      bindEye("authEye", "authPw");
      // One toggle for both new-password boxes — they always hold the same
      // secret, so revealing one and not the other is just confusing.
      (function bindNewPasswordEye() {
        const b = $("authEye2"), a = $("authPw2"), c = $("authPw3");
        if (!b || !a || !c) return;
        b.addEventListener("click", () => {
          const show = a.type === "password";
          a.type = c.type = show ? "text" : "password";
          b.textContent = show ? "🙈" : "👁";
          b.setAttribute("aria-label", show ? "Hide password" : "Show password");
          a.focus();
        });
      })();

      /** Live match feedback, so a typo is visible before submitting. */
      function syncPwMatch() {
        const a = $("authPw2"), c = $("authPw3"), out = $("authPwMatch");
        if (!a || !c || !out) return;
        if (!a.value && !c.value) { out.style.display = "none"; return; }
        out.style.display = "block";
        if (!c.value) {
          out.style.color = "var(--muted)";
          out.textContent = "Type the new password again to confirm it.";
        } else if (a.value === c.value) {
          out.style.color = "var(--good)";
          out.textContent = "Both entries match.";
        } else {
          out.style.color = "var(--warn)";
          out.textContent = "The two entries don't match yet.";
        }
      }
      if ($("authPw2")) $("authPw2").addEventListener("input", syncPwMatch);
      if ($("authPw3")) $("authPw3").addEventListener("input", syncPwMatch);

      let authResolve = null;
      /**
       * Open the dialog. mode "login" asks id+password; mode "change" asks the
       * current and the new password. Resolves with the values or null.
       */
      function askAuth(mode) {
        const wrap = $("authModal");
        const isChange = mode === "change";
        $("authTitle").textContent = isChange ? "Change password" : "Operator sign-in";
        $("authHint").textContent = isChange
          ? "Enter your current password, then the new one twice (min 8 characters)."
          : "Enter your admin id and password.";
        // Target labels/inputs by id — the password input sits inside .pwRow, so
        // previousElementSibling is null there and would throw before the dialog
        // ever opened.
        $("authId").style.display = isChange ? "none" : "";
        $("authIdLabel").style.display = isChange ? "none" : "";
        $("authPwLabel").textContent = isChange ? "Current password" : "Password";
        $("authPw2Row").style.display = isChange ? "" : "none";
        $("authPw2Label").style.display = isChange ? "" : "none";
        $("authPw3Row").style.display = isChange ? "" : "none";
        $("authPw3Label").style.display = isChange ? "" : "none";
        $("authPwMatch").style.display = "none";
        $("authSubmit").textContent = isChange ? "Change password" : "Sign in";
        $("authMsg").style.display = "none";
        $("authId").value = ""; $("authPw").value = ""; $("authPw2").value = ""; $("authPw3").value = "";
        $("authPw").type = "password"; $("authPw2").type = "password"; $("authPw3").type = "password";
        $("authEye").textContent = "👁"; $("authEye2").textContent = "👁";
        wrap.hidden = false;
        setTimeout(() => (isChange ? $("authPw") : $("authId")).focus(), 40);
        return new Promise((res) => { authResolve = res; });
      }
      function closeAuth(value) {
        $("authModal").hidden = true;
        const r = authResolve; authResolve = null;
        if (r) r(value);
      }
      function authError(text) {
        const m = $("authMsg");
        m.style.display = "block"; m.style.color = "var(--warn)"; m.textContent = text;
      }
      $("authCancel").addEventListener("click", () => closeAuth(null));
      $("authModal").addEventListener("click", (e) => { if (e.target === $("authModal")) closeAuth(null); });
      $("authSubmit").addEventListener("click", () => {
        const isChange = $("authPw2Row").style.display !== "none";
        if (isChange) {
          const current = $("authPw").value, next = $("authPw2").value, again = $("authPw3").value;
          if (!current || !next) return authError("Fill in your current and new password.");
          if (next.length < 8) return authError("The new password must be at least 8 characters.");
          // Checked here as well as live, because a paste can fill both boxes
          // without ever firing the input handler in some browsers.
          if (next !== again) return authError("The two new-password entries don't match.");
          if (next === current) return authError("The new password is the same as the current one.");
          closeAuth({ current, next });
        } else {
          const id = $("authId").value.trim(), password = $("authPw").value;
          if (!id) return authError("Enter your admin id.");
          if (!password) return authError("Enter your password.");
          closeAuth({ id, password });
        }
      });
      document.addEventListener("keydown", (e) => {
        if ($("authModal").hidden) return;
        if (e.key === "Escape") closeAuth(null);
        if (e.key === "Enter") $("authSubmit").click();
      });

      // --- Admin login (id + password) ---
      // The admin id is a secret: it is never pre-filled, never defaulted, and
      // never rendered in the UI. A signed-in operator only sees a tinted shield,
      // so the id can't be read off the screen.
      let adminId = null;
      function setAdmin(id) {
        adminId = id;
        const b = $("adminBtn");
        // Tint the existing icon rather than replacing the button's contents.
        // Writing textContent here blew away the SVG and left a wide "Signed in ⚙"
        // label that shoved the buttons beside it off a narrow screen.
        b.classList.toggle("on", !!id);
        const lbl = b.querySelector(".lbl");
        if (lbl) lbl.textContent = id ? "Operator" : "Admin";
        b.title = id ? "Operator session active — click to change password or sign out" : "Operator sign-in";
        b.setAttribute("aria-label", b.title);
      }
      async function adminFlow() {
        // Already signed in? The profile menu owns change-password and sign-out,
        // so just open it rather than duplicating those flows here.
        if (adminId) {
          $("profileBtn").click();
          return;
        }
        // Masked entry via the dialog; the id is never pre-filled.
        const creds = await askAuth("login");
        if (!creds) return;
        const { id, password } = creds;
        const r = await (await fetch("/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, password }),
        })).json();
        if (r.ok) {
          localStorage.setItem("tessera_token", r.token);
          setAdmin(r.id);
          refreshProfile();
        } else {
          alert("Login failed: " + r.error);
        }
      }
      $("adminBtn").addEventListener("click", adminFlow);
      (async () => {
        const t = authToken();
        if (!t) return;
        try {
          const me = await (await fetch("/api/admin/me", { headers: { authorization: "Bearer " + t } })).json();
          if (me.id) setAdmin(me.id);
        } catch {}
      })();

      // --- Web3 wallet login (Sign-In-With-Ethereum) ---
      /**
       * Reflect the connected wallet, without wrecking the button.
       *
       * This used to do `btn.textContent = "0x4d31…4205 ✓"`, which replaces the
       * button's children — so the SVG icon was deleted and a string of address
       * was left loose in a 38px square, spilling across its neighbours. The
       * header is icons precisely because there is no room for text there.
       *
       * So the button only changes colour, and the address goes where there is
       * space to read it: the profile panel, in full, with a copy button. An
       * address you cannot read is one you cannot check against your wallet.
       */
      function setWallet(addr) {
        const btn = $("walletBtn");
        btn.classList.toggle("on", !!addr);
        btn.title = addr ? `Connected: ${addr}` : "Connect wallet";
        btn.setAttribute("aria-label", addr ? `Wallet connected: ${addr}` : "Connect wallet");
        window.__myAddress = addr || null;

        const row = $("profileAddrRow");
        const sep = $("profileAddrSep");
        if (row && sep) {
          row.style.display = addr ? "block" : "none";
          sep.style.display = addr ? "" : "none";
          if (addr) $("profileAddr").textContent = addr;
        }
      }

      (() => {
        const copy = $("profileCopy");
        if (!copy) return;
        copy.addEventListener("click", async () => {
          const addr = window.__myAddress;
          if (!addr) return;
          try {
            await navigator.clipboard.writeText(addr);
          } catch {
            // Clipboard access is refused in plenty of mobile contexts. Select
            // the text instead, so there is still a way to get it out.
            const r = document.createRange();
            r.selectNodeContents($("profileAddr"));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
          const was = copy.textContent;
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = was; }, 1400);
        });
      })();
      /* ---- wallet discovery ---------------------------------------------
       *
       * Three things had to change for a phone to work at all.
       *
       * **EIP-6963.** `window.ethereum` is a single slot that every installed
       * wallet fights over, so with two installed you get whichever won the
       * race. 6963 has each wallet announce itself instead, which is how you
       * pick rather than guess.
       *
       * **No injected provider on mobile.** Safari and Chrome on a phone have
       * no extensions, so `window.ethereum` is simply undefined there — and the
       * old code answered that by telling the user to install an extension,
       * which is not a thing that exists on their device. What does work is
       * opening this page *inside* the wallet's own browser, where the wallet
       * injects a provider. The deep links below do exactly that.
       *
       * **No SDK.** WalletConnect would let someone stay in their browser and
       * approve in the app, which is nicer, but it needs a bundled SDK, a
       * project id, and a relay connection — none of which fit a static page
       * under a strict CSP. Deep links need nothing and work today; the hook
       * below is where WalletConnect would slot in later.
       */
      const discovered = new Map(); // uuid -> { info, provider }
      let chosenProvider = null;

      window.addEventListener("eip6963:announceProvider", (e) => {
        const d = e.detail;
        if (d && d.info && d.provider) discovered.set(d.info.uuid, d);
      });
      // Wallets answer this synchronously on receipt; fired once at load and
      // again when the picker opens, in case one was unlocked in between.
      const askWallets = () => window.dispatchEvent(new Event("eip6963:requestProvider"));
      askWallets();

      /** The provider every call in this file goes through. */
      function eth() {
        if (chosenProvider) return chosenProvider;
        if (discovered.size === 1) return [...discovered.values()][0].provider;
        return window.ethereum || null;
      }
      window.__tesseraEth = eth; // for the console, and for anything loaded later

      const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      /**
       * Reopen this exact page inside a wallet's in-app browser.
       *
       * Each wallet has its own scheme and none of them agree; the shapes below
       * are the documented ones. The full path is carried through so somebody
       * deep in the DeFi tab lands back where they were rather than at the top.
       */
      const MOBILE_WALLETS = [
        { name: "MetaMask", link: () => `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.hash}` },
        { name: "Trust Wallet", link: () => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(location.href)}` },
        { name: "Coinbase Wallet", link: () => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}` },
        { name: "Rainbow", link: () => `https://rnbwapp.com/dapp?url=${encodeURIComponent(location.href)}` },
      ];

      function closeWalletPicker() {
        const el = $("walletPicker");
        if (el) el.remove();
      }

      /**
       * Ask which wallet, and return its provider — or null if the user is being
       * sent to an app instead.
       */
      function pickWallet() {
        askWallets();
        closeWalletPicker();
        return new Promise((resolve) => {
          const found = [...discovered.values()];
          const wrap = document.createElement("div");
          wrap.id = "walletPicker";
          wrap.className = "modalWrap";
          const rows = found.length
            ? found
                .map(
                  (d, i) =>
                    `<button class="btn" data-i="${i}" style="display:flex;width:100%;justify-content:flex-start;gap:10px;margin-bottom:8px">` +
                    (d.info.icon ? `<img src="${d.info.icon}" alt="" width="20" height="20" style="border-radius:5px">` : "") +
                    `${esc(d.info.name)}</button>`,
                )
                .join("")
            : "";
          // Deep links only where they can work. On a desktop with no wallet the
          // honest answer is "install one", not a link that opens nothing.
          const links = !found.length && isMobile()
            ? `<p class="muted" style="margin:0 0 10px;font-size:13px">No wallet is available to this browser. Open Tessera inside your wallet's own browser:</p>` +
              MOBILE_WALLETS.map(
                (w) => `<a class="btn" href="${w.link()}" style="display:flex;width:100%;justify-content:flex-start;margin-bottom:8px" rel="noopener">${w.name}</a>`,
              ).join("")
            : "";
          const none = !found.length && !isMobile()
            ? `<p class="muted" style="margin:0;font-size:13px">No wallet extension detected. Install MetaMask, Rabby or another EIP-1193 wallet, then try again.</p>`
            : "";

          wrap.innerHTML =
            `<div class="modalCard" style="padding:18px">` +
            `<h3 style="margin:0 0 12px;font-size:15px">Connect a wallet</h3>` +
            rows + links + none +
            `<button class="btn" id="walletPickerCancel" style="display:flex;width:100%;justify-content:center;margin-top:6px">Cancel</button>` +
            `</div>`;
          document.body.appendChild(wrap);

          wrap.addEventListener("click", (ev) => {
            if (ev.target === wrap) { closeWalletPicker(); resolve(null); }
          });
          $("walletPickerCancel").addEventListener("click", () => { closeWalletPicker(); resolve(null); });
          wrap.querySelectorAll("button[data-i]").forEach((b) => {
            b.addEventListener("click", () => {
              const d = found[Number(b.dataset.i)];
              chosenProvider = d.provider;
              try { localStorage.setItem("tessera_wallet_rdns", d.info.rdns || ""); } catch {}
              closeWalletPicker();
              resolve(d.provider);
            });
          });
          // Following a deep link leaves the page; nothing to resolve.
        });
      }

      // Reconnect to the same wallet on a return visit, so the choice sticks.
      (() => {
        let saved = null;
        try { saved = localStorage.getItem("tessera_wallet_rdns"); } catch {}
        if (!saved) return;
        setTimeout(() => {
          for (const d of discovered.values()) {
            if (d.info.rdns === saved) { chosenProvider = d.provider; break; }
          }
        }, 300);
      })();

      async function connectWallet() {
        // Pick when there is a choice, or when there is nothing yet — the
        // picker is also what offers the deep links on a phone.
        if (!eth() || discovered.size > 1) {
          const picked = await pickWallet();
          if (!picked) return; // cancelled, or being sent to a wallet app
        }
        if (!eth()) return;
        const btn = $("walletBtn");
        btn.disabled = true;
        try {
          const [address] = await eth().request({ method: "eth_requestAccounts" });
          const { nonce } = await (await fetch("/api/auth/nonce")).json();
          const chainIdHex = await eth().request({ method: "eth_chainId" });
          const message =
            `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\n` +
            `Sign in to Tessera.\n\nURI: ${location.origin}\nVersion: 1\n` +
            `Chain ID: ${parseInt(chainIdHex, 16)}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
          const signature = await eth().request({ method: "personal_sign", params: [message, address] });
          const r = await (
            await fetch("/api/auth/verify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ address, message, signature, nonce }),
            })
          ).json();
          if (r.ok) {
            localStorage.setItem("tessera_token", r.token);
            setWallet(r.address);
            refreshProfile();
            refreshMyPositions().catch(() => {});
          } else {
            alert("Sign-in failed: " + r.error);
          }
        } catch (e) {
          alert("Wallet connection cancelled or failed.");
        } finally {
          btn.disabled = false;
        }
      }
      $("walletBtn").addEventListener("click", connectWallet);
      (async () => {
        const t = localStorage.getItem("tessera_token");
        if (!t) return;
        try {
          const me = await (await fetch("/api/auth/me", { headers: { authorization: "Bearer " + t } })).json();
          if (me.address) setWallet(me.address);
        } catch {}
      })();

      // --- Lending: multi-asset supply / withdraw / borrow / repay ------------
      function selectedLendingAsset() {
        const ln = window.__lending;
        if (!ln) return null;
        return ln.assets.find((a) => a.symbol === $("lnAsset").value) || ln.assets[0];
      }
      // Convert a human amount string to the asset's raw integer (string), no floats.
      function toRaw(human, decimals) {
        const [i, f = ""] = String(human).trim().replace(/,/g, "").split(".");
        const frac = (f + "0".repeat(decimals)).slice(0, decimals);
        return (BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
      }
      // Render the reserve + position + max hint for the currently selected asset.
      window.renderLendingAsset = function renderLendingAsset() {
        const a = selectedLendingAsset();
        if (!a) return;
        $("lnPrice").textContent = "≈ $" + a.priceUsd + " / " + a.symbol;
        $("lnCash").textContent = a.reserve.cash + " " + a.symbol;
        $("lnUtil").textContent = a.reserve.utilizationPct + "%";
        $("lnBorrowApr").textContent = a.borrowable ? a.reserve.borrowApr + "%" : "—";
        $("lnSupplyApr").textContent = a.reserve.supplyApr + "%";
        setUnlessMine("lnAssetSupplied", a.position.supplied + " " + a.symbol);
        setUnlessMine("lnAssetBorrowed", a.position.borrowed + " " + a.symbol);
        setUnlessMine("lnWallet", a.position.wallet + " " + a.symbol);
        const action = $("lnAction").value;
        const max = a.max[action];
        // An asset listed in the deployment but never registered on-chain can't
        // be used — say so plainly instead of showing zeros with no explanation.
        if (a.enabled === false) {
          // Two different situations wearing the same disabled state. An asset
          // that was never registered is a configuration gap; one the server
          // could not read is a fault, and the server now says which.
          $("lnMaxHint").textContent = a.unavailable
            ? (a.note || (a.symbol + " could not be read from the pool."))
            : a.symbol + " isn't registered as a reserve in this pool — redeploy with pool:arc to add it.";
          $("lnExecute").disabled = true;
          $("lnExecute").style.opacity = "0.5";
          return;
        }
        // A frozen action or a dead oracle feed both make the transaction
        // revert on-chain. Saying so here — and disabling Execute — is far
        // kinder than letting someone pay gas to find out.
        const FREEZE_BIT = { supply: 1, withdraw: 2, borrow: 4, repay: 8 };
        const frozen = (Number(a.frozen || 0) & FREEZE_BIT[action]) !== 0;
        const priceDown = a.priceOk === false;
        const blocked = frozen || priceDown;
        $("lnExecute").disabled = blocked;
        $("lnExecute").style.opacity = blocked ? "0.5" : "";
        if (priceDown) {
          $("lnMaxHint").textContent =
            "Price feed for " + a.symbol + " is stale or unavailable, so the market is paused until it recovers.";
          return;
        }
        if (frozen) {
          $("lnMaxHint").textContent =
            action.charAt(0).toUpperCase() + action.slice(1) + " is frozen on " + a.symbol +
            " by the operator. Unfrozen actions still work.";
          return;
        }
        $("lnMaxHint").textContent = "max " + action + ": " + max + " " + a.symbol +
          (action === "borrow" && !a.borrowable ? " (not borrowable)" : "");
      };
      /**
       * The connected wallet's balance of a token, straight from the chain.
       *
       * `/api/lending` computes positions and limits for the *agent* — that is
       * its job, and it is right for the agent's own panels. But when a user has
       * connected their own wallet, every "max" derived from it belongs to
       * somebody else's account. It offered a max supply of 520 USDC to a wallet
       * holding 78, and Execute then sent a transaction that could only revert,
       * which the UI reported as success.
       *
       * A wrong max is not a cosmetic problem: it is the number people press Max
       * and then Execute against.
       */
      async function myTokenBalance(token) {
        try {
          if (!selfMode() || !eth()) return null;
          const [from] = await eth().request({ method: "eth_accounts" });
          if (!from) return null;
          const cfg = await loadDefiConfig();
          const hex = await ethCall(token, callData(cfg.selectors.balanceOf, encAddr(from)));
          return BigInt(hex || "0x0");
        } catch {
          // Unknown, never zero — the same rule the rest of this app now follows.
          return null;
        }
      }

      const fmtUnitsStr = (raw, dec) => {
        const s = raw.toString().padStart(dec + 1, "0");
        const whole = s.slice(0, s.length - dec);
        const frac = dec ? s.slice(s.length - dec).replace(/0+$/, "") : "";
        return frac ? `${whole}.${frac}` : whole;
      };

      /**
       * Replace the agent-derived caps with the connected wallet's own.
       *
       * Only the two that are bounded by what you hold. `withdraw` and `borrow`
       * are bounded by the position and the pool, which the server already
       * computes correctly for whoever is asking.
       */
      async function applyMyCaps(a) {
        if (!selfMode() || !a || !a.address) return a;
        const bal = await myTokenBalance(a.address);
        if (bal === null) return a;
        const dec = Number(a.decimals ?? 6);
        const human = fmtUnitsStr(bal, dec);
        a.max = { ...a.max, supply: human, supplyRaw: bal.toString() };
        // Repaying is capped by the debt as well as by the wallet.
        const debtRaw = BigInt(a.max.repayRaw || "0");
        const repay = debtRaw < bal ? debtRaw : bal;
        a.max.repay = fmtUnitsStr(repay, dec);
        a.max.repayRaw = repay.toString();
        a.__mine = true;
        return a;
      }

      async function fillMax() {
        const a = selectedLendingAsset();
        if (!a) return;
        const btn = $("lnMax");
        btn.disabled = true;
        try {
          // Read the wallet first. Filling from a stale agent figure is exactly
          // the bug this replaced.
          await applyMyCaps(a);
          const action = $("lnAction").value;
          $("lnAmount").value = a.max[action] || "0";
          $("lnAmount").dataset.raw = a.max[action + "Raw"] || "";
          renderLendingAsset();
        } finally {
          btn.disabled = false;
        }
      }
      $("lnAsset").addEventListener("change", () => { renderLendingAsset(); refreshMyPositions().catch(() => {}); });
      $("lnAction").addEventListener("change", renderLendingAsset);
      // Manual edits invalidate the remembered exact-MAX raw value.
      $("lnAmount").addEventListener("input", () => { delete $("lnAmount").dataset.raw; });
      $("lnMax").addEventListener("click", fillMax);
      $("lnExecute").addEventListener("click", async () => {
        const a = selectedLendingAsset();
        if (!a) return;
        const action = $("lnAction").value;
        const human = $("lnAmount").value.trim();
        const msg = $("lendingMsg");
        if (!human || Number(human.replace(/,/g, "")) <= 0) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = "Enter an amount (or tap Max).";
          return;
        }
        /*
         * Refuse what the wallet cannot pay for, here, rather than sending it.
         *
         * Supplying more than you hold reverts on chain — but the UI reported
         * success anyway, because it was reporting that the request had been
         * made rather than that it had landed. Checking the balance first turns
         * an unexplained failure into a sentence, and costs one read.
         */
        if (selfMode() && (action === "supply" || action === "repay")) {
          const bal = await myTokenBalance(a.address);
          if (bal !== null) {
            const dec = Number(a.decimals ?? 6);
            const want = $("lnAmount").dataset.raw
              ? BigInt($("lnAmount").dataset.raw)
              : (() => {
                  const [w, f = ""] = human.replace(/,/g, "").split(".");
                  return BigInt(w + (f + "0".repeat(dec)).slice(0, dec));
                })();
            if (want > bal) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent =
                `Your wallet holds ${fmtUnitsStr(bal, dec)} ${a.symbol}. ` +
                `Lower the amount, or tap Max to use all of it.`;
              return;
            }
          }
        }
        // Use the exact raw when the field is an untouched Max; else parse the input.
        const raw = $("lnAmount").dataset.raw || toRaw(human, a.decimals);
        const btn = $("lnExecute");
        // Self-custody: sign with the user's wallet against their own balance.
        if (selfMode()) {
          btn.disabled = true;
          await selfCustody("lendingMsg", `${action} ${human} ${a.symbol}`, async (from, cfg) => {
            const sel = cfg.selectors;
            if (action === "supply" || action === "repay") {
              await ensureAllowance(from, a.address, cfg.pool, raw);
            }
            const fn = action === "supply" ? sel.poolSupply
              : action === "withdraw" ? sel.poolWithdraw
              : action === "borrow" ? sel.poolBorrow
              : sel.poolRepay;
            return sendTx(from, cfg.pool, callData(fn, encAddr(a.address), encUint(raw)));
          });
          btn.disabled = false;
          return;
        }
        btn.disabled = true;
        try {
          const r = await (
            await postAuthed(`/api/lending/${action}?asset=${a.address}&amount=${raw}`)
          ).json();
          msg.style.display = "block";
          msg.textContent = r.ok
            ? `${action} ${human} ${a.symbol} ✓ — tx ${String(r.txHash).slice(0, 12)}…`
            : `failed: ${r.error}`;
          msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
          if (r.ok) { $("lnAmount").value = ""; delete $("lnAmount").dataset.raw; }
        } catch {
          msg.style.display = "block";
          msg.textContent = "request failed";
          msg.style.color = "var(--warn)";
        } finally {
          btn.disabled = false;
          afterTx();
        }
      });

      // --- Vault: deposit / withdraw USDC ------------------------------------
      $("vMax").addEventListener("click", async () => {
        const vt = window.__vault;
        if (!vt) return;
        // Deposit is capped by the connected wallet, not by the agent's balance.
        // `window.__agentUsdc` prefilled 520 into a wallet holding 78.
        if ($("vAction").value === "deposit") {
          const cfg0 = await loadDefiConfig().catch(() => null);
          const mine = cfg0 ? await myTokenBalance(cfg0.usdc || cfg0.vaultAsset) : null;
          $("vAmount").value = mine !== null ? fmtUnitsStr(mine, 6) : (vt.walletUsdc || window.__agentUsdc || "0");
        } else {
          $("vAmount").value = vt.maxWithdraw;
        }
      });
      $("vExecute").addEventListener("click", async () => {
        const vt = window.__vault;
        if (!vt) return;
        const action = $("vAction").value;
        const human = $("vAmount").value.trim();
        const msg = $("vaultMsg");
        if (!human || Number(human.replace(/,/g, "")) <= 0) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = "Enter a USDC amount (or tap Max)."; return;
        }
        const raw = toRaw(human, vt.decimals);
        // Self-custody: deposit/redeem the user's own USDC via their wallet.
        if (selfMode()) {
          const b = $("vExecute"); b.disabled = true;
          await selfCustody("vaultMsg", `${action} ${human} USDC`, async (from, cfg) => {
            const sel = cfg.selectors;
            if (action === "deposit") {
              await ensureAllowance(from, cfg.vaultAsset, cfg.vault, raw);
              return sendTx(from, cfg.vault, callData(sel.vaultDeposit, encUint(raw)));
            }
            // Withdraw takes shares: read the caller's own shares/assets and
            // scale, so "Max" redeems exactly everything they hold.
            const shares = BigInt(await ethCall(cfg.vault, callData(sel.sharesOf, encAddr(from))) || "0x0");
            const assets = BigInt(await ethCall(cfg.vault, callData(sel.balanceOfAssets, encAddr(from))) || "0x0");
            if (shares === 0n || assets === 0n) throw new Error("You have no vault balance to withdraw.");
            const want = BigInt(raw);
            const useShares = want >= assets ? shares : (shares * want) / assets;
            return sendTx(from, cfg.vault, callData(sel.vaultWithdraw, encUint(useShares)));
          });
          b.disabled = false;
          return;
        }
        let query;
        if (action === "deposit") {
          query = `/api/vault/deposit?amount=${raw}`;
        } else {
          // Convert the requested USDC amount to shares proportionally; a full
          // Max (>= your balance) redeems all your shares exactly.
          let shares;
          if (BigInt(raw) >= BigInt(vt.yourAssetsRaw || "0")) {
            shares = vt.yourShares;
          } else {
            shares = (BigInt(vt.yourShares) * BigInt(raw) / BigInt(vt.yourAssetsRaw || "1")).toString();
          }
          query = `/api/vault/withdraw?shares=${shares}`;
        }
        const btn = $("vExecute"); btn.disabled = true;
        try {
          const r = await (await postAuthed(query)).json();
          msg.style.display = "block";
          msg.textContent = r.ok ? `${action} ${human} USDC ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`;
          msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
          if (r.ok) $("vAmount").value = "";
        } catch {
          msg.style.display = "block"; msg.textContent = "request failed"; msg.style.color = "var(--warn)";
        } finally { btn.disabled = false; afterTx(); }
      });

      // --- Swap: quote + execute --------------------------------------------
      function swapSelected() {
        const inOpt = $("swIn").selectedOptions[0], outOpt = $("swOut").selectedOptions[0];
        if (!inOpt || !outOpt) return null;
        return {
          tokenIn: $("swIn").value, tokenOut: $("swOut").value,
          symIn: inOpt.dataset.sym, symOut: outOpt.dataset.sym,
          decIn: +(inOpt.dataset.dec || 6), decOut: +(outOpt.dataset.dec || 6),
        };
      }
      const swAsset = (addr) => (window.__swap ? window.__swap.assets.find((a) => a.address === addr) : null);
      /**
       * Show the exchange rate in both directions plus the balances that decide
       * how much can actually be traded: the user's holding of the input asset
       * and the pooled depth of the output asset.
       */
      window.renderSwapBalances = function renderSwapBalances() {
        const s = swapSelected();
        if (!s) return;
        const ai = swAsset(s.tokenIn), ao = swAsset(s.tokenOut);
        const el = $("swBalances");
        if (!el || !ai || !ao) return;
        if (s.tokenIn === s.tokenOut) {
          const n = (window.__swap && window.__swap.assets.length) || 0;
          el.textContent = n < 2
            ? "Only one asset is available in this pool, so there's nothing to swap against yet."
            : "Pick two different assets.";
          return;
        }
        const pi = parseFloat(ai.priceUsd), po = parseFloat(ao.priceUsd);
        let rate = "";
        if (pi > 0 && po > 0) {
          const outPerIn = pi / po, inPerOut = po / pi;
          const f = (n) => (n >= 1000 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
          rate = `1 ${ai.symbol} ≈ ${f(outPerIn)} ${ao.symbol}  ·  1 ${ao.symbol} ≈ ${f(inPerOut)} ${ai.symbol}`;
        }
        // In self-custody mode prefer the connected wallet's own balance.
        const mine = window.__myTokenIn;
        const yours = mine != null ? mine : ai.wallet;
        el.innerHTML =
          `<div>${esc(rate)}</div>` +
          `<div style="margin-top:4px">Your ${esc(ai.symbol)}: <b>${esc(yours)}</b>` +
          `${mine != null ? ' <span style="opacity:.7">(your wallet)</span>' : ""}` +
          ` · <b>${esc(ao.liquidity)}</b> ${esc(ao.symbol)} in the pools</div>`;
      };

      /**
       * Routable depth, per asset.
       *
       * The successor to the desk's inventory table, and it answers a different
       * question. Inventory was a balance the app stocked and that ran out;
       * this is what liquidity providers have put into the pools, which is what
       * a trade is actually filled from. An asset with nothing in any pool still
       * can't be bought — but the fix is adding liquidity, not topping up a
       * desk, and the table says so.
       */
      window.renderSwapInventory = function renderSwapInventory() {
        const body = $("swInvRows");
        if (!body) return;
        const assets = (window.__swap && window.__swap.assets) || [];
        if (!assets.length) {
          body.innerHTML = emptyRow(3, "No assets yet.");
          return;
        }
        body.innerHTML = assets
          .map((a) => {
            const empty = !parseFloat(a.liquidity);
            return (
              `<tr><td><b>${esc(a.symbol)}</b></td>` +
              `<td class="num ${empty ? "down" : ""}">${esc(a.liquidity)}</td>` +
              `<td><span class="tag ${empty ? "warn" : "ok"}">` +
              `${empty ? "no pool depth — add liquidity to trade it" : "routable"}</span></td></tr>`
            );
          })
          .join("");
      };
      async function swapQuote() {
        const s = swapSelected(); if (!s) return null;
        const human = $("swAmount").value.trim();
        if (!human || Number(human) <= 0) return null;
        // The same-asset hint already appears under the pickers; don't repeat it.
        if (s.tokenIn === s.tokenOut) { $("swQuoteOut").textContent = ""; return null; }
        const amountIn = toRaw(human, s.decIn);
        // Tell the server whose wallet will actually pay. In self-custody mode
        // that is the connected wallet, not the agent's — otherwise the
        // preflight reports a balance the signer has nothing to do with.
        // `eth_accounts` rather than `eth_requestAccounts`: a quote must not
        // pop a connection prompt.
        let from = "";
        if (selfMode() && eth()) {
          try {
            const [a] = await eth().request({ method: "eth_accounts" });
            if (a) from = a;
          } catch { /* not connected — the server falls back to the agent wallet */ }
        }
        const r = await (await fetch(
          `/api/swap/quote?tokenIn=${s.tokenIn}&tokenOut=${s.tokenOut}&amountIn=${amountIn}` +
          (from ? `&from=${encodeURIComponent(from)}` : ""),
        )).json();
        if (!r.ok) { $("swQuoteOut").textContent = "Quote failed: " + r.error; return null; }
        const out = fmtUnitsJs(r.out, s.decOut);
        const eff = Number(out) > 0 && Number(human) > 0 ? (Number(out) / Number(human)) : 0;
        // Name the route. A two-hop fill pays two pools' fees and takes two lots
        // of slippage, which is worth seeing before signing rather than
        // inferring from a rate that looks worse than expected.
        const routeNote =
          r.route === "multi-hop" && r.pathSymbols
            ? ` · routed ${r.pathSymbols.map(esc).join(" → ")} (${r.hops} hops, each pays its own fee)`
          : r.route === "direct" ? ` · direct through pool #${esc(String((r.poolIds || [])[0] ?? 0))}`
          : "";
        $("swQuoteOut").innerHTML =
          `You pay <b>${esc(human)} ${esc(s.symIn)}</b> → you receive <b>${esc(out)} ${esc(s.symOut)}</b><br>` +
          `<span style="font-weight:400;color:var(--muted)">effective rate 1 ${esc(s.symIn)} = ` +
          `${eff ? eff.toPrecision(6) : "—"} ${esc(s.symOut)}` +
          `${routeNote} · fees are taken inside the pool and are already in this figure` +
          ` · 1% max slippage</span>` +
          // Say up front what would revert, instead of after the fact.
          ((r.blockers || []).length
            ? `<div style="margin-top:8px;font-weight:400;font-size:12px;color:var(--warn)">${
                r.blockers.map((b) => esc(b)).join("<br>")
              }</div>`
            : "");
        return { ...s, amountIn, out: r.out, blockers: r.blockers || [] };
      }
      function fmtUnitsJs(raw, dec) {
        const s = String(raw).padStart(dec + 1, "0");
        const i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, "");
        return f ? `${i}.${f}` : i;
      }
      // Refresh the rate/balance line whenever either side changes.
      $("swIn").addEventListener("change", () => { renderSwapBalances(); $("swQuoteOut").textContent = ""; });
      $("swOut").addEventListener("change", () => { renderSwapBalances(); $("swQuoteOut").textContent = ""; });
      /**
       * Max on a swap: your whole balance of the input asset.
       *
       * Prefers the connected wallet's own figure when self-custody is on —
       * filling the agent's balance into a form that will spend the user's is a
       * quote for a trade they cannot make.
       */
      if ($("swMax")) {
        $("swMax").addEventListener("click", () => {
          const s = swapSelected();
          if (!s) return;
          const ai = swAsset(s.tokenIn);
          const mine = window.__myTokenIn;
          const bal = mine != null ? mine : ai && ai.wallet;
          if (bal == null || !(parseFloat(bal) > 0)) {
            $("swQuoteOut").textContent = `No ${ai ? ai.symbol : "input"} balance to sell.`;
            return;
          }
          $("swAmount").value = String(bal);
          swapQuote();
        });
      }

      $("swQuote").addEventListener("click", swapQuote);
      /* Auto-quote while typing. A stale quote is a real risk — the rate could
       * have moved since it was fetched — so the figure refreshes as the amount
       * changes (debounced) and is re-fetched immediately before executing. */
      let quoteTimer = null;
      function scheduleQuote() {
        clearTimeout(quoteTimer);
        const v = $("swAmount").value.trim();
        if (!v || Number(v) <= 0) { $("swQuoteOut").textContent = ""; return; }
        $("swQuoteOut").textContent = "Quoting…";
        quoteTimer = setTimeout(() => { swapQuote().catch(() => {}); }, 350);
      }
      $("swAmount").addEventListener("input", scheduleQuote);
      $("swIn").addEventListener("change", scheduleQuote);
      $("swOut").addEventListener("change", scheduleQuote);
      // Keep the live rate honest while the panel is open.
      setInterval(() => {
        if (!$("swapCard") || $("paneDefi").hidden) return;
        const v = $("swAmount").value.trim();
        if (v && Number(v) > 0) swapQuote().catch(() => {});
      }, 15000);
      $("swExecute").addEventListener("click", async () => {
        const q = await swapQuote();
        const msg = $("swapMsg");
        if (!q) { msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = "Get a valid quote first."; return; }
        // Pre-flight the two things that actually make a swap revert, so the user
        // gets a plain reason instead of a bare "RPC request failed".
        const ai = swAsset(q.tokenIn), ao = swAsset(q.tokenOut);
        const held = window.__myTokenIn != null ? window.__myTokenIn : ai && ai.wallet;
        const human = $("swAmount").value.trim();
        if (held != null && Number(held) < Number(human)) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = `You only have ${held} ${q.symIn} — reduce the amount.`;
          return;
        }
        if (!q.out || BigInt(q.out) === 0n) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = `No pool can fill ${q.symIn} → ${q.symOut} at that size. Try less, or add liquidity for the pair.`;
          return;
        }
        // 1% slippage floor.
        const minOut = (BigInt(q.out) * 99n / 100n).toString();
        const btn = $("swExecute");
        // Self-custody: swap the user's own tokens through their wallet.
        if (selfMode()) {
          btn.disabled = true;
          await selfCustody("swapMsg", `swap ${q.symIn} → ${q.symOut}`, async (from, cfg) => {
            await ensureAllowance(from, q.tokenIn, cfg.router, q.amountIn);
            // Five minutes. The router rejects anything mined after this, which
            // is what stops a transaction that sat in the mempool from being
            // filled at a price nobody agreed to.
            const deadline = String(Math.floor(Date.now() / 1000) + 300);
            return sendTx(
              from,
              cfg.router,
              callData(
                cfg.selectors.swapExec,
                encAddr(q.tokenIn), encAddr(q.tokenOut), encUint(q.amountIn), encUint(minOut), encUint(deadline),
              ),
            );
          });
          btn.disabled = false;
          return;
        }
        btn.disabled = true;
        try {
          const r = await (await postAuthed(`/api/swap?tokenIn=${q.tokenIn}&tokenOut=${q.tokenOut}&amountIn=${q.amountIn}&minOut=${minOut}`)).json();
          msg.style.display = "block";
          msg.textContent = r.ok ? `swapped ${q.symIn} → ${q.symOut} ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`;
          msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
        } catch {
          msg.style.display = "block"; msg.textContent = "request failed"; msg.style.color = "var(--warn)";
        } finally { btn.disabled = false; tick(); }
      });

      /* ===================================================================
       * App fees — intake, split, and the daily chart.
       *
       * Everything here comes from the collector's own `Allocated` events, so
       * every figure is checkable against the chain. When the log scan had to
       * stop early the report says so and the totals are labelled a lower bound
       * rather than quietly under-reporting.
       * =================================================================== */
      async function loadFees() {
        if (feesLoading) return;
        feesLoading = true;
        feeDailyCache = null; // this tab is the authority; re-read for everyone
        const note = $("feeChartNote");
        try {
          const r = await feeDaily({ fresh: true });
          const notReady = $("feesNotReady");
          if (!r.ok && r.indexing) {
            // Not an error: the first pass over the collector's history hasn't
            // landed yet. Say that, and come back for it.
            if (notReady) { notReady.style.display = ""; notReady.textContent = r.error; }
            if (note) note.textContent = "";
            $("feeChart").innerHTML = `<div class="feeChartEmpty">${esc(r.error)}</div>`;
            clearTimeout(feesRetry);
            feesRetry = setTimeout(loadFees, 8000);
            return;
          }
          if (!r.ok) {
            if (notReady) { notReady.style.display = ""; notReady.textContent = r.error || "Fee collector unavailable."; }
            if (note) note.textContent = "";
            $("feeChart").innerHTML = `<div class="feeChartEmpty">${esc(r.error || "No fee data.")}</div>`;
            return;
          }
          if (notReady) notReady.style.display = "none";

          /** Full 6dp, because app fees are fractions of a cent per call. */
          const usd6 = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return String(v);
            if (n === 0) return "0.000000";
            // Below a millionth of a dollar there is nothing left to show in
            // USDC's 6 decimals; say it is non-zero rather than printing 0.
            return n > 0 && n < 0.000001 ? "<0.000001" : n.toFixed(6);
          };
          $("feePending").textContent = usd6(r.pending) + " USDC";
          $("feeTotal").textContent = usd6(r.totals.total) + " USDC";
          const secs = Number(r.secondsUntilAllocatable);
          $("feeNext").textContent =
            secs <= 0 ? "ready now" : secs < 3600 ? `${Math.round(secs / 60)}m` : `${Math.round(secs / 3600)}h`;

          // Each sink's configured share alongside what it has actually received.
          const rows = [
            ["Agent wallet", r.split.agentBps, r.totals.toAgent],
            ["Lending pool", r.split.lendingBps, r.totals.toLending],
            ["Yield vault", r.split.vaultBps, r.totals.toVault],
            ["AMM pools", r.split.swapBps, r.totals.toSwap],
            ["Retained", r.split.retainedBps, r.totals.retained],
          ];
          $("feeSplitRows").innerHTML = rows
            .map(([label, bps, got]) =>
              `<tr><td><b>${esc(label)}</b></td>` +
              `<td class="num">${esc((Number(bps) / 100).toFixed(0))}%</td>` +
              `<td class="num mono">${esc(usd6(got))}</td></tr>`)
            .join("");

          renderFeeChart(r.daily);
          if (note) {
            note.className = r.partial ? "feedNote bad" : "feedNote";
            note.textContent = r.partial
              ? `Read as far back as block ${r.block} allowed — these are a lower bound, not a total.`
              : `${r.daily.length} day(s) of history, from the collector's Allocated events.`;
          }
          // The operator controls spend the deployer key, so they are gated.
          const admin = $("feeAdmin");
          if (admin) admin.style.display = adminId ? "" : "none";
        } catch (e) {
          // Say what actually went wrong. "Couldn't reach the server" was a
          // guess, and it was wrong for every render failure — which is exactly
          // the case that leaves every figure showing an em-dash.
          const why = String((e && e.message) || e);
          if (note) { note.className = "feedNote bad"; note.textContent = `Could not render the fee report: ${why}`; }
          const nr = $("feesNotReady");
          if (nr) { nr.style.display = ""; nr.textContent = `Fee report failed to render: ${why}`; }
        } finally {
          feesLoading = false;
        }
      }

      /** Bars, one per day, scaled to the largest. */
      function renderFeeChart(daily) {
        const host = $("feeChart");
        if (!host) return;
        if (!daily || !daily.length) {
          host.innerHTML = `<div class="feeChartEmpty">No fees distributed yet — the chart fills in once the first split runs.</div>`;
          return;
        }
        const max = Math.max(...daily.map((d) => d.total)) || 1;
        host.innerHTML = daily
          .map((d) => {
            const pct = Math.max(2, Math.round((d.total / max) * 100));
            const tip = `${d.day}: ${d.total.toFixed(6)} USDC total · agent ${d.toAgent.toFixed(4)} · lending ` +
              `${d.toLending.toFixed(4)} · vault ${d.toVault.toFixed(4)} · swap ${d.toSwap.toFixed(4)}`;
            return `<span class="feeBar" title="${esc(tip)}"><i style="height:${pct}%"></i></span>`;
          })
          .join("");
        // Newest day in view, which is the one anyone looks for first.
        host.scrollLeft = host.scrollWidth;
      }

      if ($("feeAllocate")) {
        const feeMsg = (text, colour) => {
          const m = $("feeMsg");
          m.style.display = "block"; m.textContent = text; m.style.color = colour;
        };
        $("feeAllocate").addEventListener("click", async () => {
          const btn = $("feeAllocate");
          btn.disabled = true;
          try {
            const r = await (await postAuthed("/api/fees/allocate")).json();
            feeMsg(r.ok ? `distributed ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`,
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) loadFees();
          } catch { feeMsg("request failed", "var(--warn)"); }
          finally { btn.disabled = false; }
        });
        $("feeWithdraw").addEventListener("click", async () => {
          const human = $("feeWithdrawAmount").value.trim();
          if (!human || !(parseFloat(human) > 0)) return feeMsg("Enter an amount above zero.", "var(--warn)");
          const btn = $("feeWithdraw");
          btn.disabled = true;
          try {
            const raw = toRaw(human, 6); // the collector's asset is USDC
            const r = await (await postAuthed(`/api/fees/withdraw?amount=${raw}`)).json();
            feeMsg(r.ok ? `withdrew ${human} USDC ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`,
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("feeWithdrawAmount").value = ""; loadFees(); }
          } catch { feeMsg("request failed", "var(--warn)"); }
          finally { btn.disabled = false; }
        });
      }

      /* ====================================================================
       * Holder leaderboards, one per DeFi venue.
       *
       * Who is in each pool, largest first, paged. The list arrives sorted from
       * the server (ranking share counts needs bigint arithmetic, which is the
       * server's job) and is paged here, so flipping pages costs nothing and
       * doesn't re-run a log scan.
       *
       * The venue's own daily fee history sits under the same card, drawn from
       * the collector's `Allocated` events — the same source as the App fees
       * tab, filtered to the one series that belongs to this venue.
       * ==================================================================== */

      /** Format a raw integer balance for one asset. */
      function holdAmount(raw, asset) {
        if (!asset) return raw;
        const n = Number(raw) / 10 ** asset.decimals;
        if (!Number.isFinite(n)) return raw;
        const dp = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
        return `${n.toLocaleString(undefined, { maximumFractionDigits: dp })} ${asset.symbol}`;
      }

      async function loadHolders(key, opts) {
        const st = holdState[key];
        const v = HOLD_VENUES[key];
        if (!st || st.loading) return;
        st.loading = true;
        const note = $(`hold${key}Note`);
        // A cold scan walks the contract's whole history in windowed getLogs
        // calls and can take a minute. Without this the table just sits empty,
        // which reads as "no holders" rather than "still counting".
        try {
          const url = `/api/holders?kind=${v.kind}${opts && opts.refresh ? "&refresh=1" : ""}`;
          const r = await (await fetch(url)).json();
          if (!r.ok) throw new Error(r.error || "unavailable");
          st.report = r;
          st.rows = r.holders || [];
          st.assets = r.assets || [];
          if (!opts || !opts.keepPage) st.page = 1;
          renderHolders(key);

          // The server answers straight away and scans in the background, so a
          // slow sweep can never time out the request. Poll until it lands.
          if (note) {
            // A short log scan under-reports *who*, never *how much*. Say so —
            // a leaderboard quietly missing its biggest holder is worse than
            // one that admits the scan was incomplete.
            const parts = [];
            if (r.note) parts.push(r.note);
            // Balances are always live reads, so a half-built index shows fewer
            // holders but never a wrong number. Say which of those it is.
            const p = r.progress;
            if (p && !p.complete) {
              parts.push(
                `Indexing past holders — ${Math.round(p.ratio * 100)}% of the contract's history read so far. ` +
                "Balances shown are exact; more addresses will appear as it catches up.",
              );
              clearTimeout(st.pollTimer);
              st.pollTimer = setTimeout(() => loadHolders(key, { keepPage: true }), 6000);
            } else if (p && p.gaps > 0) {
              parts.push(`${p.gaps} block range${p.gaps === 1 ? "" : "s"} could not be read, so a holder may be missing.`);
            } else if (st.rows.length) {
              parts.push(`Read at block ${r.block}.`);
            }
            note.className = r.partial ? "feedNote bad" : "feedNote";
            note.textContent = parts.join(" ");
          }
        } catch (e) {
          if (note) { note.className = "feedNote bad"; note.textContent = String(e.message || e); }
          $(`hold${key}Rows`).innerHTML = `<tr><td colspan="5" class="muted">Could not read holders.</td></tr>`;
          $(`hold${key}Pager`).innerHTML = "";
        } finally {
          st.loading = false;
        }
      }

      function renderHolders(key) {
        const st = holdState[key];
        const body = $(`hold${key}Rows`);
        if (!body) return;

        const head = $(`hold${key}RankHead`);
        if (head && st.report) head.textContent = st.report.rankLabel || "Share";

        if (!st.rows.length) {
          const why = st.report && st.report.progress && !st.report.progress.complete
            ? "Indexing the contract's history — holders appear here as they are found."
            : st.report && st.report.note
              ? ""
              : "No positions yet — the first deposit shows up here.";
          body.innerHTML = `<tr><td colspan="5" class="muted">${esc(why)}</td></tr>`;
          $(`hold${key}Pager`).innerHTML = "";
          return;
        }

        const pages = Math.max(1, Math.ceil(st.rows.length / st.size));
        st.page = Math.min(Math.max(1, st.page), pages);
        const start = (st.page - 1) * st.size;
        const slice = st.rows.slice(start, start + st.size);
        const isUsd = st.report && /USD/i.test(st.report.rankLabel || "");

        body.innerHTML = slice
          .map((h, i) => {
            const rank = isUsd
              ? `$${(Number(h.rank) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : Number(h.rank) / 1e18 >= 0.0001
                ? (Number(h.rank) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 })
                : h.rank;
            const position = st.assets
              .map((a) => {
                const raw = (h.balances || {})[a.address.toLowerCase()];
                return raw && raw !== "0" ? holdAmount(raw, a) : null;
              })
              .filter(Boolean)
              .join(" · ") || "—";
            return `<tr class="${h.isApp ? "selfRow" : ""}">
              <td class="num muted">${start + i + 1}</td>
              <td class="mono" style="font-size:11.5px">${esc(h.address)}${h.isApp ? '<span class="appTag">app</span>' : ""}</td>
              <td class="num mono">${esc(rank)}</td>
              <td class="num">${h.pct.toFixed(2)}%</td>
              <td style="font-size:12px">${esc(position)}</td>
            </tr>`;
          })
          .join("");

        renderPager(key, st.page, pages, st.rows.length);
      }

      /**
       * First / prev / numbered / next / last, plus a page-size picker.
       *
       * The numbers are buttons, not a label: "page 7 of 12" you can't click is
       * a status line. Long runs collapse around the current page so the strip
       * doesn't wrap into a wall on a pool with hundreds of providers.
       */
      function renderPager(key, page, pages, total) {
        const host = $(`hold${key}Pager`);
        if (!host) return;
        const btn = (label, target, opts = {}) =>
          `<button class="pgBtn${opts.active ? " active" : ""}" data-pg="${target}"${
            opts.disabled ? " disabled" : ""
          }${opts.title ? ` title="${esc(opts.title)}"` : ""}>${label}</button>`;

        const nums = [];
        const push = (n) => nums.push(btn(String(n), n, { active: n === page }));
        if (pages <= 7) {
          for (let n = 1; n <= pages; n++) push(n);
        } else {
          push(1);
          const from = Math.max(2, page - 1);
          const to = Math.min(pages - 1, page + 1);
          if (from > 2) nums.push(`<span class="pgGap">…</span>`);
          for (let n = from; n <= to; n++) push(n);
          if (to < pages - 1) nums.push(`<span class="pgGap">…</span>`);
          push(pages);
        }

        const sizes = HOLD_SIZES.map(
          (n) => `<option value="${n}"${n === holdState[key].size ? " selected" : ""}>${n} / page</option>`,
        ).join("");

        host.innerHTML =
          btn("« First", 1, { disabled: page === 1, title: "First page" }) +
          btn("‹ Prev", page - 1, { disabled: page === 1 }) +
          nums.join("") +
          btn("Next ›", page + 1, { disabled: page === pages }) +
          btn("Last »", pages, { disabled: page === pages, title: "Last page" }) +
          `<select class="field" data-pgsize style="margin-left:8px">${sizes}</select>` +
          `<span class="pgInfo">${total} holder${total === 1 ? "" : "s"}</span>`;

        host.querySelectorAll("[data-pg]").forEach((b) =>
          b.addEventListener("click", () => {
            holdState[key].page = Number(b.dataset.pg);
            renderHolders(key);
          }),
        );
        host.querySelector("[data-pgsize]").addEventListener("change", (e) => {
          // Keep the first row of the current view visible rather than jumping
          // back to page 1, which loses your place in a long list.
          const st = holdState[key];
          const firstRow = (st.page - 1) * st.size;
          st.size = Number(e.target.value);
          st.page = Math.floor(firstRow / st.size) + 1;
          renderHolders(key);
        });
      }

      /* --- the per-venue daily fee chart -------------------------------- */

      /** Cached once per load; all four venue charts read the same report. */
      async function feeDaily(opts) {
        if (feeDailyCache && !(opts && opts.fresh)) return feeDailyCache;
        try {
          const res = await fetch("/api/fees");
          const r = await res.json();
          // Keep the whole body either way. Reducing a failure to {ok,error}
          // threw away `indexing`, which is the difference between "no fees" and
          // "still reading the history".
          feeDailyCache = r.ok ? r : { ...r, ok: false, error: r.error || `HTTP ${res.status}` };
        } catch (e) {
          feeDailyCache = { ok: false, error: String(e.message || e) };
        }
        return feeDailyCache;
      }

      async function loadVenueChart(key) {
        const v = HOLD_VENUES[key];
        const host = $(`hold${key}Chart`);
        const note = $(`hold${key}ChartNote`);
        const stats = $(`hold${key}Stats`);
        if (!host) return;
        const r = await feeDaily();
        if (!r.ok) {
          host.innerHTML = `<div class="feeChartEmpty">${esc(r.error || "No fee data.")}</div>`;
          // Still building the fee history — check back rather than sit blank.
          if (r.indexing) { feeDailyCache = null; setTimeout(() => loadVenueChart(key), 8000); }
          if (note) note.textContent = "";
          if (stats) stats.innerHTML = "";
          return;
        }
        const days = Number($(`hold${key}Range`) ? $(`hold${key}Range`).value : 0);
        let rows = r.daily || [];
        if (days > 0) {
          const cut = Date.now() - days * 86400_000;
          rows = rows.filter((d) => Date.parse(d.day + "T00:00:00Z") >= cut);
        }
        const series = rows.map((d) => ({ day: d.day, v: d[v.series] || 0 }));
        if (!series.length || series.every((d) => d.v === 0)) {
          host.innerHTML = `<div class="feeChartEmpty">No fees routed to the ${esc(v.label)} in this range yet.</div>`;
          if (stats) stats.innerHTML = "";
        } else {
          const max = Math.max(...series.map((d) => d.v)) || 1;
          host.innerHTML = series
            .map((d) => {
              const pct = d.v > 0 ? Math.max(2, Math.round((d.v / max) * 100)) : 1;
              return `<span class="feeBar" title="${esc(`${d.day}: ${d.v.toFixed(6)} USDC to the ${v.label}`)}"><i style="height:${pct}%"></i></span>`;
            })
            .join("");
          host.scrollLeft = host.scrollWidth;

          const sum = series.reduce((s, d) => s + d.v, 0);
          const active = series.filter((d) => d.v > 0);
          const best = active.reduce((a, d) => (d.v > a.v ? d : a), active[0]);
          if (stats) {
            stats.innerHTML =
              `<span>Total in range</span><b>${sum.toFixed(6)} USDC</b>` +
              `<span>Days with a distribution</span><b>${active.length} of ${series.length}</b>` +
              `<span>Average per active day</span><b>${(sum / active.length).toFixed(6)} USDC</b>` +
              `<span>Best day</span><b>${esc(best.day)} — ${best.v.toFixed(6)} USDC</b>`;
          }
        }
        if (note) {
          note.className = r.partial ? "feedNote bad" : "feedNote";
          note.textContent = r.partial
            ? "The log scan stopped early, so these are a lower bound rather than the full history."
            : `From the collector's own Allocated events${rows.length ? ` — ${rows[0].day} to ${rows[rows.length - 1].day}` : ""}.`;
        }
      }

      for (const key of Object.keys(HOLD_VENUES)) {
        const sel = $(`hold${key}Range`);
        if (sel) sel.addEventListener("change", () => loadVenueChart(key));
      }

      /* --- reserve prices, and the drift from the live market ------------ */

      async function loadPoolPrices() {
        const body = $("poolPriceRows");
        if (!body) return;
        const note = $("poolPriceNote");
        try {
          const r = await (await fetch("/api/lending/prices")).json();
          if (!r.ok) throw new Error(r.error || "unavailable");
          if (r.supported === false) {
            // Not a failure — this pool simply predates the price surface.
            body.innerHTML = `<tr><td colspan="5" class="muted">Reserve prices are not exposed by this pool.</td></tr>`;
            // A pool with no risk levers is a standing risk, not a footnote.
            if (note) { note.className = "feedNote bad"; note.textContent = r.note || ""; }
            return;
          }
          body.innerHTML = r.assets
            .map((a) => {
              const pool = a.onChainUsd === null ? "—" : `$${a.onChainUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
              const mkt = a.marketUsd === null ? "—" : `$${a.marketUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
              const drift = a.driftPct === null
                ? `<td class="num flat">—</td>`
                : `<td class="num ${a.stale ? "down" : "flat"}">${a.driftPct >= 0 ? "+" : ""}${a.driftPct.toFixed(2)}%</td>`;
              // Only offer the button where there is a market price to sync to.
              const action = r.canSet && a.marketUsd !== null
                ? `<button class="btn" data-syncprice="${esc(a.address)}" data-usd="${a.marketUsd}">Sync to market</button>`
                : "";
              return `<tr class="${a.stale ? "selfRow" : ""}">
                <td><b>${esc(a.symbol)}</b></td>
                <td class="num mono">${pool}</td>
                <td class="num mono">${mkt}</td>
                ${drift}
                <td class="num">${action}</td>
              </tr>`;
            })
            .join("");

          body.querySelectorAll("[data-syncprice]").forEach((b) =>
            b.addEventListener("click", async () => {
              b.disabled = true;
              const prev = b.textContent;
              b.textContent = "Setting…";
              try {
                const q = `asset=${encodeURIComponent(b.dataset.syncprice)}&usd=${encodeURIComponent(b.dataset.usd)}`;
                const res = await (await postAuthed(`/api/lending/admin/price?${q}`)).json();
                if (note) {
                  note.className = res.ok ? "feedNote" : "feedNote bad";
                  note.textContent = res.ok ? `Repriced — tx ${res.txHash}` : res.error || "failed";
                }
                if (res.ok) { loadPoolPrices(); afterTx(); }
              } catch (e) {
                if (note) { note.className = "feedNote bad"; note.textContent = String(e.message || e); }
              } finally {
                b.disabled = false;
                b.textContent = prev;
              }
            }),
          );

          const stale = r.assets.filter((a) => a.stale);
          if (note && !note.textContent.startsWith("Repriced")) {
            note.className = stale.length ? "feedNote bad" : "feedNote";
            note.textContent = stale.length
              ? `${stale.map((a) => a.symbol).join(", ")} ${stale.length === 1 ? "is" : "are"} more than 5% away from the market. ` +
                "Borrow limits and liquidation thresholds are computed from the pool price, so this gap is real money."
              : "Pool prices are in line with the market feed.";
          }
        } catch (e) {
          body.innerHTML = `<tr><td colspan="5" class="muted">Could not read reserve prices.</td></tr>`;
          if (note) { note.className = "feedNote bad"; note.textContent = String(e.message || e); }
        }
      }

      /** Everything one DeFi tab needs beyond its own card. */
      /* ===================================================================
       * Backstop and liquidation auctions.
       *
       * Both are read-public. Cover is what a supplier is really relying on, so
       * hiding it behind a login would be hiding the risk; and a descending
       * auction that only the operator can see clears at its floor instead of
       * at what the market would actually pay.
       * =================================================================== */
      let backstopAssets = [];

      async function loadBackstop() {
        const body = $("backstopRows");
        if (!body) return;
        try {
          const r = await (await fetch("/api/lending/backstop")).json();
          const notReady = $("backstopNotReady");
          if (!r.ok) { body.innerHTML = emptyRow(4, "Backstop unavailable."); return; }
          if (!r.supported) {
            // A pool deployed before the backstop existed has none of these
            // functions. Say which, rather than showing an empty table that
            // reads as "nobody has put up cover".
            if (notReady) { notReady.style.display = ""; notReady.textContent = r.note || "This pool has no backstop."; }
            body.innerHTML = emptyRow(4, "Not available on this pool.");
            const box = $("backstopBox"); if (box) box.style.display = "none";
            return;
          }
          if (notReady) notReady.style.display = "none";
          backstopAssets = r.assets || [];
          const rate = $("backstopRate");
          if (rate) {
            // Its own element rather than rewriting the paragraph: this refreshes
            // on every poll, and appending to innerHTML would stack a new
            // sentence onto the last one each time.
            rate.innerHTML = r.takeRateBps
              ? `<b>Currently ${esc(String(r.takeRateBps / 100))}% of borrower interest</b> is routed here.`
              : "<b>No share of interest is routed here yet</b> — an operator sets the take rate.";
          }
          body.innerHTML = backstopAssets
            .map((a) => {
              const queued = a.queuedShares !== "0";
              const ready = queued && a.unlockIn === 0;
              const days = Math.ceil(a.unlockIn / 86400);
              const queueCell = !queued
                ? '<span style="color:var(--muted)">—</span>'
                : ready
                  ? '<span class="tag ok">unlocked — withdrawable now</span>'
                  : `<span class="tag warn">${esc(String(days))} day${days === 1 ? "" : "s"} left</span>`;
              return (
                `<tr><td><b>${esc(a.symbol)}</b></td>` +
                `<td class="num">${esc(a.pot)}</td>` +
                `<td class="num">${esc(a.myValue)}</td>` +
                `<td>${queueCell}</td></tr>`
              );
            })
            .join("") || emptyRow(4, "No reserves.");

          const box = $("backstopBox");
          if (box) {
            box.style.display = adminId ? "" : "none";
            const sel = $("bsAsset");
            if (sel && sel.options.length !== backstopAssets.length) {
              sel.innerHTML = backstopAssets
                .map((a) => `<option value="${esc(a.address)}" data-dec="${Number(a.decimals) || 6}">${esc(a.symbol)}</option>`)
                .join("");
            }
          }
        } catch {
          body.innerHTML = emptyRow(4, "Backstop unavailable.");
        }
      }

      function bsShow(text, colour) {
        const m = $("backstopMsg");
        if (!m) return;
        m.style.display = "block"; m.textContent = text; m.style.color = colour;
      }

      function wireBackstop() {
        const pick = () => {
          const sel = $("bsAsset");
          const addr = sel && sel.value;
          return backstopAssets.find((a) => a.address === addr) || null;
        };
        const post = async (path, query, label) => {
          try {
            const r = await (await postAuthed(path + (query ? "?" + query : ""))).json();
            bsShow(r.ok ? `${label} ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`,
                   r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("bsAmount").value = ""; loadBackstop(); afterTx(); }
          } catch {
            bsShow("request failed", "var(--warn)");
          }
        };
        const amountAction = (btnId, action, label, sharesNotAssets) => {
          const btn = $(btnId);
          if (!btn) return;
          btn.addEventListener("click", () => {
            const a = pick();
            if (!a) return bsShow("Pick an asset.", "var(--warn)");
            const human = $("bsAmount").value.trim();
            if (!human || !(parseFloat(human) > 0)) return bsShow("Enter an amount above zero.", "var(--warn)");
            // Queueing an exit is denominated in *shares*, not assets: a share
            // is a claim on a pot whose value moves, so asking for "50 USDC out"
            // would be a number that stops meaning anything the moment interest
            // accrues or a loss lands.
            const raw = sharesNotAssets ? String(BigInt(Math.floor(Number(human)))) : toRaw(human, a.decimals);
            post(`/api/lending/backstop/${action}`, `asset=${a.address}&amount=${raw}`, label);
          });
        };
        amountAction("bsDeposit", "deposit", "cover deposited", false);
        amountAction("bsQueue", "queue", "exit queued", true);
        for (const [btnId, action, label] of [
          ["bsCancel", "cancel", "exit cancelled"],
          ["bsWithdraw", "withdraw", "cover withdrawn"],
        ]) {
          const btn = $(btnId);
          if (!btn) continue;
          btn.addEventListener("click", () => {
            const a = pick();
            if (!a) return bsShow("Pick an asset.", "var(--warn)");
            post(`/api/lending/backstop/${action}`, `asset=${a.address}`, label);
          });
        }
      }

      function auShow(text, colour) {
        const m = $("auctionMsg");
        if (!m) return;
        m.style.display = "block"; m.textContent = text; m.style.color = colour;
      }

      async function loadAuction() {
        const status = $("auStatus");
        if (!status) return;
        const user = ($("auUser").value || "").trim();
        const openBox = $("auOpenBox"), actions = $("auActions");
        if (!/^0x[0-9a-fA-F]{40}$/.test(user)) {
          status.textContent = "Enter a borrower address to look up.";
          if (openBox) openBox.style.display = "none";
          if (actions) actions.style.display = "none";
          return;
        }
        // Populate the asset pickers from the same list the backstop uses, so
        // the two cards can never disagree about which reserves exist.
        for (const id of ["auDebt", "auCollateral", "auDebtAsset2"]) {
          const sel = $(id);
          if (sel && sel.options.length !== backstopAssets.length && backstopAssets.length) {
            sel.innerHTML = backstopAssets.map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`).join("");
          }
        }
        try {
          const r = await (await fetch(`/api/lending/auction?user=${encodeURIComponent(user)}`)).json();
          if (!r.ok) { status.textContent = `Lookup failed: ${r.error}`; return; }
          if (!r.supported) {
            status.textContent = "This pool was deployed before auctions existed.";
            if (openBox) openBox.style.display = "none";
            if (actions) actions.style.display = "none";
            return;
          }
          if (actions) actions.style.display = adminId ? "" : "none";
          if (!r.open) {
            if (openBox) openBox.style.display = "none";
            status.innerHTML = r.liquidatable
              ? '<span class="tag warn">liquidatable</span> No auction is running against this account yet. ' +
                "Pick a percentage that lands its health factor inside the band and start one."
              : '<span class="tag ok">healthy</span> This account is above its liquidation threshold, so no auction can be opened against it.';
            return;
          }
          if (openBox) openBox.style.display = "";
          const phase = r.bidBps >= 10000
            ? "ramping up — the lot is still growing, the full debt is demanded"
            : "past the midpoint — the whole lot is on offer and the debt demanded is falling";
          status.innerHTML =
            `<span class="tag warn">auction open</span> ${esc(String(Math.floor(r.elapsed / 60)))}m ${esc(String(r.elapsed % 60))}s in · ${esc(phase)}`;
          const row = (k, v) => `<tr><td style="color:var(--muted)">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`;
          $("auRows").innerHTML =
            row("Debt auctioned", `${r.debtAmount} ${r.debtSymbol}`) +
            row("Collateral lot", `${r.collateralAmount} ${r.collateralSymbol}`) +
            row("Filled so far", `${r.filledBps / 100}%`) +
            row("Lot on offer now", `${r.lotBps / 100}%`) +
            row("Debt demanded now", `${r.bidBps / 100}%`) +
            // The two numbers a liquidator actually decides on. The percentages
            // above are the mechanism; these are the trade.
            row("Take the rest now: you pay", `${r.repayNow} ${r.debtSymbol}`) +
            row("…and receive", `${r.seizeNow} ${r.collateralSymbol}`);
        } catch {
          status.textContent = "Lookup failed.";
        }
      }

      function wireAuction() {
        if ($("auLoad")) $("auLoad").addEventListener("click", () => loadAuction());
        if ($("auUser")) {
          $("auUser").addEventListener("keydown", (e) => { if (e.key === "Enter") loadAuction(); });
        }
        const user = () => ($("auUser").value || "").trim();
        const post = async (path, body, label) => {
          if (!/^0x[0-9a-fA-F]{40}$/.test(user())) return auShow("Enter a borrower address first.", "var(--warn)");
          try {
            const r = await (await postJson(path, body)).json();
            auShow(r.ok ? `${label} ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`,
                   r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { loadAuction(); afterTx(); }
          } catch {
            auShow("request failed", "var(--warn)");
          }
        };
        const pct = () => {
          const v = parseFloat(($("auPct").value || "").trim());
          return Number.isFinite(v) && v > 0 && v <= 100 ? Math.round(v * 100) : null;
        };
        if ($("auStart")) {
          $("auStart").addEventListener("click", () => {
            const p = pct();
            if (p === null) return auShow("Enter a percentage between 0 and 100.", "var(--warn)");
            post("/api/lending/auction/start", {
              user: user(), percentBps: p,
              debtAsset: $("auDebt").value, collateralAsset: $("auCollateral").value,
            }, "auction started");
          });
        }
        if ($("auFill")) {
          $("auFill").addEventListener("click", () => {
            const p = pct();
            if (p === null) return auShow("Enter a percentage between 0 and 100.", "var(--warn)");
            post("/api/lending/auction/fill", { user: user(), fillBps: p }, "auction filled");
          });
        }
        if ($("auCancel")) {
          $("auCancel").addEventListener("click", () => post("/api/lending/auction/cancel", { user: user() }, "auction cancelled"));
        }
        if ($("auClearDebt")) {
          $("auClearDebt").addEventListener("click", () =>
            post("/api/lending/auction/cleardebt", { user: user(), asset: $("auDebtAsset2").value }, "bad debt cleared"));
        }
      }

      wireBackstop();
      wireAuction();

      function loadVenuePanels(key) {
        // Only the visible venue polls; leaving a tab mid-scan shouldn't keep
        // a timer alive for a card nobody is looking at.
        for (const other of Object.keys(HOLD_VENUES)) {
          if (other !== key) clearTimeout(holdState[other].pollTimer);
        }
        loadHolders(key);
        loadVenueChart(key);
        if (key === "Lending") { loadPoolPrices(); loadBackstop(); loadAuction(); }
      }

      /** Reverse a swap pair. Two selects, one click — the common second trade. */
      function wireFlip(btnId, inId, outId, after) {
        const btn = $(btnId);
        if (!btn) return;
        btn.addEventListener("click", () => {
          const a = $(inId), b = $(outId);
          if (!a || !b) return;
          const v = a.value;
          a.value = b.value;
          b.value = v;
          // A select whose option list doesn't contain the value silently keeps
          // its old one, which would leave the pair unchanged and look broken.
          if (a.value !== b.value || a.selectedIndex !== b.selectedIndex) {
            a.dispatchEvent(new Event("change"));
            b.dispatchEvent(new Event("change"));
          }
          if (after) after();
        });
      }
      wireFlip("swFlip", "swIn", "swOut", () => {
        if (window.renderSwapBalances) window.renderSwapBalances();
        const q = $("swQuoteOut");
        if (q) q.textContent = ""; // the old quote is for the old direction
      });
      wireFlip("amFlip", "amSwapIn", "amSwapOut", () => {
        const q = $("amSwapQuote");
        if (q) q.textContent = "";
      });

      /* ===================================================================
       * Operator notices — the running banner and the bell.
       *
       * The server decides what is active (a pure function of each notice's
       * schedule), so the browser never has to run timers to decide visibility;
       * it just polls and renders. A dismissed notice is remembered by id so it
       * doesn't reappear on the next poll, but a *new* notice always shows.
       * =================================================================== */
      const DISMISSED_KEY = "tessera_notice_dismissed";
      const dismissed = () => {
        try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]")); } catch { return new Set(); }
      };
      function dismiss(id) {
        const s = dismissed();
        s.add(id);
        // Keep the list short — a dismissal only has to outlive the notice.
        try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...s].slice(-100))); } catch {}
      }

      let noticeCurrent = null;
      function renderNotice(list) {
        const bar = $("noticeBar");
        if (!bar) return;
        const skip = dismissed();
        const n = (list || []).find((x) => !skip.has(x.id)) || null;
        if (!n) { bar.hidden = true; noticeCurrent = null; return; }
        // Only repaint when the notice actually changes, so the marquee doesn't
        // jump back to the start on every poll.
        if (noticeCurrent && noticeCurrent.id === n.id && noticeCurrent.text === n.text) return;
        noticeCurrent = n;
        bar.hidden = false;
        bar.classList.toggle("alert", n.kind === "alert");
        $("noticeIcon").textContent = n.kind === "alert" ? "⚠️" : "📣";
        const el = $("noticeText");
        el.textContent = n.text; // text node, never innerHTML
        el.style.color = n.color || "";
        // Scroll speed proportional to length so long and short notices both
        // read at a comfortable pace.
        el.style.setProperty("--marquee", Math.max(12, Math.min(60, n.text.length * 0.35)) + "s");
      }

      async function pollNotices() {
        try {
          const r = await (await fetch("/api/notices")).json();
          if (r && r.ok) {
            renderNotice(r.active);
            const skip = dismissed();
            const unseen = (r.active || []).some((x) => !skip.has(x.id));
            if ($("bellDot")) $("bellDot").hidden = !unseen;
          }
        } catch { /* a missing banner must never break the page */ }
      }
      if ($("noticeClose")) {
        $("noticeClose").addEventListener("click", () => {
          if (noticeCurrent) dismiss(noticeCurrent.id);
          $("noticeBar").hidden = true;
          noticeCurrent = null;
          pollNotices();
        });
      }

      const fmtWhen = (ms) => {
        const d = new Date(ms);
        return isNaN(d) ? "" : d.toLocaleString();
      };
      async function loadBell(from, to) {
        const list = $("bellList");
        if (!list) return;
        const qs = new URLSearchParams();
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        qs.set("limit", "50");
        try {
          const r = await (await fetch("/api/notices/feed?" + qs.toString())).json();
          const items = (r && r.notices) || [];
          list.innerHTML = items.length
            ? items
                .map(
                  (n) =>
                    `<div class="bellItem">` +
                    `<span style="color:${esc(n.color || "var(--text)")}">` +
                    `${n.kind === "alert" ? "⚠️ " : ""}${esc(n.text)}</span>` +
                    `<span class="when">${esc(fmtWhen(n.startAt))}${n.active ? " · showing now" : ""}</span>` +
                    `</div>`,
                )
                .join("")
            : `<div class="bellEmpty">Nothing in this range.</div>`;
        } catch {
          list.innerHTML = `<div class="bellEmpty">Couldn't load notifications.</div>`;
        }
      }

      if ($("bellBtn")) {
        const panel = $("bellPanel");
        const closeBell = () => {
          panel.classList.remove("open");
          $("bellBtn").setAttribute("aria-expanded", "false");
        };
        $("bellBtn").addEventListener("click", (e) => {
          e.stopPropagation();
          const open = panel.classList.toggle("open");
          $("bellBtn").setAttribute("aria-expanded", open ? "true" : "false");
          if (open) {
            $("bellDot").hidden = true;
            loadBell();
          }
        });
        panel.addEventListener("click", (e) => e.stopPropagation());
        document.addEventListener("click", closeBell);
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeBell(); });
        $("bellApply").addEventListener("click", () => {
          const from = $("bellFrom").value ? Date.parse($("bellFrom").value + "T00:00:00") : "";
          // Include the whole of the "to" day — a date picker means the day, not
          // the instant midnight begins.
          const to = $("bellTo").value ? Date.parse($("bellTo").value + "T23:59:59.999") : "";
          loadBell(from, to);
        });
        $("bellClear").addEventListener("click", () => {
          $("bellFrom").value = "";
          $("bellTo").value = "";
          loadBell();
        });
      }
      pollNotices();
      setInterval(pollNotices, 20000);

      /* ===================================================================
       * AMM liquidity pools.
       *
       * Pool choice is sticky across refreshes (the panel repaints on every
       * poll, and silently resetting the picker mid-edit would be maddening).
       * =================================================================== */
      const amPools = () => (window.__amm && window.__amm.pools) || [];
      /**
       * LP shares the *connected wallet* holds, keyed by pool id, filled in by
       * `refreshMyPositions`. The server snapshot reports the agent's position;
       * in self-custody mode this map takes precedence.
       */
      window.__myAmmShares = {};
      /** The pool as it should be shown: the caller's own position when known. */
      function amMine(p) {
        const own = selfMode() ? window.__myAmmShares[p.id] : undefined;
        if (own === undefined) return p;
        const total = BigInt(p.totalShares || "0");
        const mine = BigInt(own);
        const pct = total > 0n ? (Number(mine) / Number(total)) * 100 : 0;
        return {
          ...p,
          myShares: own,
          mySharePct: pct.toFixed(pct > 0 && pct < 0.01 ? 4 : 2),
          assets: p.assets.map((a) => {
            const share = total > 0n ? (Number(a.balance) * Number(mine)) / Number(total) : 0;
            const dec = Number(a.decimals) || 6;
            return { ...a, myBalance: share ? share.toFixed(dec).replace(/0+$/, "").replace(/\.$/, "") : "0" };
          }),
        };
      }
      const amSelected = () => {
        const p = amPools();
        if (!p.length) return null;
        const want = Number($("amPool").value);
        return p.find((x) => x.id === want) || p[0];
      };
      const amAsset = (pool, addr) => pool.assets.find((a) => a.address.toLowerCase() === String(addr).toLowerCase());

      window.renderAmm = function renderAmm() {
        const pools = amPools();
        const sel = $("amPool");
        if (!sel) return;
        const sig = pools.map((p) => `${p.id}:${p.name}:${p.frozen}`).join("|");
        if (sel.dataset.sig !== sig) {
          const keep = sel.value;
          sel.innerHTML = pools
            .map((p) => `<option value="${p.id}">${esc(p.name)}${p.frozen ? " (frozen)" : ""}</option>`)
            .join("");
          if (keep && pools.some((p) => String(p.id) === keep)) sel.value = keep;
          sel.dataset.sig = sig;
          sel.dataset.pool = ""; // force the per-pool controls to rebuild
        }
        const raw = amSelected();
        if (!raw) {
          $("amPoolMeta").textContent = "No liquidity pools yet.";
          return;
        }
        const p = amMine(raw);
        const lpPct = (p.lpShareBps / 100).toFixed(0);
        $("amPoolMeta").innerHTML =
          `${esc((p.swapFeeBps / 100).toFixed(2))}% swap fee · providers keep ${esc(lpPct)}% of it` +
          (p.frozen ? ' · <b style="color:var(--warn)">frozen — withdrawals still open</b>' : "");

        $("amReserves").innerHTML = p.assets
          .map((a) => `<div class="metric"><div class="k">${esc(a.symbol)}</div><div class="v">${esc(a.balance)}</div></div>`)
          .join("");
        $("amPosition").innerHTML =
          `<div class="metric"><div class="k">Pool share</div><div class="v">${esc(p.mySharePct)}%</div></div>` +
          p.assets
            .map((a) => `<div class="metric"><div class="k">${esc(a.symbol)}</div><div class="v">${esc(a.myBalance)}</div></div>`)
            .join("");

        // Per-pool controls: asset pickers and one amount box per asset.
        if (sel.dataset.pool !== String(p.id)) {
          sel.dataset.pool = String(p.id);
          const opts = p.assets
            .map((a) => `<option value="${esc(a.address)}" data-sym="${esc(a.symbol)}" data-dec="${Number(a.decimals) || 6}">${esc(a.symbol)}</option>`)
            .join("");
          $("amSwapIn").innerHTML = opts;
          $("amSwapOut").innerHTML = opts;
          if (p.assets.length > 1) $("amSwapOut").selectedIndex = 1;
          $("amSwapQuote").textContent = "";
          $("amSwapAmount").value = "";
          renderAmLpInputs();
        }
        renderAmLpHint();
      };

      /** Add mode needs one amount per asset; remove mode needs a share count. */
      function renderAmLpInputs() {
        const p = amSelected();
        const host = $("amLpInputs");
        if (!p || !host) return;
        if ($("amLpAction").value === "add") {
          host.innerHTML = p.assets
            .map(
              (a) =>
                `<input class="field amLpAmt" data-addr="${esc(a.address)}" data-dec="${Number(a.decimals) || 6}" ` +
                `inputmode="decimal" placeholder="${esc(a.symbol)}" style="width:110px" />`,
            )
            .join("");
        } else {
          host.innerHTML =
            `<input id="amLpShares" class="field" inputmode="decimal" placeholder="Shares to burn" style="width:170px" />`;
        }
      }

      function renderAmLpHint() {
        const raw = amSelected();
        const el = $("amLpHint");
        if (!raw || !el) return;
        const p = amMine(raw);
        if ($("amLpAction").value === "add") {
          el.textContent = p.frozen
            ? "This pool is frozen — deposits are paused, but you can still withdraw."
            : "Deposit every asset in proportion. Shares are minted at the smallest ratio you supply, so an" +
              " unbalanced deposit donates the excess rather than buying extra shares — match the pool's ratio.";
        } else {
          el.textContent = `You hold ${p.myShares} shares (${p.mySharePct}% of the pool). Withdrawing returns a proportional slice of every asset, and stays available even while frozen.`;
        }
      }

      if ($("amPool")) {
        $("amPool").addEventListener("change", () => {
          const sel = $("amPool");
          sel.dataset.pool = ""; // rebuild the per-pool controls for the new pool
          renderAmm();
        });
        $("amLpAction").addEventListener("change", () => { renderAmLpInputs(); renderAmLpHint(); });
        $("amSwapIn").addEventListener("change", () => scheduleAmQuote());
        $("amSwapOut").addEventListener("change", () => scheduleAmQuote());
        $("amSwapAmount").addEventListener("input", () => scheduleAmQuote());

        /* Auto-quote as the amount changes. AMM prices move with every trade, so
         * a quote left on screen goes stale quickly; it is also re-fetched
         * immediately before executing. */
        let amQuoteTimer = null;
        function scheduleAmQuote() {
          clearTimeout(amQuoteTimer);
          const v = $("amSwapAmount").value.trim();
          if (!v || Number(v) <= 0) { $("amSwapQuote").textContent = ""; return; }
          $("amSwapQuote").textContent = "Quoting…";
          amQuoteTimer = setTimeout(() => { ammQuote().catch(() => {}); }, 350);
        }
        setInterval(() => {
          if (!$("ammCard") || $("paneDefi").hidden) return;
          const v = $("amSwapAmount").value.trim();
          if (v && Number(v) > 0) ammQuote().catch(() => {});
        }, 15000);

        async function ammQuote() {
          const p = amSelected();
          if (!p) return null;
          const tokenIn = $("amSwapIn").value, tokenOut = $("amSwapOut").value;
          const ai = amAsset(p, tokenIn), ao = amAsset(p, tokenOut);
          const human = $("amSwapAmount").value.trim();
          if (!ai || !ao || !human || Number(human) <= 0) return null;
          if (tokenIn === tokenOut) { $("amSwapQuote").textContent = "Pick two different assets."; return null; }
          const amountIn = toRaw(human, ai.decimals);
          const r = await (
            await fetch(`/api/amm/quote?poolId=${p.id}&tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`)
          ).json();
          if (!r.ok) { $("amSwapQuote").textContent = "Quote failed: " + r.error; return null; }
          const out = fmtUnitsJs(r.out, ao.decimals);
          const lpFee = fmtUnitsJs(r.lpFee, ai.decimals);
          const appFee = fmtUnitsJs(r.appFee, ai.decimals);
          const eff = Number(out) > 0 && Number(human) > 0 ? Number(out) / Number(human) : 0;
          // Impact comes from the server, measured against the same reserves the
          // contract quotes from. Computing it here off display strings was how
          // a trade that returns almost nothing could still look reasonable.
          const imp = r.impact || { impactPct: 0, severity: "fine", reason: "", reserveUsedPct: 0 };
          const colour = imp.severity === "severe" ? "var(--bad, #dc2626)"
            : imp.severity === "warn" ? "var(--warn)" : "var(--muted)";
          const suggestion = r.suggestedAmountIn && BigInt(r.suggestedAmountIn) > 0n
            ? ` <button class="btn" id="amUseSafe" data-raw="${esc(r.suggestedAmountIn)}" style="padding:2px 8px;font-size:11px">Use ${esc(fmtUnitsJs(r.suggestedAmountIn, ai.decimals))} instead</button>`
            : "";
          $("amSwapQuote").innerHTML =
            `You pay <b>${esc(human)} ${esc(ai.symbol)}</b> → you receive <b>${esc(out)} ${esc(ao.symbol)}</b><br>` +
            `<span style="font-weight:400;color:var(--muted)">effective rate 1 ${esc(ai.symbol)} = ` +
            `${eff ? eff.toPrecision(6) : "—"} ${esc(ao.symbol)} · ` +
            `<span style="color:${colour};font-weight:${imp.severity === "fine" ? 400 : 600}">price impact ${esc(imp.impactPct.toFixed(2))}%</span> · ` +
            `fee ${esc(lpFee)} to providers + ${esc(appFee)} to the app · 1% max slippage</span>` +
            (imp.reason
              ? `<div style="margin-top:8px;font-weight:400;font-size:12px;color:${colour}">${esc(imp.reason)}${suggestion}</div>`
              : "");

          const useSafe = $("amUseSafe");
          if (useSafe) {
            useSafe.addEventListener("click", () => {
              $("amSwapAmount").value = fmtUnitsJs(useSafe.dataset.raw, ai.decimals);
              ammQuote();
            });
          }
          return { poolId: p.id, tokenIn, tokenOut, amountIn, out: r.out, ai, ao, impact: imp };
        }

        /**
         * One-time override per exact trade. Keyed on the pool, pair and size so
         * editing any of them re-arms the guard — an acknowledgement of a 40%
         * impact must not silently carry over to a different order.
         */
        const amImpactAck = new Set();
        const amAckKey = (q) => `${q.poolId}:${q.tokenIn}:${q.tokenOut}:${q.amountIn}`;

        /**
         * Max on the AMM: your whole balance of the input asset.
         *
         * Deliberately does *not* cap at the impact threshold — you asked for
         * your maximum, and the quote will tell you what it costs and refuse to
         * execute if it is severe. Silently shrinking the number would be the
         * form lying about what it filled in.
         */
        if ($("amMax")) {
          $("amMax").addEventListener("click", async () => {
            const p = amSelected();
            if (!p) return;
            const tokenIn = $("amSwapIn").value;
            const ai = amAsset(p, tokenIn);
            // In self-custody the user's own wallet pays, so its balance is the
            // ceiling. Otherwise fall back to the pool-share figure the operator
            // path spends from. `myBalance` is a share of the pool, not a wallet
            // balance — using it in self-custody mode would offer to trade money
            // the signer doesn't have.
            const wallet = await amWalletBalances(p).catch(() => null);
            const idx = p.assets.findIndex((a) => a.address === tokenIn);
            const bal = wallet && idx >= 0 ? wallet[idx] : ai && ai.myBalance;
            if (bal == null || !(parseFloat(bal) > 0)) {
              $("amSwapQuote").textContent = `No ${ai ? ai.symbol : "input"} balance to trade.`;
              return;
            }
            $("amSwapAmount").value = String(bal);
            ammQuote();
          });
        }

        $("amSwapExec").addEventListener("click", async () => {
          const msg = $("ammMsg");
          const q = await ammQuote();
          if (!q) {
            msg.style.display = "block"; msg.style.color = "var(--warn)";
            msg.textContent = "Enter an amount and pick two different assets first.";
            return;
          }
          // Refuse a trade the pool is too shallow to fill sensibly. This is the
          // "I swapped and received nothing" case: constant-product working
          // exactly as designed against reserves far smaller than the order.
          if (q.impact && q.impact.severity === "severe" && !amImpactAck.has(amAckKey(q))) {
            amImpactAck.add(amAckKey(q));
            msg.style.display = "block";
            msg.style.color = "var(--warn)";
            msg.textContent =
              `Blocked: ${q.impact.reason} Press Swap again to go ahead anyway at this price.`;
            return;
          }
          const minOut = ((BigInt(q.out) * 99n) / 100n).toString();
          const btn = $("amSwapExec");
          if (selfMode()) {
            btn.disabled = true;
            await selfCustody("ammMsg", `swap ${q.ai.symbol} → ${q.ao.symbol}`, async (from, cfg) => {
              await ensureAllowance(from, q.tokenIn, cfg.amm, q.amountIn);
              return sendTx(
                from,
                cfg.amm,
                callData(
                  cfg.selectors.ammSwap,
                  encUint(q.poolId), encAddr(q.tokenIn), encAddr(q.tokenOut), encUint(q.amountIn), encUint(minOut),
                ),
              );
            });
            btn.disabled = false;
            return;
          }
          btn.disabled = true;
          try {
            const r = await (
              await postJson("/api/amm/swap", {
                poolId: q.poolId, tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, minOut,
              })
            ).json();
            msg.style.display = "block";
            msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
            msg.textContent = r.ok ? `swapped ✓ — tx ${String(r.txHash).slice(0, 12)}…` : `failed: ${r.error}`;
          } catch {
            msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = "request failed";
          } finally { btn.disabled = false; afterTx(); }
        });

        // "Max" fills the boxes: for a withdrawal, every share you hold; for a
        // deposit, the largest balanced deposit your wallet can actually cover.
        $("amLpMax").addEventListener("click", async () => {
          const raw = amSelected();
          if (!raw) return;
          const p = amMine(raw);
          if ($("amLpAction").value === "remove") {
            const el = $("amLpShares");
            if (el) el.value = p.myShares;
            return;
          }
          const boxes = [...document.querySelectorAll(".amLpAmt")];
          const balances = await amWalletBalances(p);
          if (!balances) return;
          // Largest scale factor the wallet can fund across every asset.
          let scale = Infinity;
          p.assets.forEach((a, i) => {
            const pool = Number(a.balance), have = Number(balances[i]);
            if (pool > 0) scale = Math.min(scale, have / pool);
          });
          if (!isFinite(scale) || scale <= 0) return;
          p.assets.forEach((a, i) => {
            const want = Number(a.balance) * scale;
            if (boxes[i]) boxes[i].value = want > 0 ? want.toFixed(Number(a.decimals) || 6).replace(/0+$/, "").replace(/\.$/, "") : "";
          });
        });

        /** The connected wallet's balance of each pool asset (self-custody only). */
        async function amWalletBalances(p) {
          if (!selfMode() || !eth()) return null;
          try {
            const cfg = await loadDefiConfig();
            const [from] = await eth().request({ method: "eth_accounts" });
            if (!from) return null;
            return Promise.all(
              p.assets.map(async (a) =>
                decStr(await ethCall(a.address, callData(cfg.selectors.balanceOf, encAddr(from))), a.decimals),
              ),
            );
          } catch { return null; }
        }

        $("amLpExec").addEventListener("click", async () => {
          const raw = amSelected();
          const msg = $("ammMsg");
          if (!raw) return;
          const p = amMine(raw);
          const adding = $("amLpAction").value === "add";
          const btn = $("amLpExec");

          let amounts = [], shares = "0";
          if (adding) {
            const boxes = [...document.querySelectorAll(".amLpAmt")];
            amounts = p.assets.map((a, i) => {
              const v = (boxes[i] && boxes[i].value.trim()) || "";
              return v && Number(v) > 0 ? toRaw(v, a.decimals) : "0";
            });
            if (amounts.some((v) => v === "0")) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent = "Enter an amount for every asset in the pool.";
              return;
            }
          } else {
            shares = (($("amLpShares") && $("amLpShares").value.trim()) || "").replace(/[^\d]/g, "");
            if (!shares || BigInt(shares) <= 0n) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent = "Enter how many shares to withdraw.";
              return;
            }
            if (BigInt(shares) > BigInt(p.myShares || "0")) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent = `You hold ${p.myShares} shares — enter that or less.`;
              return;
            }
          }

          if (selfMode()) {
            btn.disabled = true;
            await selfCustody("ammMsg", adding ? "add liquidity" : "withdraw liquidity", async (from, cfg) => {
              if (adding) {
                for (let i = 0; i < p.assets.length; i++) {
                  await ensureAllowance(from, p.assets[i].address, cfg.amm, amounts[i]);
                }
                return sendTx(
                  from, cfg.amm,
                  // addLiquidity(uint256,uint256[],uint256): the dynamic array
                  // sits in the tail, so the head carries an offset to it.
                  callData(cfg.selectors.ammAdd, encUint(p.id), encUint(96), encUint(0), encArray(amounts)),
                );
              }
              return sendTx(
                from, cfg.amm,
                // removeLiquidity(uint256,uint256,uint256[]) — zero minimums; the
                // payout is proportional by construction, so there is nothing to
                // front-run here.
                callData(cfg.selectors.ammRemove, encUint(p.id), encUint(shares), encUint(96), encArray(p.assets.map(() => "0"))),
              );
            });
            btn.disabled = false;
            return;
          }

          btn.disabled = true;
          try {
            const body = adding ? { poolId: p.id, amounts } : { poolId: p.id, shares };
            const r = await (await postJson(`/api/amm/${adding ? "add" : "remove"}`, body)).json();
            msg.style.display = "block";
            msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
            msg.textContent = r.ok
              ? `${adding ? "added" : "withdrew"} liquidity ✓ — tx ${String(r.txHash).slice(0, 12)}…`
              : `failed: ${r.error}`;
          } catch {
            msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = "request failed";
          } finally { btn.disabled = false; afterTx(); }
        });
      }

      /* ===================================================================
       * Self-custody mode — the user's own wallet, the user's own funds.
       *
       * Server-side actions spend the *agent's* wallet and are operator-only.
       * This path is different: we build calldata in the browser, the connected
       * wallet signs it, and the transaction moves the **user's** tokens. The
       * server never sees a key and isn't in the trust path at all.
       *
       * Calldata is assembled by hand (selector + 32-byte-padded static args)
       * so no ABI library is needed — that keeps the CSP at script-src 'self'.
       * =================================================================== */
      let defiCfg = null;
      async function loadDefiConfig() {
        if (defiCfg) return defiCfg;
        defiCfg = await (await fetch("/api/defi/config")).json();
        return defiCfg;
      }
      const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      const encAddr = (a) => pad32(a);
      const encUint = (v) => pad32(BigInt(v).toString(16));
      const callData = (selector, ...parts) => selector + parts.join("");
      /**
       * Tail encoding for a `uint256[]` argument: length word followed by the
       * elements. The matching head word is the byte offset to this tail, which
       * the caller supplies with `encUint(...)` — for a three-word head that is
       * 96, for a two-word head 64.
       */
      const encArray = (values) => encUint(values.length) + values.map(encUint).join("");

      async function selfAccount() {
        if (!eth()) throw new Error("No browser wallet detected.");
        const [a] = await eth().request({ method: "eth_requestAccounts" });
        const cfg = await loadDefiConfig();
        // Make sure the wallet is on Arc, offering to add the network if unknown.
        const want = "0x" + Number(cfg.chainId).toString(16);
        const have = await eth().request({ method: "eth_chainId" });
        if (have !== want) {
          try {
            await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
          } catch (e) {
            if (e && (e.code === 4902 || String(e.message || "").includes("Unrecognized"))) {
              await eth().request({
                method: "wallet_addEthereumChain",
                params: [{
                  chainId: want,
                  chainName: cfg.chainName,
                  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
                  rpcUrls: [cfg.rpcUrl],
                  blockExplorerUrls: [cfg.explorer],
                }],
              });
            } else throw e;
          }
        }
        return a;
      }

      async function ethCall(to, data) {
        return eth().request({ method: "eth_call", params: [{ to, data }, "latest"] });
      }
      async function sendTx(from, to, data) {
        return eth().request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
      }
      // Ensure `spender` may move `amount` of `token` on the user's behalf.
      async function ensureAllowance(from, token, spender, amount) {
        const cfg = await loadDefiConfig();
        const cur = await ethCall(token, callData(cfg.selectors.allowance, encAddr(from), encAddr(spender)));
        if (BigInt(cur || "0x0") >= BigInt(amount)) return null;
        const max = "f".repeat(64);
        return sendTx(from, token, cfg.selectors.approve + encAddr(spender) + max);
      }

      /** Run a self-custody action, reporting progress into `msgEl`. */
      async function selfCustody(msgEl, label, fn) {
        const msg = $(msgEl);
        msg.style.display = "block";
        msg.style.color = "var(--muted)";
        msg.textContent = "Confirm in your wallet…";
        try {
          const from = await selfAccount();
          const hash = await fn(from, await loadDefiConfig());
          const cfg = await loadDefiConfig();
          msg.style.color = "var(--good)";
          // `hash` comes from the wallet provider, so treat it as untrusted:
          // accept only a 0x-hex tx hash, and escape everything interpolated.
          const safeHash = /^0x[0-9a-fA-F]{64}$/.test(String(hash)) ? String(hash) : "";
          msg.innerHTML = safeHash
            ? `${esc(label)} sent from your wallet ✓ — ` +
              `<a href="${esc(cfg.explorer)}/tx/${esc(safeHash)}" target="_blank" rel="noopener">` +
              `${esc(safeHash.slice(0, 12))}…</a>`
            : `${esc(label)} sent from your wallet ✓`;
        } catch (e) {
          msg.style.color = "var(--warn)";
          msg.textContent = walletError(e);
        } finally {
          afterTx();
        }
      }
      // Plain-language wallet/chain errors (mirrors the server's friendlyError).
      function walletError(e) {
        const raw = String((e && (e.data && e.data.message)) || (e && e.message) || e);
        const s = raw.toLowerCase();
        if (e && (e.code === 4001 || s.includes("user rejected") || s.includes("user denied"))) return "You cancelled it in your wallet.";
        if (s.includes("no browser wallet")) return "No browser wallet detected — install or enable one, then reconnect.";
        if (s.includes("insufficient funds") || s.includes("gas")) return "Not enough USDC in your wallet to cover network fees.";
        if (s.includes("noroute") || s.includes("no route")) return "No pool can fill that size right now. Try less, or add liquidity for the pair.";
        if (s.includes("slippage")) return "Price moved — get a fresh quote and retry.";
        if (s.includes("pool illiquid") || s.includes("insufficientliquidity")) return "Not enough free liquidity for that amount right now.";
        if (s.includes("unhealthy")) return "That would exceed your safe collateral limit.";
        if (s.includes("balance")) return "Not enough balance for that amount.";
        if (s.includes("request limit") || s.includes("rate limit") || s.includes("429")) return "Network is rate-limiting — wait a few seconds and retry.";
        return "Transaction failed. " + raw.split("\n")[0].slice(0, 110);
      }

      /**
       * Read the *connected user's* own positions straight from the chain via
       * their wallet, so self-custody mode shows their balances rather than the
       * agent's. Cheap eth_calls through the injected provider — no server
       * involvement, and it silently no-ops when no wallet is connected.
       */
      const decStr = (raw, dec) => fmtUnitsJs(BigInt(raw || "0x0").toString(), dec);
      async function refreshMyPositions() {
        if (!selfMode() || !eth()) { clearMine(); return; }
        let from;
        try {
          const accts = await eth().request({ method: "eth_accounts" });
          from = accts && accts[0];
        } catch { return; }
        if (!from) { clearMine(); return; }
        let cfg;
        try { cfg = await loadDefiConfig(); } catch { return; }
        const sel = cfg.selectors;

        // Vault: my redeemable balance + my wallet's USDC.
        if (cfg.vault) {
          try {
            const [mine, wal] = await Promise.all([
              ethCall(cfg.vault, callData(sel.balanceOfAssets, encAddr(from))),
              ethCall(cfg.vaultAsset, callData(sel.balanceOf, encAddr(from))),
            ]);
            setMine("vYours", decStr(mine, 6) + " USDC");
            setMine("vWallet", decStr(wal, 6) + " USDC");
          } catch {}
        }
        // Lending: my position in the asset currently selected.
        const a = selectedLendingAsset();
        if (cfg.pool && a) {
          try {
            const [sup, bor, wal] = await Promise.all([
              ethCall(cfg.pool, callData(sel.supplyBalance, encAddr(a.address), encAddr(from))),
              ethCall(cfg.pool, callData(sel.borrowBalance, encAddr(a.address), encAddr(from))),
              ethCall(a.address, callData(sel.balanceOf, encAddr(from))),
            ]);
            setMine("lnAssetSupplied", decStr(sup, a.decimals) + " " + a.symbol);
            setMine("lnAssetBorrowed", decStr(bor, a.decimals) + " " + a.symbol);
            setMine("lnWallet", decStr(wal, a.decimals) + " " + a.symbol);
          } catch {}
        }
        // Swap: my balance of the input asset.
        const sw = swapSelected();
        if (sw) {
          try {
            const wal = await ethCall(sw.tokenIn, callData(sel.balanceOf, encAddr(from)));
            window.__myTokenIn = decStr(wal, sw.decIn);
            renderSwapBalances();
          } catch {}
        }
        // AMM: my LP shares in the selected pool. The server snapshot reports the
        // *agent's* position, which would be plainly wrong to show a connected
        // user. Kept in a side map rather than written into the snapshot, so the
        // next poll can't flip the panel back to the agent's numbers.
        const ap = amSelected();
        if (cfg.amm && ap) {
          try {
            const raw = await ethCall(cfg.amm, callData(sel.ammShares, encUint(ap.id), encAddr(from)));
            window.__myAmmShares[ap.id] = BigInt(raw || "0x0").toString();
            renderAmm();
          } catch {}
        }
      }
      // Mark a field as "yours" so the agent-state render doesn't overwrite it.
      function setMine(id, text) {
        const el = $(id);
        if (!el) return;
        el.dataset.mine = "1";
        el.textContent = text;
        el.title = "Your wallet's position";
      }
      function clearMine() {
        document.querySelectorAll("[data-mine]").forEach((el) => { delete el.dataset.mine; el.title = ""; });
        window.__myTokenIn = null;
      }

      // Toggle: "My wallet" (self-custody) vs "Agent wallet" (operator).
      // Self-custody needs an injected wallet. On a browser without one (common
      // on mobile) leaving it on would make every action fail with "no wallet
      // detected", so we turn it off, lock it, and explain — actions then route
      // through the operator path, which is what a signed-in admin expects.
      const hasInjectedWallet = () => !!eth();
      const selfMode = () => {
        const t = $("selfCustodyToggle");
        return !!(t && t.checked && hasInjectedWallet());
      };
      (function reflectWalletAvailability() {
        const t = $("selfCustodyToggle");
        if (!t || hasInjectedWallet()) return;
        t.checked = false;
        t.disabled = true;
        t.title = "No browser wallet detected";
        const note = $("custodyNote");
        if (note) {
          note.textContent =
            "No browser wallet detected, so self-custody is unavailable here. Actions use the app's " +
            "agent wallet and need an operator (Admin) sign-in. Open this page in a wallet browser, " +
            "or install a wallet extension, to transact with your own funds.";
        }
      })();
      if ($("selfCustodyToggle")) {
        $("selfCustodyToggle").addEventListener("change", () => {
          const on = selfMode();
          if (!on) clearMine(); else refreshMyPositions().catch(() => {});
          $("custodyNote").textContent = on
            ? "Self-custody: your wallet signs and your own funds move. No sign-in needed. " +
              "(Position figures below track the app's agent wallet; your own balances live in your wallet.)"
            : "Agent wallet: actions spend the app's agent funds and require an operator (Admin) sign-in.";
          tick();
        });
      }

      /* ---- Floating scroll controls ------------------------------------- */
      (function scrollDock() {
        const up = $("toTop"), down = $("toBottom");
        if (!up || !down) return;
        const sync = () => {
          const y = window.scrollY;
          const max = document.documentElement.scrollHeight - window.innerHeight;
          // Hide the direction you're already at; keep the other always available.
          up.hidden = y < 120;
          down.hidden = max - y < 120;
        };
        up.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
        down.addEventListener("click", () =>
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
        window.addEventListener("scroll", sync, { passive: true });
        window.addEventListener("resize", sync);
        sync();
      })();

      /* ---- Dropdown menus (profile, App Config) -------------------------- */
      function bindMenu(btnId, panelId) {
        const btn = $(btnId), panel = $(panelId);
        if (!btn || !panel) return null;
        const close = () => { panel.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const open = panel.classList.toggle("open");
          btn.setAttribute("aria-expanded", open ? "true" : "false");
          // Only one menu open at a time.
          document.querySelectorAll(".menuPanel.open").forEach((p) => { if (p !== panel) p.classList.remove("open"); });
        });
        panel.addEventListener("click", (e) => e.stopPropagation());
        document.addEventListener("click", close);
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
        return { close };
      }
      const profileMenu = bindMenu("profileBtn", "profileMenu");
      /* App Config opens as a large scrollable dialog rather than a dropdown —
       * it has far too many controls for a menu panel now. */
      function openCfg() {
        $("cfgModal").hidden = false;
        $("cfgBtn").setAttribute("aria-expanded", "true");
        loadAppConfig();
        renderCfgAmm();
        renderCfgLending();
        loadCfgHistory();
        loadCfgNotices();
        syncCfgDock();
      }

      /* ---- lending-reserve administration --------------------------------- */
      function cfgLnMsg(text, good) {
        const row = $("cfgLnMsg");
        if (!row) return;
        row.style.display = "flex";
        row.style.color = good ? "var(--good)" : "var(--warn)";
        row.lastElementChild.textContent = text;
      }
      const cfgLnAssets = () => (window.__lending && window.__lending.assets) || [];
      function renderCfgLending() {
        const sel = $("cfgLnAsset");
        if (!sel) return;
        const assets = cfgLnAssets();
        const sig = assets.map((a) => `${a.address}:${a.symbol}:${a.frozen}:${a.hidden}`).join("|");
        if (sel.dataset.sig !== sig) {
          const keep = sel.value;
          sel.innerHTML = assets
            .map(
              (a) =>
                `<option value="${esc(a.address)}">${esc(a.symbol)}` +
                `${a.hidden ? " · hidden" : ""}${a.frozen ? " · frozen" : ""}</option>`,
            )
            .join("");
          if (keep && assets.some((a) => a.address === keep)) sel.value = keep;
          sel.dataset.sig = sig;
        }
        syncFreezeBoxes();
      }
      /** Reflect the selected reserve's current freeze mask in the checkboxes. */
      function syncFreezeBoxes() {
        const a = cfgLnAssets().find((x) => x.address === $("cfgLnAsset").value);
        const mask = a ? Number(a.frozen || 0) : 0;
        $("cfgFrSupply").checked = !!(mask & 1);
        $("cfgFrWithdraw").checked = !!(mask & 2);
        $("cfgFrBorrow").checked = !!(mask & 4);
        $("cfgFrRepay").checked = !!(mask & 8);
      }

      if ($("cfgLnAsset")) {
        $("cfgLnAsset").addEventListener("change", syncFreezeBoxes);

        const freeze = async (actions) => {
          const asset = $("cfgLnAsset").value;
          if (!asset) { cfgLnMsg("Pick a reserve first.", false); return; }
          cfgLnMsg("Sending…", true);
          try {
            const r = await (await postJson("/api/lending/admin/freeze", { asset, actions })).json();
            cfgLnMsg(
              r.ok
                ? actions.length
                  ? `Frozen: ${actions.join(", ")} ✓`
                  : "All actions unfrozen ✓"
                : r.error,
              !!r.ok,
            );
            if (r.ok) afterTx();
          } catch { cfgLnMsg("Request failed.", false); }
        };
        $("cfgLnFreeze").addEventListener("click", () => {
          const picked = [];
          if ($("cfgFrSupply").checked) picked.push("supply");
          if ($("cfgFrWithdraw").checked) picked.push("withdraw");
          if ($("cfgFrBorrow").checked) picked.push("borrow");
          if ($("cfgFrRepay").checked) picked.push("repay");
          freeze(picked);
        });
        $("cfgLnUnfreeze").addEventListener("click", () => freeze([]));
        $("cfgLnFreezeAll").addEventListener("click", () => {
          if (!confirm("Freeze supply, withdraw, borrow and repay on this reserve?\n\nLiquidation stays available so bad debt can still be cleared.")) return;
          freeze(["supply", "withdraw", "borrow", "repay"]);
        });

        $("cfgLnRename").addEventListener("click", async () => {
          const asset = $("cfgLnAsset").value;
          const cur = cfgLnAssets().find((a) => a.address === asset);
          const name = prompt("Display name for this reserve (blank restores the token symbol):", cur ? cur.symbol : "");
          if (name === null) return;
          cfgLnMsg("Sending…", true);
          try {
            const r = await (await postJson("/api/lending/admin/rename", { asset, name: name.trim() })).json();
            cfgLnMsg(r.ok ? "Renamed ✓" : r.error, !!r.ok);
            if (r.ok) afterTx();
          } catch { cfgLnMsg("Request failed.", false); }
        });

        const visibility = async (hidden) => {
          cfgLnMsg("Sending…", true);
          try {
            const r = await (
              await postJson("/api/lending/admin/visibility", { asset: $("cfgLnAsset").value, hidden })
            ).json();
            cfgLnMsg(
              r.ok
                ? hidden
                  ? "Hidden from the asset list ✓ — existing positions are unaffected"
                  : "Visible again ✓"
                : r.error,
              !!r.ok,
            );
            if (r.ok) afterTx();
          } catch { cfgLnMsg("Request failed.", false); }
        };
        $("cfgLnHide").addEventListener("click", () => visibility(true));
        $("cfgLnShow").addEventListener("click", () => visibility(false));

        const oracle = async (feed) => {
          cfgLnMsg("Sending…", true);
          try {
            const r = await (
              await postJson("/api/lending/admin/oracle", {
                asset: $("cfgLnAsset").value,
                feed,
                staleAfter: Number($("cfgOracleStale").value || 3600),
              })
            ).json();
            cfgLnMsg(r.ok ? (feed ? "Feed wired ✓" : "Feed cleared — back to the manual price ✓") : r.error, !!r.ok);
            if (r.ok) afterTx();
          } catch { cfgLnMsg("Request failed.", false); }
        };
        $("cfgOracleSet").addEventListener("click", () => {
          const feed = $("cfgOracleFeed").value.trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(feed)) { cfgLnMsg("Enter a valid contract address.", false); return; }
          oracle(feed);
        });
        $("cfgOracleClear").addEventListener("click", () => oracle(""));
      }

      /* ---- contract history & fund recovery --------------------------------
       * Every destructive action confirms first and names what it will touch:
       * these operations move real money to real people, and an accidental
       * "Return funds" on the wrong record is not something you can take back. */
      let historyState = { records: [], current: {} };
      function cfgHiMsg(text, good) {
        const row = $("cfgHiMsg");
        if (!row) return;
        row.style.display = "flex";
        row.style.color = good ? "var(--good)" : "var(--warn)";
        row.lastElementChild.textContent = text;
      }
      const cfgHiPicked = () => [...document.querySelectorAll(".cfgHiPick:checked")].map((c) => c.value);
      const cfgHiOne = () => {
        const ids = cfgHiPicked();
        if (ids.length !== 1) { cfgHiMsg("Tick exactly one record for this.", false); return null; }
        return historyState.records.find((r) => r.id === ids[0]) || null;
      };
      const shortAddr = (a) => String(a).slice(0, 8) + "…" + String(a).slice(-4);

      async function loadCfgHistory() {
        const host = $("cfgHiList");
        if (!host) return;
        try {
          const r = await (await fetch("/api/history", { headers: authHeaders() })).json();
          if (!r.ok) { host.innerHTML = `<span style="color:var(--warn)">${esc(r.error || "Couldn't load history.")}</span>`; return; }
          historyState = r;
          host.innerHTML = r.records.length
            ? r.records
                .map((rec) => {
                  const totals = Object.entries(rec.totals || {})
                    .map(([asset, raw]) => {
                      const a = (rec.assets || []).find((x) => x.address === asset);
                      return `${esc(fmtUnitsJs(raw, (a && a.decimals) || 6))} ${esc((a && a.symbol) || shortAddr(asset))}`;
                    })
                    .join(" · ");
                  return (
                    `<label style="display:flex;gap:8px;align-items:flex-start">` +
                    `<input type="checkbox" class="cfgHiPick" value="${esc(rec.id)}" style="margin-top:3px" />` +
                    `<span><b>${esc(rec.label)}</b> <span style="opacity:.7">(${esc(rec.kind)})</span>` +
                    `${rec.active ? ' <span style="color:var(--accent)">· current</span>' : ""}` +
                    `${rec.stale ? ' <span style="color:var(--warn)">· snapshot is stale</span>' : ""}` +
                    `<span style="display:block;color:var(--muted);font-size:11px">${esc(shortAddr(rec.address))} · ` +
                    `${rec.outstandingCount} of ${rec.holderCount} holders outstanding` +
                    `${totals ? ` · owed ${totals}` : ""}</span>` +
                    `${rec.note ? `<span style="display:block;color:var(--muted);font-size:11px">${esc(rec.note)}</span>` : ""}` +
                    `</span></label>`
                  );
                })
                .join("")
            : `<span style="color:var(--muted)">No archived contracts yet.</span>`;
        } catch {
          host.innerHTML = `<span style="color:var(--warn)">Couldn't load history.</span>`;
        }
      }

      if ($("cfgHiArchive")) {
        $("cfgHiUseCurrent").addEventListener("click", () => {
          const addr = (historyState.current || {})[$("cfgHiKind").value];
          if (!addr) { cfgHiMsg("Nothing of that kind is deployed right now.", false); return; }
          $("cfgHiAddress").value = addr;
        });
        $("cfgHiArchive").addEventListener("click", async () => {
          const address = $("cfgHiAddress").value.trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { cfgHiMsg("Enter the contract address.", false); return; }
          cfgHiMsg("Scanning the contract for holders — this reads event logs, so give it a moment…", true);
          try {
            const r = await (
              await postJson("/api/history/archive", {
                kind: $("cfgHiKind").value,
                address,
                label: $("cfgHiLabel").value.trim(),
              })
            ).json();
            cfgHiMsg(
              r.ok
                ? r.partial
                  ? `Archived, but the log scan was incomplete — some holders may be missing. Re-read before paying out.`
                  : `Archived ✓ — ${r.record.holderCount} holder(s) found`
                : r.error,
              !!r.ok && !r.partial,
            );
            if (r.ok) { $("cfgHiAddress").value = ""; $("cfgHiLabel").value = ""; loadCfgHistory(); }
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiRefresh").addEventListener("click", async () => {
          const rec = cfgHiOne();
          if (!rec) return;
          cfgHiMsg("Re-reading balances from chain…", true);
          try {
            const r = await (await postJson(`/api/history/${rec.id}/refresh`, {})).json();
            cfgHiMsg(r.ok ? `Refreshed ✓ — ${r.record.outstandingCount} holder(s) outstanding` : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiActivate").addEventListener("click", async () => {
          const rec = cfgHiOne();
          if (!rec) return;
          try {
            const r = await (await postJson(`/api/history/${rec.id}/activate`, {})).json();
            cfgHiMsg(r.ok ? r.note : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiReturn").addEventListener("click", async () => {
          const rec = cfgHiOne();
          if (!rec) return;
          if (
            !confirm(
              `Send the app's own funds to every outstanding holder in "${rec.label}"?\n\n` +
                `${rec.outstandingCount} holder(s) will be paid the amount the old contract currently ` +
                `says they hold. Balances are re-read first. This spends real money and cannot be undone.`,
            )
          ) return;
          cfgHiMsg("Re-reading balances, then paying out…", true);
          try {
            const r = await (await postJson(`/api/history/${rec.id}/return`, {})).json();
            if (!r.ok) { cfgHiMsg(r.error, false); return; }
            const failed = (r.sent || []).filter((s) => s.error);
            cfgHiMsg(
              failed.length
                ? `${r.sent.length - failed.length} transfer(s) sent, ${failed.length} failed — re-run to retry the rest.`
                : r.sent.length
                  ? `Returned funds to ${new Set(r.sent.map((s) => s.address)).size} holder(s) ✓`
                  : r.note || "Nothing outstanding.",
              !failed.length,
            );
            loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiMigrate").addEventListener("click", async () => {
          const rec = cfgHiOne();
          if (!rec) return;
          const target = $("cfgHiTarget").value.trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(target)) { cfgHiMsg("Enter the replacement contract's address.", false); return; }
          if (
            !confirm(
              `Re-create ${rec.outstandingCount} holder position(s) from "${rec.label}" in ${shortAddr(target)}?\n\n` +
                `The app pays this in from its own funds. Holders keep their claim on the old contract too — ` +
                `nothing here moves their existing position.`,
            )
          ) return;
          cfgHiMsg("Migrating…", true);
          try {
            const r = await (await postJson(`/api/history/${rec.id}/migrate`, { target })).json();
            if (!r.ok) { cfgHiMsg(r.error, false); return; }
            const failed = (r.moved || []).filter((m) => m.error);
            cfgHiMsg(
              failed.length
                ? `${r.moved.length - failed.length} migrated, ${failed.length} failed — re-run to retry the rest.`
                : r.moved.length
                  ? `Migrated ${r.moved.length} position(s) ✓`
                  : r.note || "Nothing outstanding.",
              !failed.length,
            );
            loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiMerge").addEventListener("click", async () => {
          const ids = cfgHiPicked();
          if (ids.length < 2) { cfgHiMsg("Tick at least two records of the same kind to merge.", false); return; }
          const label = prompt("Name for the merged record:", "Merged records");
          if (label === null) return;
          try {
            const r = await (await postJson("/api/history/merge", { ids, label })).json();
            cfgHiMsg(r.ok ? "Merged ✓" : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiSplit").addEventListener("click", async () => {
          const rec = cfgHiOne();
          if (!rec) return;
          const raw = prompt(
            "Addresses to move into a new record, comma-separated:\n\n" +
              "Balances move whole. To split a partial amount, split the holder out first, then edit the amounts.",
            "",
          );
          if (raw === null) return;
          const addresses = raw.split(/[\s,]+/).filter(Boolean);
          if (!addresses.length) { cfgHiMsg("No addresses given.", false); return; }
          try {
            const r = await (await postJson(`/api/history/${rec.id}/split`, { addresses })).json();
            cfgHiMsg(r.ok ? `Split off ${r.record.holderCount} holder(s) ✓` : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiDelete").addEventListener("click", async () => {
          const ids = cfgHiPicked();
          if (!ids.length) { cfgHiMsg("Tick the records to delete.", false); return; }
          const outstanding = historyState.records
            .filter((r) => ids.includes(r.id))
            .reduce((n, r) => n + r.outstandingCount, 0);
          if (
            !confirm(
              outstanding
                ? `${outstanding} holder(s) across these records have NOT been settled.\n\n` +
                    `Deleting loses the record of who is owed what. Delete anyway?`
                : `Delete ${ids.length} record(s)?`,
            )
          ) return;
          try {
            const r = await (await postJson("/api/history/delete", { ids })).json();
            cfgHiMsg(r.ok ? `Deleted ${r.removed} ✓` : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgDeploy").addEventListener("click", async () => {
          const kind = $("cfgDeployKind").value;
          if (
            !confirm(
              `Deploy a brand-new ${kind}?\n\n` +
                `The current one is archived first so its holders can still be paid out or migrated. ` +
                `The app keeps using the existing ${kind} until you restart it.`,
            )
          ) return;
          cfgHiMsg(`Archiving the current ${kind}, then deploying…`, true);
          try {
            const r = await (await postJson("/api/admin/deploy", { kind })).json();
            cfgHiMsg(r.ok ? r.note : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiDeleteAll").addEventListener("click", async () => {
          if (!confirm("Delete every history record, including any with funds still outstanding?")) return;
          try {
            const r = await (await postJson("/api/history/delete", { all: true })).json();
            cfgHiMsg(r.ok ? `Deleted ${r.removed} ✓` : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });
      }

      /* ---- notice authoring ------------------------------------------------ */
      const NOTICE_UNITS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
      function cfgNoMsg(text, good) {
        const row = $("cfgNoMsg");
        if (!row) return;
        row.style.display = "flex";
        row.style.color = good ? "var(--good)" : "var(--warn)";
        row.lastElementChild.textContent = text;
      }
      async function loadCfgNotices() {
        const host = $("cfgNoList");
        if (!host) return;
        try {
          const r = await (await fetch("/api/notices/all", { headers: authHeaders() })).json();
          const items = (r && r.notices) || [];
          host.innerHTML = items.length
            ? items
                .map(
                  (n) =>
                    `<label style="display:flex;gap:8px;align-items:flex-start">` +
                    `<input type="checkbox" class="cfgNoPick" value="${esc(n.id)}" style="margin-top:3px" />` +
                    `<span><span style="color:${esc(n.color || "var(--text)")}">` +
                    `${n.kind === "alert" ? "⚠️ " : ""}${esc(n.text)}</span>` +
                    `<span style="display:block;color:var(--muted);font-size:11px">` +
                    `${esc(fmtWhen(n.startAt))}` +
                    `${n.repeatSeconds ? ` · repeats every ${esc(String(n.repeatSeconds))}s` : " · once"}` +
                    `${n.enabled ? "" : " · disabled"}</span></span></label>`,
                )
                .join("")
            : `<span style="color:var(--muted)">No notices yet.</span>`;
        } catch {
          host.innerHTML = `<span style="color:var(--warn)">Couldn't load notices.</span>`;
        }
      }

      if ($("cfgNoPublish")) {
        $("cfgNoPublish").addEventListener("click", async () => {
          const text = $("cfgNoText").value.trim();
          if (!text) { cfgNoMsg("Write the message first.", false); return; }
          const dur = Math.max(1, Number($("cfgNoDurEvery").value || 30)) * NOTICE_UNITS[$("cfgNoDurUnit").value];
          const repEvery = Number($("cfgNoRepEvery").value || 0);
          const repeat = repEvery > 0 ? repEvery * NOTICE_UNITS[$("cfgNoRepUnit").value] : 0;
          if (repeat > 0 && repeat <= dur) {
            cfgNoMsg("Repeat interval must be longer than the time it stays on screen.", false);
            return;
          }
          const body = {
            text,
            kind: $("cfgNoKind").value,
            color: $("cfgNoColor").value,
            // datetime-local is local time; Date.parse gives the right epoch ms.
            startAt: $("cfgNoStart").value ? Date.parse($("cfgNoStart").value) : Date.now(),
            durationSeconds: dur,
            repeatSeconds: repeat,
            endAt: $("cfgNoEnd").value ? Date.parse($("cfgNoEnd").value) : 0,
          };
          cfgNoMsg("Publishing…", true);
          try {
            const r = await (await postJson("/api/notices", body)).json();
            cfgNoMsg(r.ok ? "Published ✓" : r.error, !!r.ok);
            if (r.ok) { $("cfgNoText").value = ""; loadCfgNotices(); pollNotices(); }
          } catch { cfgNoMsg("Request failed.", false); }
        });
        $("cfgNoRefresh").addEventListener("click", loadCfgNotices);
        $("cfgNoDeleteSel").addEventListener("click", async () => {
          const ids = [...document.querySelectorAll(".cfgNoPick:checked")].map((c) => c.value);
          if (!ids.length) { cfgNoMsg("Tick the notices to delete.", false); return; }
          try {
            const r = await (await postJson("/api/notices/delete", { ids })).json();
            cfgNoMsg(r.ok ? `Deleted ${r.removed} ✓` : r.error, !!r.ok);
            if (r.ok) { loadCfgNotices(); pollNotices(); }
          } catch { cfgNoMsg("Request failed.", false); }
        });
        $("cfgNoDeleteAll").addEventListener("click", async () => {
          if (!confirm("Delete every notice, including scheduled ones?")) return;
          try {
            const r = await (await postJson("/api/notices/delete", { all: true })).json();
            cfgNoMsg(r.ok ? `Deleted ${r.removed} ✓` : r.error, !!r.ok);
            if (r.ok) { loadCfgNotices(); pollNotices(); }
          } catch { cfgNoMsg("Request failed.", false); }
        });
      }

      /* ---- AMM administration inside App Config ---------------------------
       * Fee retuning is deliberately a separate button from "Save": it is an
       * on-chain, per-pool change, and burying it in the global save would make
       * it far too easy to retune every pool by accident. */
      function cfgAmmMsg(text, good) {
        const row = $("cfgAmmMsg");
        if (!row) return;
        row.style.display = "flex";
        row.style.color = good ? "var(--good)" : "var(--warn)";
        row.lastElementChild.textContent = text;
      }
      function renderCfgAmm() {
        const pools = amPools();
        const sel = $("cfgAmmPools");
        if (!sel) return;
        sel.innerHTML = pools
          .map((p) => `<option value="${p.id}">${esc(p.name)}${p.frozen ? " (frozen)" : ""}</option>`)
          .join("");
        if (pools.length) {
          sel.selectedIndex = 0;
          const p = pools[0];
          $("cfgAmmFee").value = (p.swapFeeBps / 100).toFixed(2);
          $("cfgAmmLpShare").value = String(p.lpShareBps / 100);
        }
        // Candidate assets for a new pool: whatever the lending pool lists.
        const assets = (window.__lending && window.__lending.assets) || [];
        const na = $("cfgAmmNewAssets");
        if (na) {
          na.innerHTML = assets
            .map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`)
            .join("");
        }
      }
      const cfgAmmSelectedIds = () =>
        [...($("cfgAmmPools") ? $("cfgAmmPools").selectedOptions : [])].map((o) => Number(o.value));

      async function cfgAmmConfigure(poolIds) {
        if (!poolIds.length) { cfgAmmMsg("Select at least one pool.", false); return; }
        const lpShareBps = Math.round(+$("cfgAmmLpShare").value * 100);
        if (!(lpShareBps >= 5000)) {
          cfgAmmMsg("Providers always keep at least 50% — the contract rejects less.", false);
          return;
        }
        cfgAmmMsg("Sending…", true);
        try {
          const r = await (
            await postJson("/api/amm/admin/configure", {
              poolIds,
              swapFeeBps: Math.round(+$("cfgAmmFee").value * 100),
              lpShareBps,
            })
          ).json();
          cfgAmmMsg(r.ok ? `Updated ${poolIds.length} pool(s) ✓` : r.error, !!r.ok);
          if (r.ok) afterTx();
        } catch { cfgAmmMsg("Request failed.", false); }
      }

      if ($("cfgAmmApply")) {
        $("cfgAmmApply").addEventListener("click", () => cfgAmmConfigure(cfgAmmSelectedIds()));
        $("cfgAmmApplyAll").addEventListener("click", () => cfgAmmConfigure(amPools().map((p) => p.id)));
        $("cfgAmmPools").addEventListener("change", () => {
          const p = amPools().find((x) => x.id === cfgAmmSelectedIds()[0]);
          if (!p) return;
          $("cfgAmmFee").value = (p.swapFeeBps / 100).toFixed(2);
          $("cfgAmmLpShare").value = String(p.lpShareBps / 100);
        });

        const freeze = async (frozen) => {
          const [poolId] = cfgAmmSelectedIds();
          if (poolId === undefined) { cfgAmmMsg("Select a pool first.", false); return; }
          cfgAmmMsg("Sending…", true);
          try {
            const r = await (await postJson("/api/amm/admin/freeze", { poolId, frozen })).json();
            cfgAmmMsg(
              r.ok
                ? `Pool ${frozen ? "frozen" : "unfrozen"} ✓${frozen ? " — withdrawals stay open" : ""}`
                : r.error,
              !!r.ok,
            );
            if (r.ok) afterTx();
          } catch { cfgAmmMsg("Request failed.", false); }
        };
        $("cfgAmmFreeze").addEventListener("click", () => freeze(true));
        $("cfgAmmUnfreeze").addEventListener("click", () => freeze(false));

        $("cfgAmmRename").addEventListener("click", async () => {
          const [poolId] = cfgAmmSelectedIds();
          if (poolId === undefined) { cfgAmmMsg("Select a pool first.", false); return; }
          const current = amPools().find((p) => p.id === poolId);
          const name = prompt("New name for this pool:", current ? current.name : "");
          if (name === null) return;
          cfgAmmMsg("Sending…", true);
          try {
            const r = await (await postJson("/api/amm/admin/rename", { poolId, name: name.trim() })).json();
            cfgAmmMsg(r.ok ? "Renamed ✓" : r.error, !!r.ok);
            if (r.ok) afterTx();
          } catch { cfgAmmMsg("Request failed.", false); }
        });

        $("cfgAmmCreate").addEventListener("click", async () => {
          const assets = [...$("cfgAmmNewAssets").selectedOptions].map((o) => o.value);
          if (assets.length < 2) { cfgAmmMsg("Pick at least two assets.", false); return; }
          cfgAmmMsg("Deploying pool…", true);
          try {
            const r = await (
              await postJson("/api/amm/admin/create", {
                assets,
                name: $("cfgAmmNewName").value.trim(),
                swapFeeBps: Math.round(+($("cfgAmmFee").value || 0.3) * 100),
                lpShareBps: Math.round(+($("cfgAmmLpShare").value || 50) * 100),
              })
            ).json();
            cfgAmmMsg(r.ok ? "Pool created ✓" : r.error, !!r.ok);
            if (r.ok) { $("cfgAmmNewName").value = ""; afterTx(); setTimeout(renderCfgAmm, 1500); }
          } catch { cfgAmmMsg("Request failed.", false); }
        });
      }
      function closeCfg() {
        $("cfgModal").hidden = true;
        $("cfgBtn").setAttribute("aria-expanded", "false");
      }
      if ($("cfgBtn")) $("cfgBtn").addEventListener("click", openCfg);
      if ($("cfgCloseBtn")) $("cfgCloseBtn").addEventListener("click", closeCfg);
      if ($("cfgModal")) {
        $("cfgModal").addEventListener("click", (e) => { if (e.target === $("cfgModal")) closeCfg(); });
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && $("cfgModal") && !$("cfgModal").hidden) closeCfg();
      });
      // Jump controls scroll the dialog's own body, not the page.
      function syncCfgDock() {
        const b = $("cfgBody"), up = $("cfgToTop"), dn = $("cfgToBottom");
        if (!b || !up || !dn) return;
        up.hidden = b.scrollTop < 80;
        dn.hidden = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
      }
      if ($("cfgBody")) {
        $("cfgBody").addEventListener("scroll", syncCfgDock, { passive: true });
        $("cfgToTop").addEventListener("click", () => $("cfgBody").scrollTo({ top: 0, behavior: "smooth" }));
        $("cfgToBottom").addEventListener("click", () =>
          $("cfgBody").scrollTo({ top: $("cfgBody").scrollHeight, behavior: "smooth" }));
      }

      // Reflect who's signed in: show the profile menu for any identity, and the
      // App Config menu only for the operator.
      let profileState = null;
      async function refreshProfile() {
        const t = authToken();
        const wrap = $("profileWrap"), cw = $("cfgWrap");
        if (!t) { profileState = null; if (wrap) wrap.style.display = "none"; if (cw) cw.style.display = "none"; return; }
        try {
          const p = await (await fetch("/api/profile", { headers: authHeaders() })).json();
          if (!p.ok) throw new Error("no session");
          profileState = p;
          if (wrap) wrap.style.display = "inline-block";
          $("profileLabel").textContent = p.name || (p.kind === "admin" ? "Operator" : short(p.address));
          $("profileWho").textContent = p.kind === "admin" ? "Signed in as operator" : "Wallet " + short(p.address);
          $("profPassword").style.display = p.canChangePassword ? "block" : "none";
          if (cw) cw.style.display = p.isOperator ? "inline-block" : "none";
          // Config values load when the dialog is opened.
        } catch {
          profileState = null;
          if (wrap) wrap.style.display = "none";
          if (cw) cw.style.display = "none";
        }
      }

      // Profile menu actions.
      document.querySelectorAll("[data-prof]").forEach((el) => {
        el.addEventListener("click", async () => {
          const what = el.dataset.prof;
          if (profileMenu) profileMenu.close();
          if (what === "edit") {
            const name = prompt("Display name:", (profileState && profileState.name) || "");
            if (name === null) return;
            const r = await (await postAuthed("/api/profile", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name }),
            })).json();
            alert(r.ok ? "Profile saved." : "Couldn't save: " + r.error);
            refreshProfile();
          } else if (what === "password") {
            const pw = await askAuth("change");
            if (!pw) return;
            const { current, next } = pw;
            const r = await (await postAuthed("/api/admin/change-password", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ current, next }),
            })).json();
            alert(r.ok ? "Password changed." : "Failed: " + r.error);
          } else if (what === "status") {
            openAcctSheet();
          } else if (what === "history") {
            openTxSheet();
          } else if (what === "signout") {
            await postAuthed("/api/admin/logout").catch(() => {});
            localStorage.removeItem("tessera_token");
            setAdmin(null);
            setWallet(null);
            refreshProfile();
          }
        });
      });

      /* ====================================================================
       * Agent workspace — live market and news feeds.
       *
       * Every figure here comes from a named upstream source via the server,
       * which caches and never fabricates. When a feed is unreachable the panel
       * says so; it does not fall back to a stale number dressed up as current,
       * because someone might act on it.
       *
       * Tabs load lazily and refresh only while visible: polling six feeds for a
       * tab nobody is looking at is pure waste, and would burn the upstream rate
       * limits that the whole panel depends on.
       * ==================================================================== */
      const AG_PANES = {
        operations: "agOperations",
        news: "agNews",
        fx: "agFx",
        crypto: "agCrypto",
        analysis: "agAnalysis",
        stocks: "agStocks",
        commodities: "agCommodities",
        marketplace: "agMarketplace",
      };
      const AG_TAB_KEY = "tessera_ag_tab";
      let agTab = "operations";
      let agTimer = null;

      /** Exchange-style colour: green up, red down, muted flat. */
      const moveClass = (v) => (v === null || v === undefined ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat");
      const pctCell = (v) =>
        v === null || v === undefined
          ? `<td class="num flat">—</td>`
          : `<td class="num ${moveClass(v)}">${v >= 0 ? "+" : ""}${v.toFixed(2)}%</td>`;
      const absCell = (v, dp = 2) =>
        v === null || v === undefined
          ? `<td class="num flat">—</td>`
          : `<td class="num ${moveClass(v)}">${v >= 0 ? "+" : ""}${v.toFixed(dp)}</td>`;
      /** Sensible precision: a 0.85 FX rate and a 64,000 price need different dp. */
      const money = (v, cur) => {
        if (!Number.isFinite(v)) return "—";
        const dp = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
        const n = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: dp });
        return cur && cur !== "USD" ? `${n} ${cur}` : `$${n}`;
      };
      const compact = (v) =>
        !Number.isFinite(v) ? "—"
        : v >= 1e12 ? (v / 1e12).toFixed(2) + "T"
        : v >= 1e9 ? (v / 1e9).toFixed(2) + "B"
        : v >= 1e6 ? (v / 1e6).toFixed(2) + "M"
        : v.toLocaleString();

      /** One place to say where a number came from and how old it is. */
      function feedNote(id, r) {
        const el = $(id);
        if (!el) return;
        if (r.error) {
          el.className = "feedNote bad";
          el.textContent = r.error;
          return;
        }
        const age = r.ageSeconds < 60 ? `${r.ageSeconds}s` : `${Math.round(r.ageSeconds / 60)}m`;
        el.className = r.warning ? "feedNote bad" : "feedNote";
        el.textContent =
          `Source: ${r.source} · fetched ${age} ago` + (r.warning ? ` · ${r.warning}` : "");
      }
      const emptyRow = (cols, text) =>
        `<tr><td colspan="${cols}" style="color:var(--muted);padding:16px">${esc(text)}</td></tr>`;

      /**
       * Render rows with a sticky section band whenever `key` changes.
       *
       * The lists are long now — 40-odd FX pairs, 36 stocks — and a flat run of
       * rows with only a frozen header tells you what the columns are but not
       * where you are in the list. Bands are emitted in the order the server
       * sent the rows, so the server's ordering stays the source of truth.
       */
      function groupedRows(rows, cols, key, render) {
        let current = null;
        const out = [];
        for (const row of rows) {
          const k = key(row) || "";
          if (k && k !== current) {
            current = k;
            out.push(`<tr class="grp"><td colspan="${cols}">${esc(k)}</td></tr>`);
          }
          out.push(render(row));
        }
        return out.join("");
      }

      async function feed(path) {
        const res = await fetch(path);
        return res.json();
      }

      async function loadFx() {
        const body = $("fxRows");
        body.innerHTML = emptyRow(3, "Loading…");
        try {
          const r = await feed("/api/feeds/fx");
          feedNote("fxNote", r);
          const rates = (r.items && r.items.rates) || [];
          body.innerHTML = rates.length
            ? groupedRows(
                rates,
                3,
                (x) => x.group,
                (x) =>
                  `<tr><td><b>${esc(x.pair)}</b></td>` +
                  `<td class="num">${esc(x.rate.toFixed(x.rate >= 100 ? 3 : 5))}</td>` +
                  pctCell(x.changePct) +
                  `</tr>`,
              )
            : emptyRow(3, r.error || "No rates available.");
        } catch {
          body.innerHTML = emptyRow(3, "Couldn't reach the server.");
        }
      }

      async function loadCryptoFeed() {
        const body = $("cryptoRows");
        body.innerHTML = emptyRow(7, "Loading…");
        try {
          const r = await feed("/api/feeds/crypto");
          feedNote("cryptoNote", r);
          const rows = r.items || [];
          body.innerHTML = rows.length
            ? rows
                .map(
                  (x) =>
                    `<tr><td><b>${esc(x.symbol)}</b> <span style="color:var(--muted)">${esc(x.name)}</span></td>` +
                    `<td class="num">${esc(money(x.price))}</td>` +
                    pctCell(x.changeDay) + pctCell(x.changeWeek) + pctCell(x.changeMonth) + pctCell(x.changeYear) +
                    `<td class="num">${esc(compact(x.marketCap))}</td></tr>`,
                )
                .join("")
            : emptyRow(7, r.error || "No prices available.");
        } catch {
          body.innerHTML = emptyRow(7, "Couldn't reach the server.");
        }
      }

      async function loadStocks() {
        const idx = $("indexRows"), st = $("stockRows");
        idx.innerHTML = emptyRow(5, "Loading…");
        st.innerHTML = emptyRow(6, "Loading…");
        try {
          const r = await feed("/api/feeds/stocks");
          feedNote("stocksNote", r);
          const q = r.items || {};
          idx.innerHTML = (q.indices || []).length
            ? groupedRows(
                q.indices,
                5,
                (x) => x.sector,
                (x) =>
                  `<tr><td><b>${esc(x.name)}</b></td>` +
                  `<td class="num">${esc(x.price.toLocaleString(undefined, { maximumFractionDigits: 2 }))}</td>` +
                  absCell(x.changeAbs) + pctCell(x.changePct) +
                  `<td><span class="tag">${esc(x.marketState || "—")}</span></td></tr>`,
              )
            : emptyRow(5, r.error || "No index data available.");
          st.innerHTML = (q.stocks || []).length
            ? groupedRows(
                q.stocks,
                6,
                (x) => x.sector,
                (x) =>
                  `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.symbol)}</td>` +
                  `<td class="num">${esc(money(x.price, x.currency))}</td>` +
                  absCell(x.changeAbs) + pctCell(x.changePct) +
                  `<td><span class="tag">${esc(x.marketState || "—")}</span></td></tr>`,
              )
            : emptyRow(6, r.error || "No stock data available.");
        } catch {
          idx.innerHTML = emptyRow(5, "Couldn't reach the server.");
          st.innerHTML = emptyRow(6, "Couldn't reach the server.");
        }
      }

      async function loadCommodities() {
        const body = $("commodityRows");
        body.innerHTML = emptyRow(5, "Loading…");
        try {
          const r = await feed("/api/feeds/commodities");
          feedNote("commoditiesNote", r);
          const rows = r.items || [];
          body.innerHTML = rows.length
            ? groupedRows(
                rows,
                5,
                (x) => x.sector,
                (x) =>
                  `<tr><td><b>${esc(x.name)}</b></td>` +
                  `<td class="num">${esc(money(x.price, x.currency))}</td>` +
                  absCell(x.changeAbs) + pctCell(x.changePct) +
                  `<td><span class="tag">${esc(x.marketState || "—")}</span></td></tr>`,
              )
            : emptyRow(5, r.error || "No commodity data available.");
        } catch {
          body.innerHTML = emptyRow(5, "Couldn't reach the server.");
        }
      }

      async function loadAnalysis() {
        const host = $("analysisList");
        host.innerHTML = `<div style="color:var(--muted)">Loading…</div>`;
        try {
          const r = await feed("/api/feeds/analysis");
          feedNote("analysisNote", r);
          const lines = (r.items && r.items.lines) || [];
          host.innerHTML = lines.length
            ? lines
                .map((l) => {
                  const mark = l.tone === "up" ? "▲" : l.tone === "down" ? "▼" : l.tone === "flat" ? "▬" : "ⓘ";
                  return (
                    `<div style="display:flex;gap:10px;align-items:flex-start">` +
                    `<span class="${esc(l.tone === "info" ? "flat" : moveClass(l.tone === "up" ? 1 : l.tone === "down" ? -1 : 0))}" ` +
                    `style="font-size:13px;line-height:1.5">${mark}</span>` +
                    `<span><b>${esc(l.label)}</b><span style="display:block;color:var(--muted);font-size:12.5px;line-height:1.55">${esc(l.detail)}</span></span></div>`
                  );
                })
                .join("")
            : `<div style="color:var(--warn)">${esc(r.error || "Nothing to analyse.")}</div>`;
        } catch {
          host.innerHTML = `<div style="color:var(--warn)">Couldn't reach the server.</div>`;
        }
        await loadRatesFeed();
      }

      /**
       * Central bank policy rates, balance sheets and market-set rates.
       *
       * Rendered as tables under the analysis prose so the figures those lines
       * are computed from are visible on the same screen — the point of the
       * "no invented numbers" rule is that a reader can check the arithmetic.
       */
      async function loadRatesFeed() {
        const pol = $("policyRows"), sh = $("sheetRows"), mk = $("marketRateRows");
        if (!pol) return;
        pol.innerHTML = emptyRow(6, "Loading…");
        sh.innerHTML = emptyRow(7, "Loading…");
        mk.innerHTML = emptyRow(4, "Loading…");
        try {
          const r = await feed("/api/feeds/rates");
          feedNote("ratesNote", r);
          const it = r.items || {};
          const bp = (v) =>
            v === null || v === undefined
              ? `<td class="num flat">—</td>`
              : `<td class="num ${v < 0 ? "up" : v > 0 ? "down" : "flat"}">${v > 0 ? "+" : ""}${v} bp</td>`;
          pol.innerHTML = (it.policy || []).length
            ? groupedRows(
                it.policy,
                6,
                (x) => x.bank,
                (x) =>
                  `<tr><td><b>${esc(x.bank)}</b></td><td>${esc(x.instrument)}</td>` +
                  `<td class="num"><b>${esc(x.display)}</b></td>` +
                  bp(x.moveBps) +
                  `<td>${esc(x.since || "—")}</td>` +
                  `<td class="num">${x.heldDays === null ? "—" : esc(x.heldDays + "d")}</td></tr>`,
              )
            : emptyRow(6, r.error || "No policy rate data available.");
          // Balance sheets are published in millions; trillions is the readable unit.
          const tn = (v) =>
            v === null || v === undefined
              ? `<td class="num flat">—</td>`
              : `<td class="num ${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1e6).toFixed(3)}tn</td>`;
          sh.innerHTML = (it.sheets || []).length
            ? groupedRows(
                it.sheets,
                7,
                (x) => x.bank,
                (x) =>
                  `<tr><td><b>${esc(x.bank)}</b></td><td>${esc(x.label)}</td>` +
                  `<td class="num"><b>${esc((x.latest / 1e6).toFixed(3))}tn ${esc(x.unit.split(" ")[0])}</b></td>` +
                  tn(x.change4w) + tn(x.change13w) + tn(x.change52w) +
                  `<td><span class="tag ${x.stance === "expanding" ? "ok" : x.stance === "contracting" ? "warn" : ""}">` +
                  `${esc(x.stance)}</span></td></tr>`,
              )
            : emptyRow(7, r.error || "No balance sheet data available.");
          mk.innerHTML = (it.market || []).length
            ? it.market
                .map(
                  (x) =>
                    `<tr><td><b>${esc(x.label)}</b></td>` +
                    `<td class="num">${esc(x.value.toLocaleString(undefined, { maximumFractionDigits: 3 }))} ${esc(x.unit)}</td>` +
                    // The comparison date is shown, not assumed: these series
                    // have different frequencies, so "a week" is approximate and
                    // for the monthly ones it is really the previous month.
                    (x.change === null || x.change === undefined
                      ? `<td class="num flat">—</td>`
                      : `<td class="num ${x.change > 0 ? "up" : x.change < 0 ? "down" : "flat"}">` +
                        `${x.change >= 0 ? "+" : "−"}${Math.abs(x.change).toFixed(2)}` +
                        (x.changeFrom
                          ? `<span style="display:block;font-size:10.5px;color:var(--muted);font-weight:400">vs ${esc(x.changeFrom)}</span>`
                          : "") +
                        `</td>`) +
                    `<td style="color:var(--muted);font-size:12px">${esc(x.note)}</td></tr>`,
                )
                .join("")
            : emptyRow(4, r.error || "No market rate data available.");
        } catch {
          pol.innerHTML = emptyRow(6, "Couldn't reach the server.");
          sh.innerHTML = emptyRow(7, "Couldn't reach the server.");
          mk.innerHTML = emptyRow(4, "Couldn't reach the server.");
        }
      }

      /* ---- news ---- */
      const NEWS_KEY = "tessera_news_topics";
      let newsTopics = [];
      let newsSelected = new Set();

      function renderNewsTopics() {
        const host = $("newsTopics");
        if (!host) return;
        host.innerHTML = newsTopics
          .map(
            (t) =>
              `<button class="sheetTab ${newsSelected.has(t) ? "active" : ""}" data-topic="${esc(t)}">` +
              `${esc(t.charAt(0).toUpperCase() + t.slice(1))}</button>`,
          )
          .join("");
        host.querySelectorAll("[data-topic]").forEach((b) =>
          b.addEventListener("click", () => {
            const t = b.dataset.topic;
            if (newsSelected.has(t)) newsSelected.delete(t);
            else newsSelected.add(t);
            try { localStorage.setItem(NEWS_KEY, JSON.stringify([...newsSelected])); } catch {}
            renderNewsTopics();
          }),
        );
      }

      async function loadNewsTopics() {
        if (newsTopics.length) return;
        try {
          const r = await feed("/api/feeds/topics");
          newsTopics = r.topics || [];
          try {
            const saved = JSON.parse(localStorage.getItem(NEWS_KEY) || "[]");
            newsSelected = new Set(saved.filter((t) => newsTopics.includes(t)));
          } catch { newsSelected = new Set(); }
          // Default to a useful spread rather than everything at once.
          if (!newsSelected.size) newsSelected = new Set(["general", "economic", "technology", "crypto"].filter((t) => newsTopics.includes(t)));
          renderNewsTopics();
        } catch { /* the note below will explain */ }
      }

      const ago = (ms) => {
        const m = Math.round((Date.now() - ms) / 60000);
        if (!Number.isFinite(m) || m < 0) return "";
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
      };

      /**
       * Headlines, revealed in pages.
       *
       * The server returns up to 120 de-duplicated items; rendering all of them
       * buries the rest of the tab under a wall of links. Show a page at a time
       * and let the reader ask for more.
       */
      const NEWS_PAGE = 25;
      let newsItems = [];
      let newsShown = NEWS_PAGE;

      function renderNews() {
        const host = $("newsList");
        const more = $("newsMore");
        if (!newsItems.length) {
          host.innerHTML = `<div style="color:var(--warn);padding:8px 0">No headlines available.</div>`;
          if (more) more.hidden = true;
          return;
        }
        host.innerHTML = newsItems
          .slice(0, newsShown)
          .map(
            (n) =>
              `<div style="padding:9px 0;border-bottom:1px solid var(--line)">` +
              // rel=noopener so a publisher's page can't touch this one.
              // nofollow as well: we are not vouching for the destination, and a
              // compromised publisher page shouldn't inherit our ranking signal.
              `<a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer" style="font-size:13.5px;font-weight:600">${esc(n.title)}</a>` +
              `<span style="display:block;color:var(--muted);font-size:11.5px;margin-top:3px">` +
              `<span class="tag">${esc(n.topic)}</span> ${esc(n.source)} · ${esc(ago(n.publishedAt))}</span></div>`,
          )
          .join("");
        if (more) {
          const left = newsItems.length - newsShown;
          more.hidden = left <= 0;
          more.textContent = `Show ${Math.min(left, NEWS_PAGE)} more (${left} left)`;
        }
      }

      async function loadNews() {
        const host = $("newsList");
        host.innerHTML = `<div style="color:var(--muted);padding:8px 0">Loading headlines…</div>`;
        const topics = newsSelected.size ? [...newsSelected].join(",") : "all";
        try {
          const r = await feed("/api/feeds/news?topics=" + encodeURIComponent(topics));
          feedNote("newsNote", r);
          newsItems = r.items || [];
          // A fresh query starts at the first page again.
          newsShown = NEWS_PAGE;
          if (!newsItems.length && r.error) {
            host.innerHTML = `<div style="color:var(--warn);padding:8px 0">${esc(r.error)}</div>`;
            if ($("newsMore")) $("newsMore").hidden = true;
            return;
          }
          renderNews();
        } catch {
          host.innerHTML = `<div style="color:var(--warn);padding:8px 0">Couldn't reach the server.</div>`;
          if ($("newsMore")) $("newsMore").hidden = true;
        }
      }

      if ($("newsMore")) {
        $("newsMore").addEventListener("click", () => {
          newsShown += NEWS_PAGE;
          renderNews();
        });
      }

      /* ====================================================================
       * Services Tessera sells.
       *
       * These are the app's own DeFi reads, published over HTTP 402. The "Call
       * it" button walks the real handshake — 402 quote, on-chain escrow,
       * delivery, settle — because a shortcut that returned the answer without
       * paying would be demonstrating a REST API, not agentic commerce.
       *
       * Which arguments each service needs is declared here rather than
       * inferred, so a service that gains a parameter fails loudly (a missing
       * input) instead of silently answering about the wrong thing.
       * ==================================================================== */
      const SELL_ARGS = {
        "defi:yield-best": [],
        "defi:treasury": [],
        "defi:route": [
          { key: "tokenIn", label: "Token in", kind: "asset" },
          { key: "tokenOut", label: "Token out", kind: "asset" },
          { key: "amountIn", label: "Amount in", kind: "amount", of: "tokenIn", ph: "100" },
        ],
        "defi:health": [{ key: "account", label: "Account", kind: "address", ph: "0x…" }],
        "defi:reputation": [{ key: "provider", label: "Provider", kind: "address", ph: "0x…" }],
        "defi:at-risk": [
          { key: "accounts", label: "Accounts", kind: "text", ph: "0x…,0x… (comma-separated, max 25)" },
        ],
      };
      let sellState = { services: [], assets: [], base: "", picked: null, busy: false };

      async function loadSellServices() {
        const rows = $("sellRows");
        if (!rows) return;
        try {
          const r = await (await fetch("/api/services")).json();
          if (!r.ok) throw new Error(r.error || "catalogue unavailable");
          sellState.services = r.services || [];
          sellState.assets = r.assets || [];
          sellState.base = r.base || "";
        } catch (e) {
          rows.innerHTML = `<tr><td colspan="4" class="muted">${esc(String(e.message || e))}</td></tr>`;
          return;
        }
        if (!sellState.services.length) {
          rows.innerHTML = `<tr><td colspan="4" class="muted">No services published.</td></tr>`;
          return;
        }
        rows.innerHTML = sellState.services
          .map(
            (s) => `<tr>
              <td>
                <div style="font-weight:600">${esc(s.name)}</div>
                <div class="mono" style="font-size:11px;color:var(--muted)">${esc(s.resource)} · ${esc(s.path)}</div>
              </td>
              <td class="num mono">${esc(s.price)}</td>
              <td>${s.billing === "tab" ? "tab (nanopayments)" : "escrow, per call"}</td>
              <td class="num"><button class="btn" data-sell="${esc(s.resource)}">Try it</button></td>
            </tr>`,
          )
          .join("");
        rows.querySelectorAll("[data-sell]").forEach((b) =>
          b.addEventListener("click", () => pickSellService(b.dataset.sell)));

        const baseEl = $("sellBase");
        if (baseEl && sellState.base) baseEl.textContent = sellState.base;
        const curl = $("sellCurl");
        if (curl && sellState.base) {
          curl.textContent =
            `# 1. quote (unpaid — returns 402 + signed headers)\n` +
            `curl -i ${sellState.base}/defi/yield/best\n\n` +
            `# 2. escrow x-tessera-price USDC to x-tessera-provider in TesseraEscrow.open()\n\n` +
            `# 3. collect (paid)\n` +
            `curl -H "x-tessera-payment: <paymentId>" ${sellState.base}/defi/yield/best\n\n` +
            `# the whole catalogue\n` +
            `curl ${sellState.base}/catalog`;
        }
      }

      /** Show the argument form for one service. */
      function pickSellService(resource) {
        const svc = sellState.services.find((s) => s.resource === resource);
        if (!svc) return;
        sellState.picked = svc;
        const spec = SELL_ARGS[resource] || [];
        $("sellPicked").textContent = `${svc.name} — ${svc.price} USDC per call`;
        const assetOpts = sellState.assets
          .map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`)
          .join("");
        $("sellArgFields").innerHTML = spec.length
          ? spec
              .map((f) =>
                f.kind === "asset" && sellState.assets.length
                  ? `<label style="flex:1;min-width:150px;font-size:11.5px;color:var(--muted)">${esc(f.label)}
                       <select class="field" data-arg="${esc(f.key)}" style="width:100%">${assetOpts}</select></label>`
                  : `<label style="flex:1;min-width:180px;font-size:11.5px;color:var(--muted)">${esc(f.label)}
                       <input class="field" data-arg="${esc(f.key)}" data-kind="${esc(f.kind)}"
                              placeholder="${esc(f.ph || "")}" style="width:100%" /></label>`,
              )
              .join("")
          : `<div style="font-size:12px;color:var(--muted)">No arguments — this one reads the whole deployment.</div>`;
        $("sellHint").textContent = svc.billing === "tab"
          ? "Tab-billed for keepers streaming it. Calling it here opens a single escrow instead, which is the same answer at a higher unit cost."
          : "Pays the quote into TesseraEscrow, collects the answer, then settles — operator only.";
        $("sellArgs").style.display = "";
        $("sellOut").style.display = "none";
      }

      /** Amounts go over the wire in base units; the form takes human numbers. */
      function sellDecimalsFor(argKey) {
        const spec = (SELL_ARGS[sellState.picked?.resource] || []).find((f) => f.key === argKey);
        if (!spec || spec.kind !== "amount") return null;
        const src = $("sellArgFields").querySelector(`[data-arg="${spec.of}"]`);
        const asset = sellState.assets.find((a) => a.address === src?.value);
        return asset ? asset.decimals : 6;
      }

      async function runSellService() {
        if (!sellState.picked || sellState.busy) return;
        const out = $("sellOut");
        const spec = SELL_ARGS[sellState.picked.resource] || [];
        const qs = new URLSearchParams({ resource: sellState.picked.resource });
        for (const f of spec) {
          const el = $("sellArgFields").querySelector(`[data-arg="${f.key}"]`);
          const v = (el?.value || "").trim();
          if (!v) {
            out.style.display = "";
            out.textContent = `${f.label} is required — the service will not answer about nothing.`;
            return;
          }
          if (f.kind === "amount") {
            const dp = sellDecimalsFor(f.key) ?? 6;
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0) {
              out.style.display = "";
              out.textContent = `${f.label} must be a positive number.`;
              return;
            }
            // Human number -> base units, without floating point in the middle.
            const [whole, frac = ""] = v.split(".");
            qs.set(f.key, (BigInt(whole || "0") * 10n ** BigInt(dp)
              + BigInt((frac + "0".repeat(dp)).slice(0, dp) || "0")).toString());
          } else {
            qs.set(f.key, v);
          }
        }

        sellState.busy = true;
        $("sellRun").disabled = true;
        out.style.display = "";
        out.textContent = "Requesting a quote, escrowing on Arc, collecting… this is three transactions, give it a moment.";
        try {
          const res = await postAuthed("/api/services/try?" + qs.toString());
          const r = await res.json();
          if (!r.ok) {
            out.textContent = "✗ " + (r.error || `HTTP ${res.status}`) +
              (r.refunded ? "\n\nThe escrow was reclaimed — no USDC was lost." : "");
            return;
          }
          const links = Object.entries(r.txs || {})
            .map(([k, h]) => `${k}: ${h}`)
            .join("\n");
          out.textContent =
            `✓ paid ${r.price} USDC · payment #${r.paymentId}\n${links}\n\n` +
            JSON.stringify(r.body, null, 2);
          afterTx();
        } catch (e) {
          out.textContent = "✗ " + String(e.message || e);
        } finally {
          sellState.busy = false;
          $("sellRun").disabled = false;
        }
      }

      /** Escrow-as-a-service: read the on-chain fee, and let an owner change it. */
      async function loadEscrowFee() {
        if (!$("escFeeBps")) return;
        try {
          const r = await (await fetch("/api/escrow/fee")).json();
          if (!r.ok) throw new Error(r.error || "unavailable");
          // An escrow deployed before the fee existed. Say that, rather than
          // showing a 0% that looks like a setting someone chose.
          $("escFeeBps").textContent = r.supported ? `${r.bps} bps (${(r.bps / 100).toFixed(2)}%)` : "not available on this escrow";
          $("escFeeTreasury").textContent = r.treasury || "—";
          $("escFeeMax").textContent = r.supported ? `${r.maxBps} bps (${(r.maxBps / 100).toFixed(2)}%)` : "—";
          $("escFeeNote").textContent = r.canSet
            ? r.note
            : r.note + " Changing it needs the deploying key, which this dashboard doesn't hold.";
          $("escFeeControls").style.display = r.canSet ? "" : "none";
          if (r.canSet && !$("escFeeInput").value) $("escFeeInput").value = String(r.bps);
        } catch (e) {
          $("escFeeNote").textContent = String(e.message || e);
        }
      }

      if ($("escFeeSet")) {
        $("escFeeSet").addEventListener("click", async () => {
          const bps = $("escFeeInput").value.trim();
          if (bps === "") { $("escFeeNote").textContent = "Enter a fee in basis points."; return; }
          $("escFeeSet").disabled = true;
          $("escFeeNote").textContent = "Sending the owner call…";
          try {
            const r = await (await postAuthed(`/api/escrow/fee?bps=${encodeURIComponent(bps)}`)).json();
            $("escFeeNote").textContent = r.ok ? `Fee updated — ${r.txHash}` : "✗ " + (r.error || "failed");
            if (r.ok) { loadEscrowFee(); afterTx(); }
          } catch (e) {
            $("escFeeNote").textContent = "✗ " + String(e.message || e);
          } finally {
            $("escFeeSet").disabled = false;
          }
        });
      }

      if ($("sellRun")) {
        $("sellRun").addEventListener("click", runSellService);
        $("sellCancel").addEventListener("click", () => {
          sellState.picked = null;
          $("sellArgs").style.display = "none";
          $("sellOut").style.display = "none";
        });
      }

      const AG_LOADERS = {
        news: loadNews,
        fx: loadFx,
        crypto: loadCryptoFeed,
        analysis: loadAnalysis,
        stocks: loadStocks,
        commodities: loadCommodities,
        marketplace: () => { loadSellServices(); loadEscrowFee(); },
      };
      /** Refresh cadence per tab. Prices move; news does not, minute to minute. */
      const AG_REFRESH = { fx: 120_000, crypto: 60_000, stocks: 90_000, commodities: 90_000, analysis: 120_000, news: 600_000 };

      function setAgTab(tab, opts) {
        if (!(tab in AG_PANES)) tab = "operations";
        agTab = tab;
        try { localStorage.setItem(AG_TAB_KEY, tab); } catch {}
        for (const [name, id] of Object.entries(AG_PANES)) {
          const el = $(id);
          if (el) el.hidden = name !== tab;
        }
        document.querySelectorAll("[data-agtab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.agtab === tab));

        clearInterval(agTimer);
        agTimer = null;
        const load = AG_LOADERS[tab];
        if (!load) return;
        if (tab === "news") loadNewsTopics().then(load);
        else if (!opts || opts.load !== false) load();
        // Only the visible tab polls.
        const every = AG_REFRESH[tab];
        if (every) {
          agTimer = setInterval(() => {
            if ($("paneAgents").hidden || agTab !== tab) return;
            load();
          }, every);
        }
      }

      if ($("agTabs")) {
        document.querySelectorAll("[data-agtab]").forEach((b) =>
          b.addEventListener("click", () => setAgTab(b.dataset.agtab)));
        $("newsApply").addEventListener("click", loadNews);
        $("newsAll").addEventListener("click", () => {
          newsSelected = new Set(newsTopics);
          try { localStorage.setItem(NEWS_KEY, JSON.stringify([...newsSelected])); } catch {}
          renderNewsTopics();
          loadNews();
        });
        $("newsNone").addEventListener("click", () => {
          newsSelected = new Set();
          try { localStorage.setItem(NEWS_KEY, "[]"); } catch {}
          renderNewsTopics();
        });
        // Restore the last tab, but don't fetch until the section is actually shown.
        let saved = "operations";
        try { saved = localStorage.getItem(AG_TAB_KEY) || "operations"; } catch {}
        setAgTab(saved, { load: false });
        // Load on first reveal, so opening the app on the Dashboard costs nothing.
        let agLoadedOnce = false;
        const revealCheck = setInterval(() => {
          if (agLoadedOnce || !$("paneAgents") || $("paneAgents").hidden) return;
          agLoadedOnce = true;
          setAgTab(agTab);
        }, 500);
        window.addEventListener("beforeunload", () => clearInterval(revealCheck));
      }

      /* ====================================================================
       * Large sheets: transaction history and account status.
       *
       * These are overlays, not routes. Nothing reloads, the page underneath
       * keeps its scroll position and state, and closing returns you exactly
       * where you were. Escape and the backdrop both close.
       * ==================================================================== */
      function openSheet(id) {
        const el = $(id);
        if (!el) return;
        el.hidden = false;
        // Stop the page behind from scrolling while a sheet is open — on iOS a
        // scrollable body under a fixed overlay is what causes the "rubber band
        // steals my scroll" problem.
        document.body.style.overflow = "hidden";
        const focusable = el.querySelector("button, select, input");
        if (focusable) setTimeout(() => focusable.focus(), 60);
      }
      function closeSheet(id) {
        const el = $(id);
        if (!el) return;
        el.hidden = true;
        if (document.querySelectorAll(".sheetWrap:not([hidden])").length === 0) {
          document.body.style.overflow = "";
        }
      }
      document.querySelectorAll(".sheetWrap").forEach((w) => {
        w.addEventListener("click", (e) => { if (e.target === w) closeSheet(w.id); });
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const open = [...document.querySelectorAll(".sheetWrap:not([hidden])")];
        if (open.length) closeSheet(open[open.length - 1].id);
      });

      /* ---- transaction history ------------------------------------------- */
      const TX_PAGE = 40;
      let txState = { tab: "all", offset: 0, total: 0, isOperator: false, actor: "" };

      const fmtWhenShort = (ms) => {
        const d = new Date(ms);
        if (isNaN(d)) return "—";
        // Format the date and the time separately. Handing toLocaleString a
        // day+2-digit-year combination produced "Jul 26, 26, 05:45" in en-US —
        // the day and the year read as the same number and it looks like a bug.
        const day = d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
        const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        return `${day} · ${time}`;
      };
      const statusTag = (s) => {
        const cls = s === "success" || s === "approved" ? "ok" : s === "failed" ? "bad" : s === "declined" ? "warn" : "";
        return `<span class="tag ${cls}">${esc(s)}</span>`;
      };

      /** Build the query string from the filter controls plus the active tab. */
      function txQuery() {
        const q = new URLSearchParams();
        // The tab is a category filter, except "everyone" which only widens the
        // actor scope (and is operator-only, enforced server-side).
        if (["defi", "agentic", "admin"].includes(txState.tab)) q.set("category", txState.tab);
        const pick = (id, key) => { const v = $(id) && $(id).value; if (v && v !== "all") q.set(key, v); };
        pick("txStatus", "status");
        pick("txAction", "action");
        pick("txAsset", "asset");
        pick("txSort", "sort");
        if (txState.tab === "everyone") pick("txActor", "actor");
        if ($("txFrom").value) q.set("from", String(Date.parse($("txFrom").value + "T00:00:00")));
        // Inclusive of the whole "to" day — a date picker means the day.
        if ($("txTo").value) q.set("to", String(Date.parse($("txTo").value + "T23:59:59.999")));
        if ($("txMin").value !== "") q.set("minUsd", $("txMin").value);
        if ($("txMax").value !== "") q.set("maxUsd", $("txMax").value);
        if ($("txQ").value.trim()) q.set("q", $("txQ").value.trim());
        q.set("limit", String(TX_PAGE));
        q.set("offset", String(txState.offset));
        return q;
      }

      async function loadTx() {
        const scope = txState.tab === "everyone" ? "transactions" : "mine";
        const url = `/api/history/${scope}?` + txQuery().toString();
        const rows = $("txRows");
        rows.innerHTML = `<tr><td colspan="8" style="color:var(--muted);padding:16px">Loading…</td></tr>`;
        try {
          const r = await (await fetch(url, { headers: authHeaders() })).json();
          if (!r.ok) {
            rows.innerHTML = "";
            $("txEmpty").textContent = r.error || "Couldn't load history.";
            return;
          }
          txState.total = r.total;
          if (r.actor) txState.actor = r.actor;

          // Summary strip.
          const sm = r.summary || {};
          $("txSummary").innerHTML = [
            ["Matching", String(sm.total ?? 0)],
            ["Succeeded", String(sm.success ?? 0)],
            ["Failed", String(sm.failed ?? 0)],
            ["Declined", String(sm.declined ?? 0)],
            ["DeFi", String(sm.defi ?? 0)],
            ["Agentic", String(sm.agentic ?? 0)],
            ["Value", "$" + (Number(sm.volumeUsd ?? 0)).toFixed(2)],
          ]
            .map(([k, v]) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
            .join("");

          // Filter option lists, from what is actually present.
          const fill = (id, values, label) => {
            const sel = $(id);
            if (!sel) return;
            const sig = values.join(",");
            if (sel.dataset.sig === sig) return;
            const keep = sel.value;
            sel.innerHTML =
              `<option value="all">${esc(label)}</option>` +
              values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
            if (values.includes(keep)) sel.value = keep;
            sel.dataset.sig = sig;
          };
          const f = r.facets || {};
          fill("txAction", f.actions || [], "Any");
          fill("txAsset", f.assets || [], "Any");
          if (txState.tab === "everyone") fill("txActor", f.actors || [], "Everyone");

          const showUser = txState.tab === "everyone";
          $("txThUser").hidden = !showUser;
          rows.innerHTML = (r.rows || [])
            .map((x) => {
              const link = x.txHash
                ? `<a href="${esc(window.__explorer || "")}/tx/${esc(x.txHash)}" target="_blank" rel="noopener">${esc(x.txHash.slice(0, 10))}…</a>`
                : "—";
              return (
                `<tr><td>${esc(fmtWhenShort(x.at))}</td>` +
                `<td>${esc(x.action)}</td>` +
                (showUser ? `<td title="${esc(x.actor)}">${esc(short(x.actor))}</td>` : "") +
                `<td class="num">${esc(x.amount || "—")}</td>` +
                `<td class="num">${x.valueUsd === undefined ? "—" : "$" + Number(x.valueUsd).toFixed(2)}</td>` +
                `<td>${statusTag(x.status)}</td>` +
                `<td>${esc(x.detail || "")}</td>` +
                `<td>${link}</td></tr>`
              );
            })
            .join("");
          $("txEmpty").textContent = (r.rows || []).length ? "" : "Nothing matches these filters.";
          const from = r.total ? txState.offset + 1 : 0;
          const to = Math.min(txState.offset + TX_PAGE, r.total);
          $("txPageInfo").textContent = r.total ? `${from}–${to} of ${r.total}` : "no results";
          $("txPrev").disabled = txState.offset === 0;
          $("txNext").disabled = to >= r.total;
        } catch {
          rows.innerHTML = "";
          $("txEmpty").textContent = "Couldn't reach the server.";
        }
      }

      function setTxTab(tab) {
        txState.tab = tab;
        txState.offset = 0;
        document.querySelectorAll("[data-txtab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.txtab === tab));
        $("txActorWrap").hidden = tab !== "everyone";
        loadTx();
      }

      async function openTxSheet() {
        // The operator-only tabs appear only for an operator; the server enforces
        // the same boundary, so this is presentation rather than protection.
        const isOp = !!(profileState && profileState.isOperator);
        txState.isOperator = isOp;
        $("txTabEveryone").hidden = !isOp;
        $("txTabAdmin").hidden = !isOp;
        $("txWho").textContent = isOp
          ? "Operator view — your own activity, or everyone's"
          : profileState && profileState.address
            ? "Your activity · " + short(profileState.address)
            : "Your activity";
        $("txExport").hidden = !isOp;
        openSheet("txSheet");
        setTxTab("all");
      }

      if ($("txSheet")) {
        document.querySelectorAll("[data-txtab]").forEach((b) =>
          b.addEventListener("click", () => setTxTab(b.dataset.txtab)));
        $("txClose").addEventListener("click", () => closeSheet("txSheet"));
        $("txRefresh").addEventListener("click", loadTx);
        $("txApply").addEventListener("click", () => { txState.offset = 0; loadTx(); });
        $("txReset").addEventListener("click", () => {
          ["txStatus", "txAction", "txAsset", "txSort", "txActor"].forEach((id) => {
            if ($(id)) $(id).selectedIndex = 0;
          });
          ["txFrom", "txTo", "txMin", "txMax", "txQ"].forEach((id) => { if ($(id)) $(id).value = ""; });
          txState.offset = 0;
          loadTx();
        });
        $("txPrev").addEventListener("click", () => {
          txState.offset = Math.max(0, txState.offset - TX_PAGE);
          loadTx();
        });
        $("txNext").addEventListener("click", () => {
          if (txState.offset + TX_PAGE < txState.total) { txState.offset += TX_PAGE; loadTx(); }
        });
        // Typing in the search box filters without needing Apply.
        let txQTimer = null;
        $("txQ").addEventListener("input", () => {
          clearTimeout(txQTimer);
          txQTimer = setTimeout(() => { txState.offset = 0; loadTx(); }, 350);
        });
        $("txExport").addEventListener("click", async () => {
          // Fetch with the auth header, then hand the browser a blob — a plain
          // link can't carry a bearer token.
          try {
            const res = await fetch("/api/history/transactions.csv?" + txQuery().toString(), { headers: authHeaders() });
            if (!res.ok) { alert("Export failed."); return; }
            const url = URL.createObjectURL(await res.blob());
            const a = document.createElement("a");
            a.href = url;
            a.download = "tessera-transactions.csv";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
          } catch { alert("Export failed."); }
        });
      }

      /* ---- account status ------------------------------------------------- */
      let acctTab = "identity";
      function setAcctTab(tab) {
        acctTab = tab;
        document.querySelectorAll("[data-acctab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.acctab === tab));
        renderAcct();
      }
      function openAcctSheet() {
        openSheet("acctSheet");
        setAcctTab("identity");
      }

      const row = (k, v, note) =>
        `<div class="cfgRow" style="padding:8px 0"><span>${esc(k)}</span>` +
        `<span style="text-align:right"><b>${esc(v)}</b>` +
        `${note ? `<span style="display:block;color:var(--muted);font-size:11.5px;font-weight:400">${esc(note)}</span>` : ""}` +
        `</span></div>`;
      const section = (title, body) =>
        `<div class="card compact"><h2>${esc(title)}</h2>${body}</div>`;

      function renderAcct() {
        const host = $("acctBody");
        if (!host) return;
        const p = profileState || {};
        const s = window.__lastState || {};
        const v = window.__vault, l = window.__lending, am = window.__amm, sw = window.__swap;

        if (acctTab === "identity") {
          host.innerHTML =
            section("Who you are", [
              row("Signed in as", p.kind === "admin" ? "Operator" : p.address ? "Connected wallet" : "Not signed in"),
              row("Display name", p.name || "— not set —", "Set it from Edit profile"),
              row("Address", p.address || "—", p.kind === "admin" ? "An operator session has no wallet of its own" : ""),
              row("Can change password", p.canChangePassword ? "Yes" : "No — this is a wallet login"),
              row("Operator privileges", p.isOperator ? "Yes" : "No"),
            ].join("")) +
            section("What that lets you do", [
              row("Read everything", "Yes", "All balances, pools, quotes and market data are public"),
              row("Transact with your own funds", p.address ? "Yes, via your wallet" : "Connect a wallet first"),
              row("Spend the app's agent wallet", p.isOperator ? "Yes" : "No — operator only"),
              row("Publish notices / change config", p.isOperator ? "Yes" : "No — operator only"),
            ].join(""));
          return;
        }

        if (acctTab === "positions") {
          const lnRows = ((l && l.assets) || [])
            .map((a) =>
              row(
                a.symbol,
                `${a.position.supplied} supplied · ${a.position.borrowed} borrowed`,
                `wallet ${a.position.wallet} · ${a.reserve.supplyApr}% supply APR` +
                  (a.frozen ? " · some actions frozen" : "") +
                  (a.priceOk === false ? " · price feed unavailable" : ""),
              ),
            )
            .join("");
          const ammRows = ((am && am.pools) || [])
            .map((x) => row(x.name, `${x.mySharePct}% of the pool`, x.assets.map((y) => `${y.myBalance} ${y.symbol}`).join(" · ")))
            .join("");
          host.innerHTML =
            section("Vault", v && v.ready
              ? [
                  row("Your balance", v.yourAssets + " USDC"),
                  row("Wallet available", (v.walletUsdc || "0") + " USDC"),
                  row("Vault TVL", v.totalAssets + " USDC"),
                  row("APR", v.supplyApr + "%", `${v.reserveRatioPct}% held liquid · app takes ${v.performanceFeePct}% of yield only`),
                ].join("")
              : row("Vault", "not available")) +
            section("Lending & borrowing", l && l.account
              ? [
                  row("Supplied", "$" + l.account.suppliedUsd),
                  row("Borrowed", "$" + l.account.borrowedUsd),
                  row("Borrow limit", "$" + l.account.borrowLimitUsd),
                  row("Health factor", l.account.healthFactor, "Above 1.0 is safe; below it a position can be liquidated"),
                ].join("") + lnRows
              : row("Lending", "not available")) +
            section("Liquidity pools", ammRows || row("AMM", "no position")) +
            section("Swap", sw && sw.ready
              ? sw.assets.map((a) => row(a.symbol, a.liquidity + " routable", "≈ $" + a.priceUsd)).join("")
              : row("Swap", "not available"));
          return;
        }

        if (acctTab === "activity") {
          const sum = s.summary || {};
          const t = s.treasury || {};
          host.innerHTML =
            section("Agent activity", [
              row("Settled purchases", String(sum.settled ?? 0)),
              row("Refunded", String(sum.refunded ?? 0), "SLA breach reclaimed automatically"),
              row("Skipped", String(sum.skipped ?? 0), "Declined by policy or reputation"),
              row("Spent", (sum.spentUsdc ?? "0") + " USDC"),
            ].join("")) +
            section("Agent wallet", [
              row("Balance", (t.balanceUsdc ?? "—") + " USDC"),
              row("Health", t.healthy ? "Above the low-water mark" : "Low — top it up", `low-water ${t.lowWaterUsdc ?? "—"} USDC`),
              row("Estimated runway", String(t.runwayCalls ?? "—") + " calls"),
            ].join("")) +
            `<div class="card compact"><h2>Full history</h2>` +
            `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">` +
            `Every transaction, filterable and exportable.</div>` +
            `<button class="btn primary" id="acctOpenTx">Open transaction history</button></div>`;
          const btn = $("acctOpenTx");
          if (btn) btn.addEventListener("click", () => { closeSheet("acctSheet"); openTxSheet(); });
          return;
        }

        if (acctTab === "network") {
          const live = s.live || {};
          const c = (k, addr) =>
            addr
              ? `<div class="cfgRow" style="padding:8px 0"><span>${esc(k)}</span>` +
                `<span class="mono" style="font-size:12px"><a href="${esc(live.explorer || "")}/address/${esc(addr)}" target="_blank" rel="noopener">${esc(short(addr))}</a></span></div>`
              : row(k, "not deployed");
          host.innerHTML =
            section("Network", [
              row("Chain", (s.meta && s.meta.chain) || "Arc testnet"),
              row("Chain id", String(live.chainId ?? "—")),
              row("Gas token", "USDC", "Arc settles gas in USDC, so no separate gas asset is needed"),
              row("Explorer", live.explorer || "—"),
            ].join("")) +
            section("Contracts", [
              c("Escrow", live.tesseraEscrow),
              c("Nanopayment tabs", live.tesseraTab),
              c("Lending pool", live.tesseraPool),
              c("Vault", live.tesseraVault),
              c("Router", live.tesseraRouter),
              c("AMM", live.tesseraAmm),
              c("Fee collector", live.tesseraFeeCollector),
              c("AMM fee collector", live.tesseraAmmFeeCollector),
            ].join(""));
          return;
        }

        // security
        host.innerHTML =
          section("This session", [
            row("Login type", p.kind === "admin" ? "Password (operator)" : p.address ? "Wallet signature (SIWE)" : "Not signed in"),
            row("Session expiry", "12 hours", "Both operator and wallet sessions expire and must be renewed"),
            row("Who can move your funds", p.address ? "Only you — your wallet signs" : "—",
              "The server never holds your key. Self-custody transactions are built in your browser and signed by your wallet."),
          ].join("")) +
          section("What the app protects", [
            row("Vault liquid reserve", "80% floor", "Fixed in the contract; no admin can lower it"),
            row("Vault fee", "on yield only", "Capped at 30%; principal is never charged"),
            row("AMM provider share", "50% floor", "A constant in the contract — not an admin setting"),
            row("Freeze controls", "per action", "Withdraw and repay can stay open while other actions are halted"),
            row("Price feeds", "validated", "A stale or broken feed pauses the market rather than pricing wrongly"),
            row("Position transfers", "impossible", "No contract function can move someone else's position"),
          ].join("")) +
          section("Honest limits", [
            row("Audited", "No", "Unaudited testnet software — do not use with real funds"),
            row("Operator key", "Trusted", "The deployer can set fees within caps, freeze actions and set prices where no feed is wired"),
            row("Impermanent loss", "Not eliminated", "Inherent to any constant-product AMM"),
          ].join(""));
      }

      if ($("acctSheet")) {
        document.querySelectorAll("[data-acctab]").forEach((b) =>
          b.addEventListener("click", () => setAcctTab(b.dataset.acctab)));
        $("acctClose").addEventListener("click", () => closeSheet("acctSheet"));
        $("acctRefresh").addEventListener("click", async () => { await tick(); renderAcct(); });
      }

      /* ---- App Config (operator only) ------------------------------------ */
      let cfgCadences = {};
      async function loadAppConfig() {
        try {
          const r = await (await fetch("/api/app-config", { headers: authHeaders() })).json();
          if (!r.ok) return;
          cfgCadences = r.cadences || {};
          const c = r.config;
          $("cfgReserve").value = Math.round(c.vaultReserveRatioBps / 100);
          $("cfgPerfFee").value = Math.round(c.vaultPerformanceFeeBps / 100);
          $("cfgFeeAgent").value = Math.round(c.feeShares.agentBps / 100);
          $("cfgFeeLending").value = Math.round(c.feeShares.lendingBps / 100);
          $("cfgFeeVault").value = Math.round(c.feeShares.vaultBps / 100);
          $("cfgFeeSwap").value = Math.round(c.feeShares.swapBps / 100);
          $("cfgFeeRetained").value = Math.round(c.feeShares.retainedBps / 100);
          $("cfgCadence").value = c.feeIntervalLabel in (r.cadences || {}) ? c.feeIntervalLabel : "week";
          $("cfgEvery").value = String(c.feeIntervalEvery || 1);
          showEffectiveCadence(r.effectiveIntervalSeconds);
          $("cfgMode").value = c.feeScheduleMode || "interval";
          $("cfgWeekday").value = String(c.feeWeekday ?? 1);
          $("cfgTime").value = c.feeTimeUtc || "09:00";
          if ($("cfgMaxReserves")) $("cfgMaxReserves").value = String(c.maxVisibleReserves ?? 0);
          if ($("cfgMaxAmmPools")) $("cfgMaxAmmPools").value = String(c.maxVisibleAmmPools ?? 0);
          syncScheduleRows(r.schedule && r.schedule.nextRunUtc);
          $("cfgNote").textContent =
            ((r.enforced && r.enforced.note) || "") +
            (r.onchainWrites ? "" : " Saving stores locally only — DEPLOYER_PRIVATE_KEY isn't set, so changes can't reach the contracts.");
        } catch {}
      }
      // Show only the fields the chosen trigger actually uses.
      function syncScheduleRows(nextRunUtc) {
        const mode = $("cfgMode").value;
        $("cfgRowInterval").style.display = mode === "interval" ? "" : "none";
        $("cfgRowEffective").style.display = mode === "interval" ? "" : "none";
        $("cfgRowWeekday").style.display = mode === "weekly" ? "" : "none";
        $("cfgRowTime").style.display = mode === "weekly" ? "" : "none";
        $("cfgRowNext").style.display = mode === "weekly" && nextRunUtc ? "" : "none";
        if (nextRunUtc) {
          const d = new Date(nextRunUtc);
          $("cfgNextRun").textContent = d.toUTCString().replace(" GMT", " UTC");
        }
      }
      // Show the cadence in plain words, e.g. "every 3 days (259200s)".
      function showEffectiveCadence(seconds) {
        const el = $("cfgEffective");
        if (!el) return;
        const n = Math.max(1, parseInt(($("cfgEvery") && $("cfgEvery").value) || "1", 10));
        const unit = ($("cfgCadence") && $("cfgCadence").value) || "week";
        const secs = seconds != null ? seconds : (cfgCadences[unit] || 604800) * n;
        el.textContent = `every ${n === 1 ? "" : n + " "}${unit}${n === 1 ? "" : "s"} (${secs}s)`;
      }
      if ($("cfgEvery")) $("cfgEvery").addEventListener("input", () => showEffectiveCadence());
      if ($("cfgCadence")) $("cfgCadence").addEventListener("change", () => showEffectiveCadence());
      if ($("cfgMode")) $("cfgMode").addEventListener("change", () => { syncScheduleRows(null); showEffectiveCadence(); });

      if ($("cfgSave")) {
        $("cfgSave").addEventListener("click", async () => {
          const msg = $("cfgMsg");
          const label = $("cfgCadence").value;
          const body = {
            vaultReserveRatioBps: Math.round(+$("cfgReserve").value * 100),
            vaultPerformanceFeeBps: Math.round(+$("cfgPerfFee").value * 100),
            feeShares: {
              agentBps: Math.round(+$("cfgFeeAgent").value * 100),
              lendingBps: Math.round(+$("cfgFeeLending").value * 100),
              vaultBps: Math.round(+$("cfgFeeVault").value * 100),
              swapBps: Math.round(+$("cfgFeeSwap").value * 100),
              retainedBps: Math.round(+$("cfgFeeRetained").value * 100),
            },
            feeIntervalSeconds: (cfgCadences[label] || 604800) * Math.max(1, parseInt($("cfgEvery").value || "1", 10)),
            feeIntervalLabel: label,
            feeIntervalEvery: Math.max(1, parseInt($("cfgEvery").value || "1", 10)),
            feeScheduleMode: $("cfgMode").value,
            feeWeekday: Number($("cfgWeekday").value),
            feeTimeUtc: $("cfgTime").value || "09:00",
            maxVisibleReserves: Math.max(0, parseInt($("cfgMaxReserves").value || "0", 10)),
            maxVisibleAmmPools: Math.max(0, parseInt($("cfgMaxAmmPools").value || "0", 10)),
          };
          msg.style.display = "block";
          try {
            const r = await (await postAuthed("/api/app-config", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })).json();
            if (!r.ok) {
              msg.style.color = "var(--warn)";
              msg.textContent = r.error;
            } else {
              // Report what actually reached the chain, not just "saved" — a
              // saved-but-unpushed ratio would behave differently than shown.
              const legs = r.onchain || [];
              const failed = legs.filter((l) => !l.ok);
              const landed = legs.filter((l) => l.ok).map((l) => l.target);
              if (!legs.length) {
                msg.style.color = "var(--good)";
                msg.textContent = "Config saved ✓ (no on-chain contracts to update yet)";
              } else if (!failed.length) {
                msg.style.color = "var(--good)";
                msg.textContent = "Config saved and pushed on-chain ✓ — " + landed.join(", ");
                syncScheduleRows(r.schedule && r.schedule.nextRunUtc);
                afterTx(); // vault reserve/fee copy updates immediately
              } else {
                msg.style.color = "var(--warn)";
                msg.textContent =
                  "Config saved" + (landed.length ? " · on-chain: " + landed.join(", ") : "") +
                  " · not pushed: " + failed.map((l) => `${l.target} (${l.error})`).join("; ");
              }
            }
          } catch {
            msg.style.color = "var(--warn)";
            msg.textContent = "Couldn't save the config.";
          }
        });
      }
      if ($("cfgAllocate")) {
        $("cfgAllocate").addEventListener("click", async () => {
          const msg = $("cfgMsg");
          msg.style.display = "block";
          msg.style.color = "var(--muted)";
          msg.textContent = "Allocating collected fees…";
          try {
            const r = await (await postAuthed("/api/fees/allocate")).json();
            msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
            msg.textContent = r.ok ? "Fees allocated ✓" : r.error;
            if (r.ok) afterTx();
          } catch {
            msg.style.color = "var(--warn)";
            msg.textContent = "Allocation request failed.";
          }
        });
      }

      // Reflect any existing session as soon as the page loads.
      refreshProfile();

      refreshMyPositions().catch(() => {});

      // Land on whatever the hash asks for (default: the landing page).
      showView(routeFromHash());

      /* Live updates without a manual refresh:
       *  - refresh as soon as the tab regains focus / becomes visible
       *  - refresh right after any action (each handler already calls tick())
       *  - refresh when the wallet switches account or chain
       * The polling loop below is the steady-state backstop.
       */
      document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
      // Keep the user's own figures in step with the agent-state refresh.
      setInterval(() => { refreshMyPositions().catch(() => {}); }, 12000);
      window.addEventListener("focus", () => tick());
      window.addEventListener("online", () => tick());
      if (eth() && eth().on) {
        eth().on("accountsChanged", () => tick());
        eth().on("chainChanged", () => tick());
      }

      // Poll interval is driven by the server (slower in live mode to spare the
      // rate-limited public RPC). Re-schedule when the advertised cadence changes.
      let curPoll = 0;
      let pollTimer = null;
      function schedulePoll(ms) {
        if (ms === curPoll) return;
        curPoll = ms;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(tick, ms);
      }
      (async () => { await tick(); })();
      schedulePoll(800);
