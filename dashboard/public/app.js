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
      const TABS = ["dashboard", "defi", "agents", "gov", "other"];
      // Plain names: the icons live in the drawer markup as SVG now, so the
      // labels no longer smuggle a glyph that would end up in the tab title.
      const NAV_LABELS = {
        home: "Home",
        dashboard: "Dashboard",
        defi: "DeFi",
        agents: "Agent workspace",
        gov: "Governance",
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
          // Governance reads a loop of contract calls, so it loads on arrival
          // rather than on every poll of every other tab.
          if (route === "agents" && typeof loadFeeCredit === "function") loadFeeCredit().catch(() => {});
          if (route === "gov" && typeof loadGovernance === "function") {
            loadGovernance().catch(() => {});
            if (typeof loadGauge === "function") loadGauge().catch(() => {});
            if (typeof loadRegistry === "function") loadRegistry().catch(() => {});
            if (typeof loadDiscussions === "function") loadDiscussions().catch(() => {});
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
        /*
         * Drop the signer's cached position before re-reading it.
         *
         * The panel kept showing the pre-transaction numbers after a withdraw:
         * `refreshMyPositions` did run, but the render it triggers reads
         * `window.__myPos`, and the stale entry was still there for the whole
         * round trip — so the first paint after the transaction was the old
         * value, and nothing forced a second one once the read landed.
         *
         * Clearing first means the panel briefly falls back to the server's
         * figures rather than confidently showing a number that is no longer
         * true.
         */
        window.__myPos = {};
        window.__myBal = {};
        // The account totals move with every one of these actions too — a
        // borrow eats headroom, a supply creates it.
        window.__myAccount = null;
        tick({ fresh: true });
        refreshMyPositions().catch(() => {});
        // A deposit or withdrawal changes the leaderboard and may have moved
        // fees, so both cached views are stale. Only the visible venue is
        // re-scanned — re-running all four log sweeps would be gratuitous.
        feeDailyCache = null;
        setTimeout(() => {
          tick({ fresh: true });
          refreshMyPositions().catch(() => {});
          if (defiTab === "lending" && typeof loadBorrowers === "function") loadBorrowers();
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
        // And the connected wallet beside it. The agent's balance is the app's
        // money; a signed-in user looking at this card wants to know their own,
        // and had no way to see it without opening a wallet.
        (async () => {
          const card = $("myWalletCard");
          if (!card) return;
          const addr = String(window.__myAddress || "");
          const grid = card.parentElement;
          if (!selfMode() || !addr) {
            card.style.display = "none";
            if (grid) grid.classList.remove("hasWallet");
            return;
          }
          if (grid) grid.classList.add("hasWallet");
          const cfg = await loadDefiConfig().catch(() => null);
          const bal = cfg ? await myTokenBalance(cfg.usdc || cfg.vaultAsset) : null;
          card.style.display = "";
          $("myWalletBal").innerHTML = bal === null
            ? '<span class="muted">unavailable</span>'
            : esc(fmtUnitsStr(bal, 6)) + '<span class="u">USDC</span>';
          // The full address, not a truncation. This is the card that answers
          // "which wallet is this?", and half an address answers it halfway.
          $("myWalletAddr").textContent = addr;
        })();
        if ($("myWalletCopy") && !$("myWalletCopy").dataset.wired) {
          $("myWalletCopy").dataset.wired = "1";
          $("myWalletCopy").addEventListener("click", async () => {
            const btn = $("myWalletCopy"), addr = String(window.__myAddress || "");
            if (!addr) return;
            try {
              await navigator.clipboard.writeText(addr);
            } catch {
              // A wallet browser may withhold the clipboard; select it instead
              // so a long-press can copy, rather than failing in silence.
              const r = document.createRange();
              r.selectNodeContents($("myWalletAddr"));
              const selNow = window.getSelection();
              selNow.removeAllRanges();
              selNow.addRange(r);
            }
            const was = btn.textContent;
            btn.textContent = "Copied";
            setTimeout(() => { btn.textContent = was; }, 1200);
          });
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
        // Never store "" here: every consumer wrote `explorer || ""`, so an
        // empty value produced a *relative* href — "/tx/0x…" on tesra.xyz,
        // which is a 404 rather than a block explorer. Fall back to Arcscan.
        window.__explorer = (s.live && s.live.explorer) || "https://testnet.arcscan.app";

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
          // `ln.account` is the *agent's* account. With a wallet connected these
          // three lines belong to the signer, and refreshMyPositions marks them
          // as theirs — so the poll must not paint over them, which is exactly
          // what "Supplied $0.00" next to "your position: 1 USDC" was.
          setUnlessMine("lnSupplied", "$" + ln.account.suppliedUsd);
          setUnlessMine("lnBorrowed", "$" + ln.account.borrowedUsd);
          setUnlessMine("lnLimit", "$" + ln.account.borrowLimitUsd);
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
          /*
           * Two very different situations reach this branch, and telling them
           * apart is the difference between a dead end and one tap.
           *
           * Somebody with a wallet right there does not need an admin
           * password; they need self-custody switched on. Sending them to the
           * Admin button was what made the vault, the swap desk and the
           * liquidity pools look agent-only to a connected user — every one of
           * them already has a working self-custody path.
           */
          const t = $("selfCustodyToggle");
          if (typeof hasInjectedWallet === "function" && hasInjectedWallet() && t && !t.checked) {
            if (confirm(
              "This went to the app's agent wallet, which is operator-only.\n\n" +
              "You have a wallet connected, so you can do this with your own funds instead — " +
              "switch on \"Use my own wallet\" and try again?\n\nOK turns it on for you.",
            )) {
              t.checked = true;
              t.dispatchEvent(new Event("change"));
            }
          } else {
            alert(
              "This action spends the agent's own wallet, so it's operator-only — sign in with the Admin button.\n\n" +
                "Connect a wallet and switch on \"Use my own wallet\" to transact with your own funds instead.",
            );
          }
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
        /*
         * Already connected? Open the profile instead of asking again.
         *
         * The button ran the whole sign-in every tap: request accounts, fetch a
         * nonce, personal_sign. So touching it after connecting produced another
         * signature prompt for no reason — which trains people to approve
         * signature requests without reading them, the precise habit that gets
         * wallets drained.
         */
        if (window.__myAddress && localStorage.getItem("tessera_token")) {
          $("profileBtn").click();
          return;
        }
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
            if (typeof loadAllowances === "function") loadAllowances().catch(() => {});
          } else {
            alert("Sign-in failed: " + r.error);
          }
        } catch (e) {
          /*
           * "Cancelled or failed" covers two situations that need opposite
           * responses, and after a wallet decides a site is spamming it, the
           * one it hides is the one that matters: the site is *blocked*, and no
           * amount of tapping Connect will get past it — the permission has to
           * be given back in the wallet's own settings. Saying so is the
           * difference between a fixable state and a dead button.
           */
          alert(walletError(e));
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

      /* ---- Market table: every reserve at once ----------------------------
       *
       * The panel below acts on one asset at a time, chosen from a select box.
       * That is fine for acting and useless for deciding — you cannot compare
       * what three reserves pay without opening the box three times. This table
       * is the index: it lists every reserve with the number people actually
       * came for, and a tap on a row points the action panel at it.
       */
      let lnMarketSide = "supply"; // which of the two tabs is showing
      window.__emissions = null;

      function setMarketSide(side) {
        lnMarketSide = side === "borrow" ? "borrow" : "supply";
        const sup = $("lnTabSupply"), bor = $("lnTabBorrow");
        if (sup && bor) {
          sup.classList.toggle("primary", lnMarketSide === "supply");
          bor.classList.toggle("primary", lnMarketSide === "borrow");
        }
        const t = $("lnMarketTitle");
        if (t) t.textContent = lnMarketSide === "supply" ? "Assets to supply" : "Assets to borrow";
        const c = $("lnMarketCol");
        if (c) c.textContent = lnMarketSide === "supply" ? "Wallet balance" : "Available";
        // Point the action panel at the same side, so the two agree.
        const act = $("lnAction");
        if (act) {
          act.value = lnMarketSide === "supply" ? "supply" : "borrow";
          act.dispatchEvent(new Event("change"));
        }
        renderMarket();
      }
      if ($("lnTabSupply")) $("lnTabSupply").addEventListener("click", () => setMarketSide("supply"));
      if ($("lnTabBorrow")) $("lnTabBorrow").addEventListener("click", () => setMarketSide("borrow"));

      /** Emission APR for one asset and side, or null when it cannot be valued. */
      function emissionApr(address, side) {
        const em = window.__emissions;
        if (!em || !em.configured) return null;
        const row = (em.assets || []).find(
          (r) => String(r.address).toLowerCase() === String(address).toLowerCase(),
        );
        if (!row) return null;
        const apr = side === "supply" ? row.supplyApr : row.borrowApr;
        const rate = side === "supply" ? row.supplyRatePerSecond : row.borrowRatePerSecond;
        if (BigInt(rate || "0") === 0n) return null;
        // A rate with no APR is a reward nobody can price — say that rather
        // than printing a percentage derived from a guess.
        return { apr, unpriced: apr === null };
      }

      window.renderMarket = function renderMarket() {
        const body = $("lnMarketRows");
        if (!body) return;
        const ln = window.__lending;
        if (!ln || !ln.assets || !ln.assets.length) {
          body.innerHTML = emptyRow(4, "No reserves yet.");
          return;
        }
        const side = lnMarketSide;
        let totalUsd = 0;

        body.innerHTML = ln.assets
          .map((a) => {
            const dec = Number(a.decimals ?? 6);
            const priceE8 = Number(a.priceE8 || 0) / 1e8;
            const cash = BigInt((a.reserve && a.reserve.cashRaw) || "0");
            const supplied = a.reserve ? Number(a.reserve.cash) + Number(a.reserve.borrows) : 0;
            totalUsd += supplied * priceE8;

            // Supply side shows what you could put in; borrow side what the
            // reserve can actually lend. Those are different questions.
            const key = String(a.address || "").toLowerCase();
            const mine = window.__myBal[key];
            const amount = side === "supply"
              ? (mine !== undefined && mine !== null ? fmtUnitsStr(BigInt(mine), dec) : (a.position && a.position.wallet) || "—")
              : fmtUnitsStr(cash, dec);

            const rate = side === "supply" ? a.reserve && a.reserve.supplyApr : a.reserve && a.reserve.borrowApr;
            const em = emissionApr(a.address, side);
            const badge = em
              ? em.unpriced
                ? `<div><span class="tag ok" style="font-size:10px"><span class="tsraIcon"></span> rewards</span></div>`
                : `<div><span class="tag ok" style="font-size:10px"><span class="tsraIcon"></span> +${esc(Number(em.apr).toFixed(2))}%</span></div>`
              : "";
            const disabled = side === "borrow" && !a.borrowable;
            return (
              `<tr data-market="${esc(a.symbol)}" style="cursor:pointer${disabled ? ";opacity:.55" : ""}">` +
              `<td><b>${esc(a.symbol)}</b>${a.enabled === false ? ' <span class="tag warn" style="font-size:10px">unavailable</span>' : ""}` +
              `<div class="muted" style="font-size:11px">$${esc(a.priceUsd)}</div></td>` +
              `<td class="num mono">${esc(amount)}</td>` +
              `<td class="num"><b>${esc(rate ?? "—")}%</b>${badge}</td>` +
              `<td class="num muted">›</td></tr>`
            );
          })
          .join("");

        const size = $("lnMarketSize");
        if (size) size.textContent = "$" + totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 });

        body.querySelectorAll("[data-market]").forEach((tr) => {
          tr.addEventListener("click", () => {
            const sel = $("lnAsset");
            if (!sel) return;
            sel.value = tr.dataset.market;
            sel.dispatchEvent(new Event("change"));
            // Scroll the action panel into view: on a phone the row that was
            // tapped and the form it drives are a screen apart.
            const amt = $("lnAmount");
            if (amt) amt.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        });
      };

      /** Rewards: what is streaming, and what this wallet can take. */
      async function loadEmissions() {
        const card = $("lnEmissions");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/lending/emissions" + q)).json();
          window.__emissions = r && r.ok ? r : null;
          if (!r || !r.ok || !r.deployed || !r.configured) { card.style.display = "none"; renderMarket(); return; }
          card.style.display = "";
          $("lnEmAmount").textContent = r.yourClaimable ?? "0";
          $("lnEmSymbol").textContent = r.reward.symbol;
          const runway = r.reward.runwayDays;
          $("lnEmNote").textContent =
            `Pot: ${r.reward.balance} ${r.reward.symbol}` +
            (runway == null ? " · nothing streaming" : ` · about ${runway.toFixed(1)} days left at the current rates`) +
            (r.reward.priced ? "" : " · no market price for the reward, so rows show a rate rather than an APY") +
            `. Paid out all time: ${r.reward.claimedAllTime}.`;
          $("lnEmClaim").disabled = !(BigInt(r.yourClaimableRaw || "0") > 0n);
          // Say it in the panel too: an APR next to a paused market is a lie
          // the rate itself cannot tell you about.
          if (r.paused) {
            $("lnEmNote").textContent =
              "Paused — nothing is accruing right now. What you have already earned is still yours and still claimable. " +
              $("lnEmNote").textContent;
          }
          const tag = $("govEmPausedTag");
          if (tag) {
            tag.textContent = r.paused ? "paused" : "running";
            tag.className = r.paused ? "tag warn" : "tag ok";
          }
          const btn = $("govEmPause");
          if (btn) btn.textContent = r.paused ? "Resume lending" : "Pause lending";
          renderMarket();
        } catch {
          card.style.display = "none";
        }
      }

      if ($("lnEmClaim")) {
        $("lnEmClaim").addEventListener("click", async () => {
          const em = window.__emissions;
          if (!em || !em.configured) return;
          // Only the streams with something in them: claiming an empty one
          // costs gas and reverts the whole call.
          const rows = (em.assets || []).filter(
            (a) => BigInt(a.claimableSupply || "0") > 0n || BigInt(a.claimableBorrow || "0") > 0n,
          );
          const assets = [], sides = [];
          for (const a of rows) {
            if (BigInt(a.claimableSupply || "0") > 0n) { assets.push(a.address); sides.push(0); }
            if (BigInt(a.claimableBorrow || "0") > 0n) { assets.push(a.address); sides.push(1); }
          }
          if (!assets.length) {
            const m = $("lnEmMsg");
            m.style.display = "block"; m.style.color = "var(--warn)";
            m.textContent = "Nothing has accrued to claim yet.";
            return;
          }
          if (!selfMode()) {
            const m = $("lnEmMsg");
            m.style.display = "block"; m.style.color = "var(--warn)";
            m.textContent = "Rewards are paid to whoever earned them, so this needs your own wallet. " +
              "Switch on \"Use my own wallet\".";
            return;
          }
          const btn = $("lnEmClaim");
          btn.disabled = true;
          await selfCustody("lnEmMsg", `claim ${em.yourClaimable} ${em.reward.symbol}`, async (from, cfg) =>
            sendTx(
              from, cfg.emissions,
              // claim(address[],uint8[]): two dynamic arrays, so the head holds
              // an offset to each. First tail starts after two head words.
              callData(
                cfg.selectors.emClaim,
                encUint(64),
                encUint(64 + 32 + assets.length * 32),
                encArray(assets.map((a) => BigInt(a))),
                encArray(sides.map((x) => BigInt(x))),
              ),
            ),
          );
          btn.disabled = false;
          loadEmissions();
        });
      }

      // --- Lending: multi-asset supply / withdraw / borrow / repay ------------
      function selectedLendingAsset() {
        const ln = window.__lending;
        if (!ln) return null;
        return ln.assets.find((a) => a.symbol === $("lnAsset").value) || ln.assets[0];
      }
      /**
       * Parse a typed amount into the asset's raw integer — or say why not.
       *
       * The old version fed whatever was in the box straight to `BigInt`, and
       * the guard in front of it was `Number(v) <= 0`. `Number("abc")` is NaN
       * and `NaN <= 0` is false, so "abc" sailed through and `BigInt("abc")`
       * threw inside an async click handler: no message, no failed state, the
       * button simply did nothing. "-1" was worse — it parsed, and produced a
       * negative that `encUint` padded into malformed calldata which the wallet
       * was then asked to sign.
       *
       * Returns `{ raw }` or `{ error }`; never throws, never returns both.
       */
      function parseAmount(human, decimals) {
        const s = String(human == null ? "" : human).trim().replace(/,/g, "");
        if (!s) return { error: "Enter an amount." };
        if (!/^\d*(\.\d*)?$/.test(s) || s === ".") {
          return { error: `"${s}" is not an amount. Use digits, like 12.5.` };
        }
        const dec = Number(decimals) || 0;
        const [i, f = ""] = s.split(".");
        if (f.length > dec) {
          return { error: `This asset has ${dec} decimal places — round to ${dec}.` };
        }
        const frac = (f + "0".repeat(dec)).slice(0, dec);
        const raw = BigInt(i || "0") * 10n ** BigInt(dec) + BigInt(frac || "0");
        if (raw <= 0n) return { error: "Enter an amount greater than zero." };
        return { raw: raw.toString() };
      }
      // Convert a human amount string to the asset's raw integer (string), no
      // floats. Throws on anything `parseAmount` rejects — call sites that can
      // show a message should use `parseAmount` directly.
      function toRaw(human, decimals) {
        const r = parseAmount(human, decimals);
        if (r.error) throw new Error(r.error);
        return r.raw;
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
        /*
         * Re-apply the connected wallet's caps on every render.
         *
         * `fillMax` used to patch the asset object it was handed, which worked
         * exactly until the next `/api/state` poll replaced that object with a
         * fresh one carrying the agent's numbers again — so the field showed the
         * right balance for a second and then jumped back to 520. Patching the
         * object was never going to hold; the caps have to be re-derived from
         * the wallet cache each time the panel draws.
         */
        if (selfMode() && a.address) {
          const key = String(a.address).toLowerCase();
          const raw = window.__myBal[key];
          const pos = window.__myPos[key];
          const dec = Number(a.decimals ?? 6);
          if (raw !== undefined && raw !== null) {
            const bal = BigInt(raw);
            a.max = { ...a.max, supply: fmtUnitsStr(bal, dec), supplyRaw: bal.toString() };
            // Repaying is bounded by the wallet *and* by what you owe.
            const debt = pos ? BigInt(pos.borrowed || "0") : BigInt(a.max.repayRaw || "0");
            const rep = debt < bal ? debt : bal;
            a.max.repay = fmtUnitsStr(rep, dec);
            a.max.repayRaw = rep.toString();
          }
          // Free liquidity in the reserve, which caps both withdrawing and
          // borrowing no matter whose account is asking.
          const cash = BigInt((a.reserve && a.reserve.cashRaw) || "0");
          const acctPre = window.__myAccount;
          const priceRaw = BigInt(a.priceE8 || "0");
          const cFactor = BigInt(a.cFactorBps || 0);
          /*
           * A "Max" that lands exactly on the liquidation boundary always
           * reverts, because the boundary moves between the read and the block.
           *
           * Interest accrues every second. Borrowing the whole headroom puts
           * the health factor at exactly 1.0 at the moment of the read, and by
           * the time the transaction is mined the debt has grown — so the pool
           * refuses it. Same for withdrawing the last unit of collateral that
           * is holding a loan up. Leaving half a percent turns a Max that
           * always fails into one that always works.
           */
          const SAFE_NUM = 995n, SAFE_DEN = 1000n;
          if (pos) {
            const mineSup = BigInt(pos.supplied || "0");
            let wd = cash > 0n && cash < mineSup ? cash : mineSup;
            /*
             * Collateral holding up a loan cannot all come out.
             *
             * The cap was your supply capped by pool cash — with no reference
             * to your own debt. Supply 5 and borrow 4, and it offered to
             * withdraw all 5, which drops the borrow limit under the debt and
             * reverts the whole transaction.
             *
             * Withdrawing Δ of this asset lowers the borrow limit by
             * Δ × price × cFactor, so the most that may leave is the headroom
             * divided by that weight.
             */
            const owed = acctPre && acctPre.liability != null
              ? BigInt(acctPre.liability)
              : acctPre ? BigInt(acctPre.borrowValue || "0") : 0n;
            if (owed > 0n && priceRaw > 0n && cFactor > 0n) {
              const limit = acctPre ? BigInt(acctPre.borrowLimit || "0") : 0n;
              const head = limit > owed ? limit - owed : 0n;
              const byDebt = (head * 10n ** BigInt(dec) * 10_000n) / (priceRaw * cFactor);
              const safe = (byDebt * SAFE_NUM) / SAFE_DEN;
              if (safe < wd) wd = safe;
            }
            a.max.withdraw = fmtUnitsStr(wd, dec);
            a.max.withdrawRaw = wd.toString();
            a.position = {
              ...a.position,
              supplied: fmtUnitsStr(mineSup, dec),
              borrowed: fmtUnitsStr(BigInt(pos.borrowed || "0"), dec),
            };
          }
          /*
           * Borrow is bounded by *your* headroom, not the agent's.
           *
           * This was the last cap still coming from the server, and it read
           * zero for the same reason "max withdraw" did: the agent has no
           * collateral, so the agent has no headroom, so a user who had just
           * supplied 5 USDC was told they could borrow nothing.
           *
           * Headroom is (borrowLimit - borrowValue) in the pool's 1e8 USD
           * scale — the pool has already applied each collateral's factor when
           * it computed the limit — converted at this asset's mark and then
           * capped by what the reserve actually holds.
           */
          const acct = window.__myAccount;
          const priceE8 = BigInt(a.priceE8 || "0");
          if (acct && priceE8 > 0n) {
            let cap = 0n;
            if (a.borrowable) {
              const limit = BigInt(acct.borrowLimit || "0");
              // `liability`, not `borrowValue` — see refreshMyPositions. This
              // one substitution is the difference between a Max that always
              // reverts and one that lands.
              const owed = acct.liability != null ? BigInt(acct.liability) : BigInt(acct.borrowValue || "0");
              const headroom = limit > owed ? limit - owed : 0n;
              /*
               * Borrowing x of this asset raises liability by
               * value(x) / lFactor, so the headroom buys `lFactor` times more
               * of it than a naive division by the price suggests. Then half a
               * percent off the top, because interest moves the boundary
               * between this read and the block that mines the borrow.
               */
              const lF = BigInt(a.lFactorBps || 10_000);
              cap = (headroom * 10n ** BigInt(dec) * lF * SAFE_NUM) / (priceE8 * 10_000n * SAFE_DEN);
              if (cash < cap) cap = cash;
            }
            a.max.borrow = fmtUnitsStr(cap, dec);
            a.max.borrowRaw = cap.toString();
          }
        }
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
        /*
         * Say *why* a cap is zero. "max borrow: 0" against a panel that shows
         * 5 USDC supplied reads as a bug, and the three reasons it can happen
         * are entirely different problems: nothing deposited, a reserve that
         * cannot be borrowed, or a pool with no free cash.
         */
        let why = "";
        if (String(max) === "0" || Number(String(max).replace(/,/g, "")) === 0) {
          const cash = BigInt((a.reserve && a.reserve.cashRaw) || "0");
          if (action === "borrow") {
            why = !a.borrowable
              ? " — this reserve is not borrowable"
              : cash === 0n
                ? " — the reserve has no free liquidity to lend right now"
                : " — supply collateral first, or repay to free up headroom";
          } else if (action === "withdraw") {
            why = cash === 0n
              ? " — the reserve has no free liquidity; borrowers must repay first"
              : " — you have not supplied any " + a.symbol;
          } else if (action === "repay") {
            why = " — you have no " + a.symbol + " debt to repay";
          } else if (action === "supply") {
            why = " — your wallet holds no " + a.symbol;
          }
        }
        if (typeof renderMarket === "function") renderMarket();
        $("lnMaxHint").textContent = "max " + action + ": " + max + " " + a.symbol +
          (action === "borrow" && !a.borrowable ? " (not borrowable)" : "") + why;
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
      // Asset address (lowercase) -> the connected wallet's raw balance.
      // Filled by refreshMyPositions, read synchronously by renderLendingAsset.
      window.__myBal = window.__myBal || {};
      // asset -> { supplied, borrowed } for the *signer*, raw strings.
      window.__myPos = window.__myPos || {};
      // The signer's account totals in the pool's 1e8 USD scale, as raw
      // strings: { supplyValue, borrowValue, borrowLimit }. This is what a
      // borrow cap is actually made of, and it belongs to whoever is signing —
      // the server's `max.borrow` is the *agent's* headroom, which is why
      // somebody with 5 USDC of collateral was offered a maximum borrow of 0.
      window.__myAccount = window.__myAccount || null;

      async function myTokenBalance(token) {
        try {
          if (!selfMode() || !eth()) return null;
          const [from] = await eth().request({ method: "eth_accounts" });
          if (!from) return null;
          if (!(await onArc())) return null; // unknown, not zero
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
          /*
           * Refresh the whole cache, then let the normal render apply it — one
           * path for the number, so Max and the hint cannot disagree.
           *
           * All four caps now come from the signer, and three of them are not
           * made of the wallet balance: withdraw needs the supply, repay needs
           * the debt, borrow needs the account's headroom. Refreshing only the
           * balance left those three reading whatever the last poll happened
           * to leave behind.
           */
          if (selfMode() && a.address) {
            await refreshMyPositions().catch(() => {});
            const bal = await myTokenBalance(a.address);
            if (bal !== null) window.__myBal[String(a.address).toLowerCase()] = bal.toString();
          }
          renderLendingAsset();
          const fresh = selectedLendingAsset() || a;
          const action = $("lnAction").value;
          $("lnAmount").value = fresh.max[action] || "0";
          $("lnAmount").dataset.raw = fresh.max[action + "Raw"] || "";
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
        const parsed = parseAmount(human, a.decimals);
        if (parsed.error) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = parsed.error + " (Or tap Max.)";
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
            // One parser for the whole page: the second copy that used to live
            // here disagreed with `toRaw` on leading dots and on negatives.
            const want = BigInt($("lnAmount").dataset.raw || parsed.raw);
            if (want > bal) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent =
                `Your wallet holds ${fmtUnitsStr(bal, dec)} ${a.symbol}. ` +
                `Lower the amount, or tap Max to use all of it.`;
              return;
            }
          }
        }
        /*
         * Withdrawing more than you supplied is the same failure the other way
         * round, and it has the same cure: the position is already cached, so
         * saying so costs nothing and beats an opaque revert.
         */
        if (selfMode() && action === "withdraw") {
          const pos = window.__myPos[String(a.address).toLowerCase()];
          if (pos) {
            const dec = Number(a.decimals ?? 6);
            const mine = BigInt(pos.supplied || "0");
            const want = BigInt($("lnAmount").dataset.raw || parsed.raw);
            if (want > mine) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent = mine === 0n
                ? `You have not supplied any ${a.symbol} to withdraw.`
                : `You supplied ${fmtUnitsStr(mine, dec)} ${a.symbol}. Lower the amount, or tap Max.`;
              return;
            }
          }
        }
        /*
         * Borrowing past your limit reverts with `Unhealthy`, which tells the
         * user nothing about how much they could have taken. The cap is
         * already on screen — check against it and quote the number.
         */
        if (selfMode() && action === "borrow") {
          const cap = BigInt(a.max.borrowRaw || "0");
          const want = BigInt($("lnAmount").dataset.raw || parsed.raw);
          if (want > cap) {
            const dec = Number(a.decimals ?? 6);
            msg.style.display = "block"; msg.style.color = "var(--warn)";
            msg.textContent = cap === 0n
              ? `You cannot borrow ${a.symbol} yet — supply collateral first, or check the reserve has free liquidity.`
              : `Your borrow limit allows ${fmtUnitsStr(cap, dec)} ${a.symbol}. Lower the amount, or tap Max.`;
            return;
          }
        }
        // Use the exact raw when the field is an untouched Max; else the parse.
        const raw = $("lnAmount").dataset.raw || parsed.raw;
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
          // innerHTML, because the receipt now carries a link. `txLink` refuses
          // anything that is not a 32-byte hash, and the rest is escaped.
          if (r.ok) msg.innerHTML = `${esc(action)} ${esc(human)} ${esc(a.symbol)} ✓ — view on Arcscan: ${txLink(r.txHash)}`;
          else msg.textContent = `failed: ${r.error}`;
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
        } else if (selfMode()) {
          /*
           * `vt.maxWithdraw` is the *agent's* redeemable balance. Offering it
           * to a connected user is the same mistake the lending panel made:
           * two true numbers about two different people. Read the signer's own
           * claim on the vault instead, and only fall back when it can't be
           * read — a stale agent figure is worse than none.
           */
          const cfg0 = await loadDefiConfig().catch(() => null);
          let mine = null;
          if (cfg0 && cfg0.vault && (await onArc())) {
            try {
              const [from] = await eth().request({ method: "eth_accounts" });
              if (from) {
                const hex = await ethCall(cfg0.vault, callData(cfg0.selectors.balanceOfAssets, encAddr(from)));
                mine = BigInt(hex || "0x0");
              }
            } catch { mine = null; }
          }
          $("vAmount").value = mine !== null ? fmtUnitsStr(mine, 6) : "";
          if (mine === null) {
            const m = $("vaultMsg");
            m.style.display = "block"; m.style.color = "var(--warn)";
            m.textContent = "Could not read your vault balance — check your wallet is connected to Arc.";
          }
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
        const parsed = parseAmount(human, vt.decimals);
        if (parsed.error) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = parsed.error + " (Or tap Max.)"; return;
        }
        const raw = parsed.raw;
        /*
         * The same pre-flight the lending panel got, which the vault never did.
         * Depositing more USDC than you hold reverts, and the UI reported
         * success because it was reporting that a request had been sent.
         */
        if (selfMode() && action === "deposit") {
          const cfg0 = await loadDefiConfig().catch(() => null);
          const bal = cfg0 ? await myTokenBalance(cfg0.vaultAsset || cfg0.usdc) : null;
          if (bal !== null && BigInt(raw) > bal) {
            msg.style.display = "block"; msg.style.color = "var(--warn)";
            msg.textContent =
              `Your wallet holds ${fmtUnitsStr(bal, 6)} USDC. Lower the amount, or tap Max to use all of it.`;
            return;
          }
        }
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
          if (r.ok) msg.innerHTML = `${esc(action)} ${esc(human)} USDC ✓ — view on Arcscan: ${txLink(r.txHash)}`;
          else msg.textContent = `failed: ${r.error}`;
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
        // In self-custody mode prefer the connected wallet's own balance —
        // keyed by the asset on screen, so flipping the pair cannot leave the
        // other token's figure sitting under the new symbol.
        const cached = window.__myBal[String(ai.address || "").toLowerCase()];
        const mine = cached !== undefined && cached !== null
          ? fmtUnitsStr(BigInt(cached), Number(ai.decimals ?? 6))
          : null;
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
        const parsed = parseAmount(human, s.decIn);
        if (parsed.error) {
          // Only complain about text that is actually wrong; an empty box is
          // just somebody who hasn't typed yet.
          $("swQuoteOut").textContent = human ? parsed.error : "";
          return null;
        }
        // The same-asset hint already appears under the pickers; don't repeat it.
        if (s.tokenIn === s.tokenOut) { $("swQuoteOut").textContent = ""; return null; }
        const amountIn = parsed.raw;
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
        return { ...s, amountIn, out: r.out, blockers: r.blockers || [], value: r.value || null };
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
        $("swMax").addEventListener("click", async () => {
          const s = swapSelected();
          if (!s) return;
          const ai = swAsset(s.tokenIn);
          const btn = $("swMax");
          btn.disabled = true;
          try {
            /*
             * Read the balance of the asset that is selected *now*.
             *
             * `window.__myTokenIn` is one global holding "the input token's
             * balance", written by a poll that runs every twelve seconds. Flip
             * the pair and it describes the wrong asset until the next poll —
             * so Max on EURC filled 72.225191, which was the USDC balance, for
             * a wallet holding 19.37 EURC. A quote for a trade that cannot
             * settle.
             *
             * One read of the selected token removes the window entirely.
             */
            let bal = null;
            if (selfMode()) {
              const raw = await myTokenBalance(s.tokenIn);
              if (raw !== null) {
                window.__myBal[String(s.tokenIn).toLowerCase()] = raw.toString();
                window.__myTokenIn = fmtUnitsStr(raw, Number(s.decIn ?? 6));
                bal = window.__myTokenIn;
                renderSwapBalances();
              }
            }
            if (bal == null) bal = ai && ai.wallet;
            if (bal == null || !(parseFloat(bal) > 0)) {
              $("swQuoteOut").textContent = `No ${ai ? ai.symbol : "input"} balance to sell.`;
              return;
            }
            $("swAmount").value = String(bal);
            await swapQuote();
          } finally {
            btn.disabled = false;
          }
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
      /** One-time override per exact trade, mirroring the AMM tab's guard. */
      const swValueAck = new Set();
      $("swExecute").addEventListener("click", async () => {
        const q = await swapQuote();
        const msg = $("swapMsg");
        if (!q) { msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = "Get a valid quote first."; return; }
        // Pre-flight the two things that actually make a swap revert, so the user
        // gets a plain reason instead of a bare "RPC request failed".
        const ai = swAsset(q.tokenIn), ao = swAsset(q.tokenOut);
        const human = $("swAmount").value.trim();
        /*
         * In self-custody the balance is read fresh from the signer's wallet
         * and compared in raw integers. `window.__myTokenIn` is a display
         * string that a poll may have written seconds ago, and comparing it as
         * a float made "spend exactly what I hold" a coin toss on the last
         * decimal place.
         */
        const mineRaw = selfMode() ? await myTokenBalance(q.tokenIn) : null;
        if (mineRaw !== null) {
          if (BigInt(q.amountIn) > mineRaw) {
            msg.style.display = "block"; msg.style.color = "var(--warn)";
            msg.textContent =
              `You only have ${fmtUnitsStr(mineRaw, q.decIn ?? (ai && ai.decimals) ?? 6)} ${q.symIn} — reduce the amount.`;
            return;
          }
        } else {
          const held = window.__myTokenIn != null ? window.__myTokenIn : ai && ai.wallet;
          if (held != null && Number(held) < Number(human)) {
            msg.style.display = "block"; msg.style.color = "var(--warn)";
            msg.textContent = `You only have ${held} ${q.symIn} — reduce the amount.`;
            return;
          }
        }
        if (!q.out || BigInt(q.out) === 0n) {
          msg.style.display = "block"; msg.style.color = "var(--warn)";
          msg.textContent = `No pool can fill ${q.symIn} → ${q.symOut} at that size. Try less, or add liquidity for the pair.`;
          return;
        }
        /*
         * Refuse a trade that hands back materially less than it takes.
         *
         * The AMM tab has had this guard for a while; the desk, routing through
         * the very same pools, had none — and sold 0.5 USDC for 0.148 EURC
         * without a word. One press to acknowledge, keyed to the exact trade so
         * changing the pair or the size re-arms it.
         */
        if (q.value && q.value.severity === "severe") {
          const key = `${q.tokenIn}:${q.tokenOut}:${q.amountIn}`;
          if (!swValueAck.has(key)) {
            swValueAck.add(key);
            msg.style.display = "block"; msg.style.color = "var(--warn)";
            msg.textContent = `Blocked: ${q.value.reason} Press Swap again to go ahead anyway.`;
            return;
          }
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
          if (r.ok) msg.innerHTML = `swapped ${esc(q.symIn)} → ${esc(q.symOut)} ✓ — view on Arcscan: ${txLink(r.txHash)}`;
          else msg.textContent = `failed: ${r.error}`;
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
      /*
       * A provider's address, short enough that the row still fits.
       *
       * The full forty-two characters pushed every other column off a phone
       * screen — "SHARES" arrived as "HARES" and a share count as "999000" —
       * so the numbers people actually came to read were the ones that got
       * cut. The link carries the whole thing, and the title attribute has it
       * for anyone who wants to copy it.
       */
      function holderAddr(addr) {
        const a = String(addr || "");
        if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return esc(a);
        const short = `${a.slice(0, 6)}…${a.slice(-4)}`;
        return (
          `<a href="${esc(explorerBase())}/address/${esc(a)}" target="_blank" rel="noopener" ` +
          `title="${esc(a)}">${esc(short)}</a>`
        );
      }

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
              // 1e8, not 1e6. `rank` is the pool's own USD valuation — the same
              // PRICE_SCALE it lends and liquidates against — and dividing by
              // USDC's six decimals instead reported every position at a hundred
              // times its size: 1 USDC supplied showed as $100.
              ? `$${(Number(h.rank) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
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
              <td class="mono" style="font-size:11.5px">${holderAddr(h.address)}${h.isApp ? '<span class="appTag">app</span>' : ""}</td>
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
          /*
           * "In line with the market feed" was printed whenever nothing was
           * flagged stale — including when nothing could be compared at all.
           * On the live pool two of three rows have no market price, so the
           * table showed cirBTC at $95,000 against a dash and then declared
           * everything in order. An unchecked price is not a checked one, and
           * saying so is the difference between a reassurance and a lie.
           */
          const unchecked = r.assets.filter((a) => !a.stale && !(Number(a.marketUsd) > 0));
          if (note && !note.textContent.startsWith("Repriced")) {
            const parts = [];
            if (stale.length) {
              parts.push(
                `${stale.map((a) => a.symbol).join(", ")} ${stale.length === 1 ? "is" : "are"} more than 5% away ` +
                "from the market. Borrow limits and liquidation thresholds are computed from the pool price, " +
                "so this gap is real money.",
              );
            }
            if (unchecked.length) {
              parts.push(
                `No market price for ${unchecked.map((a) => a.symbol).join(", ")}, so ` +
                `${unchecked.length === 1 ? "its mark is" : "those marks are"} unverified — the figure ` +
                "shown is whatever an operator last set, and it does not move on its own.",
              );
            }
            if (!parts.length) parts.push("Pool prices are in line with the market feed.");
            note.className = stale.length ? "feedNote bad" : unchecked.length ? "feedNote warn" : "feedNote";
            note.textContent = parts.join(" ");
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

      /** Everyone who owes the pool, from /api/lending/borrowers. */
      async function loadBorrowers() {
        const body = $("borrowersRows");
        if (!body) return;
        const note = $("borrowersNote");
        try {
          // Name yourself, so your own row is there even on a server with no
          // event index to enumerate borrowers from.
          const mineAddr = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(mineAddr) ? `?include=${encodeURIComponent(mineAddr)}` : "";
          const r = await (await fetch("/api/lending/borrowers" + q)).json();
          if (!r.ok) {
            body.innerHTML = emptyRow(6, r.error || "Borrowers unavailable.");
            return;
          }
          const me = String(window.__myAddress || "").toLowerCase();
          body.innerHTML =
            (r.borrowers || [])
              .map((b) => {
                const mine = String(b.address).toLowerCase() === me;
                const hf = b.healthFactor;
                const hfCell = hf == null
                  ? '<span class="tag ok">no debt</span>'
                  : `<span class="${hf < 1 ? "down" : hf < 1.1 ? "warn" : ""}">${hf.toFixed(2)}</span>`;
                const assets = (b.debts || [])
                  .map((d) => `${esc(d.amount)} ${esc(d.symbol)}`)
                  .join(", ");
                return (
                  `<tr${mine ? ' style="font-weight:600"' : ""}>` +
                  `<td class="mono">${txAddrLink(b.address)}${mine ? " (you)" : ""}</td>` +
                  `<td class="num">$${esc(b.borrowedUsd)}</td>` +
                  `<td class="num">$${esc(b.liabilityUsd)}</td>` +
                  `<td class="num">$${esc(b.collateralUsd)}</td>` +
                  `<td class="num">${hfCell}</td>` +
                  `<td>${esc(assets || "—")}</td></tr>`
                );
              })
              .join("") || emptyRow(6, "Nobody is borrowing right now.");
          if (note) {
            const atRisk = (r.borrowers || []).filter((b) => b.atRisk).length;
            note.textContent =
              `${r.count} borrower${r.count === 1 ? "" : "s"}, $${r.totalBorrowedUsd} outstanding` +
              (atRisk ? ` · ${atRisk} below a health factor of 1.00 and liquidatable now.` : ".") +
              (r.indexed ? "" : " (No event index on this server, so only the agent's own position is listed.)");
          }
        } catch {
          body.innerHTML = emptyRow(6, "Could not read borrowers.");
        }
      }
      /** An address as an explorer link, or plain text when there is no explorer. */
      function txAddrLink(addr) {
        const a = String(addr || "");
        if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return esc(a);
        const short = a.slice(0, 10) + "…" + a.slice(-4);
        return `<a href="${esc(explorerBase())}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short)}</a>`;
      }

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
            /*
             * Anyone may put up cover.
             *
             * `backstopDeposit`, `queueBackstopExit`, `cancelBackstopExit` and
             * `withdrawBackstop` are all permissionless on the pool — the panel
             * was hidden behind an admin session for no reason the contract
             * imposes, which is why "where do I deposit backstop balance?" had
             * no answer. A connected wallet signs its own; an operator still
             * gets the agent path.
             */
            box.style.display = adminId || selfMode() ? "" : "none";
            const who = $("backstopWho");
            if (who) {
              who.textContent = selfMode()
                ? "These buttons sign from your wallet and post your own cover."
                : adminId
                  ? "These buttons spend the app's agent wallet."
                  : "";
            }
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
            // Queueing an exit is denominated in *shares*, not assets: a share
            // is a claim on a pot whose value moves, so asking for "50 USDC out"
            // would be a number that stops meaning anything the moment interest
            // accrues or a loss lands. Shares are whole, so parse at 0 decimals.
            //
            // `parseFloat("1abc")` is 1 and `Number("1abc")` is NaN, so the old
            // guard passed input that then threw inside BigInt with no message.
            const parsed = parseAmount(human, sharesNotAssets ? 0 : a.decimals);
            if (parsed.error) return bsShow(parsed.error, "var(--warn)");
            const raw = parsed.raw;
            // Self-custody signs its own; the pool asks no permission for this.
            if (selfMode()) {
              return selfCustody("backstopMsg", label, async (from, cfg) => {
                const sel2 = cfg.selectors;
                if (action === "deposit") {
                  await ensureAllowance(from, a.address, cfg.pool, raw);
                  return sendTx(from, cfg.pool, callData(sel2.backstopDeposit, encAddr(a.address), encUint(raw)));
                }
                return sendTx(from, cfg.pool, callData(sel2.backstopQueue, encAddr(a.address), encUint(raw)));
              }).then(() => loadBackstop());
            }
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
            if (selfMode()) {
              return selfCustody("backstopMsg", label, async (from, cfg) =>
                sendTx(
                  from, cfg.pool,
                  callData(
                    action === "cancel" ? cfg.selectors.backstopCancel : cfg.selectors.backstopWithdraw,
                    encAddr(a.address),
                  ),
                ),
              ).then(() => loadBackstop());
            }
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
        if (key === "Lending") { loadPoolPrices(); loadBackstop(); loadAuction(); loadBorrowers(); loadEmissions(); }
        if (key === "Amm" && typeof loadLpEmissions === "function") loadLpEmissions().catch(() => {});
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
          if (!ai || !ao) return null;
          const parsed = parseAmount(human, ai.decimals);
          if (parsed.error) { $("amSwapQuote").textContent = human ? parsed.error : ""; return null; }
          if (tokenIn === tokenOut) { $("amSwapQuote").textContent = "Pick two different assets."; return null; }
          const amountIn = parsed.raw;
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
            /*
             * In self-custody the fallback is not a fallback.
             *
             * `myBalance` is a share of the pool, not a wallet balance, so using
             * it when the wallet read failed offers to trade money the signer
             * does not have — and Max then fills a number the swap can only
             * revert on, which reads to the user as a button that does nothing.
             * If we are signing from a wallet, the wallet's balance is the only
             * honest ceiling; not having read it is a thing to say, not to paper
             * over.
             */
            if (selfMode() && !wallet) {
              $("amSwapQuote").textContent =
                "Could not read your wallet balance. Reconnect the wallet and try Max again.";
              return;
            }
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
          // The same pre-flight as the swap desk: don't sign what the wallet
          // cannot pay for, and say the real number rather than reverting.
          if (selfMode()) {
            const mineRaw = await myTokenBalance(q.ai.address);
            if (mineRaw !== null && BigInt(q.amountIn) > mineRaw) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent =
                `Your wallet holds ${fmtUnitsStr(mineRaw, q.ai.decimals)} ${q.ai.symbol} — reduce the amount.`;
              return;
            }
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
          const say = (t, colour) => {
            const m = $("ammMsg");
            if (!m) return;
            m.style.display = "block"; m.style.color = colour || "var(--warn)"; m.textContent = t;
          };
          /*
           * Every path out of here used to be a bare `return`.
           *
           * On the USDC/cirBTC pool — both reserves zero — `pool > 0` is never
           * true, so `scale` stayed Infinity, `isFinite` failed, and the handler
           * returned without filling a box or saying a word. The button looked
           * broken because from the outside it was.
           */
          const balances = await amWalletBalances(p);
          if (!balances) {
            say(selfMode()
              ? "Could not read your wallet balances — check your wallet is connected to Arc."
              : "Max fills from your own wallet. Switch on \"Use my own wallet\" first.");
            return;
          }
          const raws = p.assets.map((a, i) => {
            const r = parseAmount(balances[i], Number(a.decimals ?? 6));
            return r.error ? 0n : BigInt(r.raw);
          });
          const poolRaws = p.assets.map((a) => BigInt(a.raw ?? "0"));
          const empty = poolRaws.every((r) => r === 0n);

          if (empty) {
            /*
             * An empty pool has no ratio to match — the first deposit *sets*
             * the price. So Max offers everything the wallet holds and says
             * what that means, rather than refusing to fill a form whose whole
             * purpose is to seed the pool.
             */
            let any = false;
            p.assets.forEach((a, i) => {
              if (!boxes[i]) return;
              boxes[i].value = raws[i] > 0n ? fmtUnitsStr(raws[i], Number(a.decimals ?? 6)) : "";
              if (raws[i] > 0n) any = true;
            });
            say(any
              ? "This pool is empty, so your deposit sets its opening price. Enter the two sides at the " +
                "rate you believe is fair — Max has filled your whole balance of each, which is unlikely to be it."
              : "Your wallet holds none of these assets.", "var(--warn)");
            return;
          }

          /*
           * Largest balanced deposit the wallet can fund, in integers.
           *
           * scale = min(have_i / pool_i), computed as a rational so an 8-decimal
           * asset beside a 6-decimal one cannot lose precision to a float.
           */
          let num = null, den = null;
          p.assets.forEach((a, i) => {
            if (poolRaws[i] === 0n) return;
            if (num === null || raws[i] * den < num * poolRaws[i]) { num = raws[i]; den = poolRaws[i]; }
          });
          if (num === null || num === 0n) {
            say("Your wallet holds none of at least one asset in this pool, so a balanced deposit is not possible.");
            return;
          }
          let filled = false;
          p.assets.forEach((a, i) => {
            if (!boxes[i]) return;
            const want = (poolRaws[i] * num) / den;
            boxes[i].value = want > 0n ? fmtUnitsStr(want, Number(a.decimals ?? 6)) : "";
            if (want > 0n) filled = true;
          });
          if (!filled) say("Your balance is too small to fund a deposit at this pool's ratio.");
          else say("Filled the largest balanced deposit your wallet can cover.", "var(--muted)");
        });

        /** The connected wallet's balance of each pool asset (self-custody only). */
        async function amWalletBalances(p) {
          if (!selfMode() || !eth()) return null;
          try {
            const cfg = await loadDefiConfig();
            const [from] = await eth().request({ method: "eth_accounts" });
            if (!from) return null;
            if (!(await onArc())) return null;
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
            let bad = null;
            amounts = p.assets.map((a, i) => {
              const v = (boxes[i] && boxes[i].value.trim()) || "";
              const parsed = parseAmount(v, a.decimals);
              if (parsed.error) { if (v && !bad) bad = `${a.symbol}: ${parsed.error}`; return "0"; }
              return parsed.raw;
            });
            if (bad || amounts.some((v) => v === "0")) {
              msg.style.display = "block"; msg.style.color = "var(--warn)";
              msg.textContent = bad || "Enter an amount for every asset in the pool.";
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

          /*
           * Adding liquidity moves every asset in the pool at once, so it
           * reverts on the first one you are short of — after the wallet has
           * already collected an approval for it. Check all the legs up front
           * and name the one that is short.
           */
          if (adding && selfMode()) {
            for (let i = 0; i < p.assets.length; i++) {
              const a = p.assets[i];
              const bal = await myTokenBalance(a.address);
              if (bal !== null && BigInt(amounts[i]) > bal) {
                msg.style.display = "block"; msg.style.color = "var(--warn)";
                msg.textContent =
                  `Your wallet holds ${fmtUnitsStr(bal, a.decimals)} ${a.symbol} — reduce that leg.`;
                return;
              }
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
        /*
         * `eth_accounts` first, and only ask for permission when there is none.
         *
         * `eth_requestAccounts` is a *permission* request, and this function
         * runs before every self-custody action. Revoking three approvals in a
         * row therefore fired three permission prompts interleaved with three
         * transaction prompts, and wallets read that burst as an attack: the
         * one in the report offered to block the site outright, and blocked
         * site cannot reconnect.
         *
         * An already-connected wallet answers `eth_accounts` with no prompt at
         * all, which is the normal case here — the user connected before they
         * could see this panel.
         */
        let a;
        try {
          const accts = await eth().request({ method: "eth_accounts" });
          a = accts && accts[0];
        } catch { /* fall through to the permission request */ }
        if (!a) {
          const asked = await eth().request({ method: "eth_requestAccounts" });
          a = asked && asked[0];
        }
        if (!a) throw new Error("No account is connected in your wallet.");
        const cfg = await loadDefiConfig();
        // Make sure the wallet is on Arc, offering to add the network if unknown.
        const want = "0x" + Number(cfg.chainId).toString(16);
        const have = await eth().request({ method: "eth_chainId" });
        if (BigInt(have) !== BigInt(want)) {
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

      /**
       * Is the connected wallet actually on Arc?
       *
       * Every read on this page — balances, positions, LP shares — is an
       * `eth_call` through the injected provider, which sends it to whatever
       * chain the wallet happens to be sitting on. Point it at any other
       * network and those calls land on addresses that hold no code: the
       * provider answers `0x`, `BigInt("0x0")` is zero, and the panel fills
       * with confident zeros. "Max withdraw: 0" for somebody who supplied four
       * USDC is indistinguishable from "your wallet is on Ethereum".
       *
       * So reads refuse to run off-chain rather than inventing a number, and
       * say which network to switch to. Writes may prompt a switch
       * (`selfAccount`); a background read must never pop a dialog.
       */
      let chainOk = null; // null = not yet checked
      async function onArc() {
        if (!eth()) { chainOk = null; wrongChainNote(false); return false; }
        try {
          const cfg = await loadDefiConfig();
          const have = await eth().request({ method: "eth_chainId" });
          chainOk = BigInt(have) === BigInt(cfg.chainId);
        } catch {
          chainOk = false;
        }
        wrongChainNote(chainOk === false);
        return chainOk === true;
      }
      /** One line under the custody toggle, shown only while off Arc. */
      function wrongChainNote(on) {
        let el = $("wrongChain");
        if (!on) { if (el) el.remove(); return; }
        if (!el) {
          const host = $("custodyNote");
          if (!host || !host.parentNode) return;
          el = document.createElement("div");
          el.id = "wrongChain";
          el.style.cssText = "margin-top:6px;color:var(--warn);font-size:13px";
          host.parentNode.insertBefore(el, host.nextSibling);
        }
        el.textContent =
          "Your wallet is on a different network, so your balances cannot be read. " +
          "Switch it to Arc testnet — starting any action here will offer to switch for you.";
      }
      if (eth() && eth().on) {
        eth().on("chainChanged", () => {
          chainOk = null;
          refreshMyPositions().catch(() => {});
        });
      }

      async function ethCall(to, data) {
        return eth().request({ method: "eth_call", params: [{ to, data }, "latest"] });
      }
      async function sendTx(from, to, data) {
        return eth().request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
      }
      /**
       * Wait for a transaction to be mined, so the next one is simulated
       * against the state it actually depends on.
       *
       * Without this the approval and the action went out back to back, and
       * the wallet simulated the action against pre-approval state: MetaMask
       * paints "this transaction is likely to fail" over a perfectly good
       * supply. People read that as a bug in the app, and often cancel.
       *
       * Bounded, and non-fatal on timeout — the nonce ordering still holds, so
       * giving up on waiting is worse UX, not a broken transaction.
       */
      async function waitForTx(hash, ms = 45000) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ""))) return null;
        const until = Date.now() + ms;
        while (Date.now() < until) {
          try {
            const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] });
            // Return the receipt whatever it says. A revert *is* a receipt, and
            // callers need to see it — swallowing it here is how a failed
            // transaction became a green tick in the first place.
            if (r && r.blockNumber) return r;
          } catch { /* a transient RPC hiccup is not an answer; keep polling */ }
          await new Promise((r) => setTimeout(r, 1500));
        }
        return null; // still pending — unknown, which is neither pass nor fail
      }

      /**
       * Ensure `spender` may move `amount` of `token` on the user's behalf.
       *
       * Exactly `amount`, not `type(uint256).max`. An unlimited approval is a
       * standing permission to drain that wallet of that token for as long as
       * it exists, and it survives long after the transaction it was granted
       * for — it is the single most common way a compromised or upgraded
       * spender turns into a loss. The cost of being exact is one extra
       * approval per action, which is the right trade on a lending pool.
       */
      async function ensureAllowance(from, token, spender, amount) {
        const cfg = await loadDefiConfig();
        const cur = await ethCall(token, callData(cfg.selectors.allowance, encAddr(from), encAddr(spender)));
        if (BigInt(cur || "0x0") >= BigInt(amount)) return null;
        const hash = await sendTx(from, token, cfg.selectors.approve + encAddr(spender) + encUint(amount));
        const receipt = await waitForTx(hash);
        // A failed approval must stop the action rather than let it go out and
        // revert for a reason nobody would connect back to this step.
        if (receipt && !receiptOkHex(receipt.status)) {
          throw new Error("The approval transaction failed on chain, so nothing was sent.");
        }
        return hash;
      }

      /**
       * Run a self-custody action, reporting progress into `msgEl`.
       *
       * A transaction hash is not an outcome. `eth_sendTransaction` resolves
       * the moment the wallet broadcasts, and this printed a green tick right
       * there — so a transaction that reverted in the very next block showed
       * "supply 1 USDC ✓" in the app and "Fail" on Arcscan, from the same
       * hash. The tick now waits for the receipt and reads its status, and
       * says so plainly when the chain rejected it.
       */
      async function selfCustody(msgEl, label, fn) {
        const msg = $(msgEl);
        const show = (text, colour, html) => {
          msg.style.display = "block";
          msg.style.color = colour;
          if (html) msg.innerHTML = text; else msg.textContent = text;
        };
        show("Confirm in your wallet…", "var(--muted)");
        let safeHash = "";
        const link = () =>
          safeHash
            ? ` — <a href="${esc(explorerBase())}/tx/${esc(safeHash)}" target="_blank" rel="noopener">` +
              `${esc(safeHash.slice(0, 12))}…</a>`
            : "";
        try {
          const from = await selfAccount();
          const hash = await fn(from, await loadDefiConfig());
          // `hash` comes from the wallet provider, so treat it as untrusted:
          // accept only a 0x-hex tx hash, and escape everything interpolated.
          safeHash = /^0x[0-9a-fA-F]{64}$/.test(String(hash)) ? String(hash) : "";
          if (!safeHash) {
            // No hash means the wallet never told us what it sent. That is not
            // a success, and claiming one would be the exact bug above.
            show(`${esc(label)}: your wallet did not return a transaction hash, so the result is unknown. ` +
                 `Check your wallet's activity before retrying.`, "var(--warn)", true);
            return;
          }
          show(`${esc(label)} sent — waiting for the chain to confirm it…${link()}`, "var(--muted)", true);
          const receipt = await waitForTx(safeHash, 120000);
          if (!receipt) {
            // Still pending. Not a success and not a failure; say which.
            show(`${esc(label)} is still pending after two minutes. It may yet land — ` +
                 `check the explorer rather than sending it again.${link()}`, "var(--warn)", true);
            return;
          }
          if (!receiptOkHex(receipt.status)) {
            show(`${esc(label)} <b>failed on chain</b> — it was mined but reverted, so nothing moved. ` +
                 `Your funds are untouched.${link()}`, "var(--warn)", true);
            return;
          }
          show(`${esc(label)} confirmed ✓${link()}`, "var(--good)", true);
        } catch (e) {
          show(walletError(e) + (safeHash ? ` (${safeHash.slice(0, 12)}…)` : ""), "var(--warn)");
        } finally {
          afterTx();
        }
      }
      /**
       * Did this receipt status mean success? Raw RPC gives 0x1/0x0; be strict
       * and treat anything else as a failure — an unrecognised status is
       * precisely where a false green tick does the most harm.
       */
      function receiptOkHex(status) {
        if (status === undefined || status === null) return false;
        const s = String(status).toLowerCase();
        return s === "0x1" || s === "1" || s === "success";
      }
      // Plain-language wallet/chain errors (mirrors the server's friendlyError).
      function walletError(e) {
        const raw = String((e && (e.data && e.data.message)) || (e && e.message) || e);
        const s = raw.toLowerCase();
        if (e && (e.code === 4001 || s.includes("user rejected") || s.includes("user denied"))) return "You cancelled it in your wallet.";
        // -32002: a prompt is already open. Common when several actions are
        // started at once, and it reads as a dead button rather than a queue.
        if (e && (e.code === -32002 || s.includes("already pending") || s.includes("already processing"))) {
          return "Your wallet already has a request open — approve or dismiss it, then try again.";
        }
        // 4100 / "unauthorized" is what a wallet returns once it has blocked
        // the site. Tapping Connect again cannot lift it.
        if (
          e && (e.code === 4100 || e.code === 4900 ||
            s.includes("unauthorized") || s.includes("blocked") || s.includes("not been authorized"))
        ) {
          return (
            "Your wallet has blocked this site, so it cannot connect. Open your wallet's settings, " +
            "remove tesra.xyz from its blocked or disconnected sites, then tap Connect again."
          );
        }
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
        // Off Arc, every call below would answer zero. Leave the panel alone.
        if (!(await onArc())) { clearMine(); return; }
        let cfg;
        try { cfg = await loadDefiConfig(); } catch { return; }
        const sel = cfg.selectors;

        /*
         * The signer's own account totals, and their per-asset wallet balance.
         *
         * Without this the summary row showed the agent's account — "$0.00
         * supplied" directly above "your position in this asset: 1 USDC", which
         * is two true numbers about two different people stacked into one panel.
         */
        if (cfg.pool && sel.accountData) {
          try {
            const hex = await ethCall(cfg.pool, callData(sel.accountData, encAddr(from)));
            const body = String(hex || "").replace(/^0x/, "");
            if (body.length >= 256) {
              const word = (i) => BigInt("0x" + body.slice(i * 64, i * 64 + 64));
              // accountData returns (supplyValue, borrowValue, borrowLimit, healthFactor)
              // in the pool's 1e8 USD scale.
              const usd = (v) => "$" + (Number(v) / 1e8).toFixed(2);
              setMine("lnSupplied", usd(word(0)));
              setMine("lnBorrowed", usd(word(1)));
              setMine("lnLimit", usd(word(2)));
              // Keep the raw words: the borrow cap is (limit - borrowed) in USD
              // converted at the asset's mark, and doing that from the "$5.00"
              // above would round the headroom to the nearest cent.
              window.__myAccount = {
                supplyValue: word(0).toString(),
                borrowValue: word(1).toString(),
                borrowLimit: word(2).toString(),
                liability: null, // filled below; see accountLimits
              };
            }
          } catch {}
        }

        /*
         * The number the pool actually gates on.
         *
         * `accountData` reports `borrowValue`: what the debt is worth. But
         * `_healthy` compares `borrowLimit >= liability`, and liability is that
         * value divided by each asset's liability factor — so it is always the
         * larger number. Deriving a borrow cap from borrowValue overstated it
         * by exactly that factor. Live, with $4.50 of limit against $4.00 of
         * debt at a 0.95 factor, it offered 0.50 USDC where the chain allowed
         * 0.275: every "Max borrow" reverted.
         */
        if (cfg.pool && sel.accountLimits) {
          try {
            const hex = await ethCall(cfg.pool, callData(sel.accountLimits, encAddr(from)));
            const b = String(hex || "").replace(/^0x/, "");
            if (b.length >= 192) {
              const wd = (i) => BigInt("0x" + b.slice(i * 64, i * 64 + 64));
              // (borrowLimit, liquidationLimit, liability)
              window.__myAccount = {
                ...(window.__myAccount || {}),
                borrowLimit: wd(0).toString(),
                liquidationLimit: wd(1).toString(),
                liability: wd(2).toString(),
              };
            }
          } catch {}
        }

        /*
         * The signer's wallet balance *and* their position, per asset.
         *
         * The position half is what "max withdraw: 0" was missing. Supply and
         * repay are bounded by the wallet, so those were fixed first — but
         * withdraw is bounded by what *you* supplied, and that number was still
         * coming from the server, which computes it for the agent. Somebody who
         * had supplied 4 USDC was offered a maximum withdrawal of zero, because
         * the agent had supplied nothing.
         *
         * Every cap on this panel is now derived from the signer.
         */
        try {
          const assets = (cfg.assets || []).filter((a) => a && a.address);
          await Promise.all(
            assets.map(async (a) => {
              const key = String(a.address).toLowerCase();
              const [wal, sup, bor] = await Promise.all([
                ethCall(a.address, callData(sel.balanceOf, encAddr(from))),
                cfg.pool ? ethCall(cfg.pool, callData(sel.supplyBalance, encAddr(a.address), encAddr(from))) : null,
                cfg.pool && sel.borrowBalance
                  ? ethCall(cfg.pool, callData(sel.borrowBalance, encAddr(a.address), encAddr(from)))
                  : null,
              ]);
              window.__myBal[key] = BigInt(wal || "0x0").toString();
              window.__myPos[key] = {
                supplied: BigInt(sup || "0x0").toString(),
                borrowed: BigInt(bor || "0x0").toString(),
              };
            }),
          );
          if (typeof renderLendingAsset === "function") renderLendingAsset();
        } catch {}

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
      /**
       * A transaction hash, as a link somebody can actually check.
       *
       * Every success message printed the first twelve characters of a hash as
       * plain text — enough to look reassuring and not enough to do anything
       * with. The whole point of an on-chain action is that it is verifiable by
       * a third party, so the receipt should be one click from the explorer.
       *
       * The hash is validated rather than trusted: it goes into markup, and a
       * value that is not a 32-byte hash has no business being there.
       */
      /** The block explorer, always absolute. See window.__explorer. */
      function explorerBase() {
        const e = String(window.__explorer || "").trim();
        return /^https?:\/\//.test(e) ? e.replace(/\/+$/, "") : "https://testnet.arcscan.app";
      }
      function txLink(hash, label) {
        const h = String(hash || "");
        if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return esc(h.slice(0, 12));
        const base = explorerBase();
        return `<a href="${esc(base)}/tx/${esc(h)}" target="_blank" rel="noopener" style="text-decoration:underline">${label || esc(h.slice(0, 10)) + "…"}</a>`;
      }
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
        // Leaving these behind would keep deriving the caps of a signer who is
        // no longer connected — or is on the wrong chain, which is one of the
        // ways clearMine gets called.
        window.__myAccount = null;
        window.__myPos = {};
        window.__myBal = {};
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
      /* ---- Governance ------------------------------------------------------
       *
       * Voting power is not a balance. Tokens carry no weight until they are
       * delegated, which is the one step people miss — so the panel measures
       * both and offers the fix as its own button rather than leaving somebody
       * to wonder why their thousand tokens counted for nothing.
       */
      window.__gov = null;

      function govMsg(id, text, colour) {
        const m = $(id);
        if (!m) return;
        m.style.display = "block"; m.textContent = text; m.style.color = colour || "var(--muted)";
      }

      const relTime = (secs) => {
        const d = secs - Math.floor(Date.now() / 1000);
        const a = Math.abs(d), unit = a < 3600 ? [60, "min"] : a < 86400 ? [3600, "hour"] : [86400, "day"];
        const n = Math.round(a / unit[0]);
        return `${d >= 0 ? "in " : ""}${n} ${unit[1]}${n === 1 ? "" : "s"}${d < 0 ? " ago" : ""}`;
      };

      async function loadGovernance() {
        const host = $("govProposals");
        if (!host) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/governance" + q)).json();
          window.__gov = r && r.ok ? r : null;
          if (!r || !r.ok || !r.deployed) {
            host.innerHTML = `<div class="kv">${esc((r && r.note) || "Governance is not deployed here.")}</div>`;
            return;
          }
          const sym = r.token.symbol;
          $("govBalance").textContent = `${r.you.balance} ${sym}`;
          $("govVotes").textContent = `${r.you.votes} ${sym}`;
          $("govCirculating").textContent = `${r.circulating} ${sym}`;
          $("govQuorum").textContent = `${r.quorum} ${sym}`;

          // The delegation gap, stated rather than left to be discovered.
          const undelegated = Number(r.you.balance) > 0 && Number(r.you.votes) === 0;
          $("govDelegate").style.display = undelegated ? "" : "none";
          $("govDelegateNote").textContent = undelegated
            ? `You hold ${r.you.balance} ${sym} but none of it is voting. One transaction points it at yourself.`
            : Number(r.you.votes) > 0
              ? `Your weight is active. It moves with your tokens automatically from here.`
              : `Hold ${sym} — earned by supplying or borrowing — to take part.`;

          $("govCreateCard").style.display = r.canPropose && adminId ? "" : "none";
          $("govEmissionsCard").style.display = r.canPropose && adminId ? "" : "none";

          renderProposals(r);

          // The lock.
          if (r.lock) {
            $("govLocked").textContent = `${r.lock.locked} ${sym}`;
            $("govActivity").textContent = `$${r.lock.activityUsd}`;
            $("govRate").textContent = `${r.lock.ratePerSecond} ${sym}/s`;
            $("govLasts").textContent = r.lock.lastsDays == null
              ? "indefinitely (idle)"
              : r.lock.lastsDays > 365
                ? `${(r.lock.lastsDays / 365).toFixed(1)} years`
                : `${r.lock.lastsDays.toFixed(1)} days`;
            $("govSinks").innerHTML = (r.lock.sinks || [])
              .map((k) =>
                `<tr><td>${esc(k.label)}<div class="muted" style="font-size:11px">${esc(k.kind)} → ${esc(k.to.slice(0, 10))}…</div></td>` +
                `<td class="num">${esc(String(k.weight))}</td><td class="num mono">${esc(k.pending)}</td></tr>`)
              .join("") || emptyRow(3, "No sinks configured.");
          }
          renderEmissionAssets();
        } catch {
          host.innerHTML = `<div class="kv">Could not read governance.</div>`;
        }
      }

      /* ---- Proposal list: filtering and paging ------------------------------
       *
       * A governance page is read from the top and grows forever. Both of these
       * are display only — nothing here changes which proposals exist or what
       * anybody may vote on.
       */
      let govFilter = "all";
      let govPage = 1;
      const GOV_PAGE_SIZE = 5;

      if ($("govFilter")) {
        $("govFilter").addEventListener("change", () => {
          govFilter = $("govFilter").value;
          govPage = 1;
          if (window.__gov) renderProposals(window.__gov);
        });
      }
      if ($("govPrev")) $("govPrev").addEventListener("click", () => {
        if (govPage > 1) { govPage--; renderProposals(window.__gov); }
      });
      if ($("govNext")) $("govNext").addEventListener("click", () => {
        govPage++; renderProposals(window.__gov);
      });

      const PASSED = ["Succeeded", "Queued", "Executed"];
      const FAILED = ["Defeated", "Cancelled"];

      function renderProposals(r) {
        const host = $("govProposals");
        if (!host || !r) return;
        let rows = r.proposals || [];
        if (govFilter === "open") rows = rows.filter((p) => p.state === "Active");
        if (govFilter === "passed") rows = rows.filter((p) => PASSED.includes(p.state));
        if (govFilter === "failed") rows = rows.filter((p) => FAILED.includes(p.state));
        if (govFilter === "mine") {
          rows = rows.filter((p) => p.state === "Active" && !p.youVoted && Number(p.yourWeightRaw) > 0);
        }

        const pages = Math.max(1, Math.ceil(rows.length / GOV_PAGE_SIZE));
        if (govPage > pages) govPage = pages;
        const slice = rows.slice((govPage - 1) * GOV_PAGE_SIZE, govPage * GOV_PAGE_SIZE);

        host.innerHTML = slice.length
          ? slice.map((p) => govCard(p, r)).join("")
          : `<div class="kv">${esc(
              govFilter === "mine"
                ? "Nothing open that you can still vote on."
                : "No proposals match that filter.",
            )}</div>`;
        host.querySelectorAll("[data-vote]").forEach((b) =>
          b.addEventListener("click", (ev) => { ev.stopPropagation(); castVote(Number(b.dataset.id), Number(b.dataset.vote)); }),
        );
        host.querySelectorAll("[data-open-proposal]").forEach((el) =>
          el.addEventListener("click", () => openProposal(Number(el.dataset.openProposal))),
        );

        const pager = $("govPager");
        if (pager) {
          pager.style.display = rows.length > GOV_PAGE_SIZE ? "" : "none";
          $("govPageLabel").textContent =
            `${(govPage - 1) * GOV_PAGE_SIZE + 1}–${Math.min(govPage * GOV_PAGE_SIZE, rows.length)} of ${rows.length}`;
          $("govPrev").disabled = govPage <= 1;
          $("govNext").disabled = govPage >= pages;
        }
      }

      /* ---- One proposal, in full ------------------------------------------- */
      async function openProposal(id) {
        const card = $("govDetailCard");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `&user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch(`/api/governance/proposal?id=${id}${q}`)).json();
          if (!r || !r.ok) { govMsg("govMsg", (r && r.error) || "Could not read that proposal.", "var(--warn)"); return; }

          $("govProposalsCard").style.display = "none";
          $("govDiscussionsCard").style.display = "none";
          card.style.display = "";
          card.scrollIntoView({ behavior: "smooth", block: "start" });

          $("govDetailTitle").textContent = `#${r.id} ${r.title}`;
          const ex = r.explorer;
          const link = (addr) =>
            ex ? `<a href="${esc(ex)}/address/${esc(addr)}" target="_blank" rel="noopener">${esc(shortAddr(addr))}</a>`
               : esc(shortAddr(addr));
          $("govDetailMeta").innerHTML =
            `<span class="tag">${esc(r.state)}</span> · Proposed by ${link(r.proposer)} · ` +
            `snapshot block ${esc(r.snapshotBlock)} · voting ${r.state === "Active" ? "closes" : "closed"} ${esc(relTime(r.voteEnd))}`;
          $("govDetailBody").textContent = r.description || "";

          const sym = r.token.symbol;
          const bar = (label, amount, pct, colour) =>
            `<div style="margin-bottom:10px">` +
            `<div class="row-actions" style="justify-content:space-between">` +
            `<span>${label}</span><span class="mono">${esc(pct.toFixed(2))}% — ${esc(amount)} ${esc(sym)}</span></div>` +
            `<div style="height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin-top:4px">` +
            `<div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:${colour}"></div></div></div>`;
          $("govDetailBars").innerHTML =
            bar("For", r.result.for, r.result.forPct, "var(--good)") +
            bar("Abstain", r.result.abstain, r.result.abstainPct, "var(--muted)") +
            bar("Against", r.result.against, r.result.againstPct, "var(--warn)");

          // Turnout against the bar it had to clear, rather than two numbers to
          // divide in your head.
          $("govDetailQuorum").innerHTML =
            `Participation: <b>${esc(r.result.participationPct.toFixed(2))}%</b> of circulating ` +
            `(&gt;${esc(r.result.quorumPct.toFixed(0))}% needed) — ` +
            `<span class="${r.result.quorumMet ? "" : "warn"}">${r.result.quorumMet ? "quorum met" : "below quorum"}</span>. ` +
            `${esc(r.result.cast)} of ${esc(r.result.circulating)} ${esc(sym)} voted.`;

          const aw = $("govDetailActionsWrap");
          aw.style.display = (r.actions || []).length ? "" : "none";
          if ((r.actions || []).length) {
            $("govDetailActions").innerHTML = r.actions.map((a) =>
              `<tr><td>${a.index + 1}</td><td class="mono" style="font-size:11px">${link(a.target)}</td>` +
              `<td class="mono" style="font-size:11px">${esc(a.selector)}…</td></tr>`).join("");
          }

          $("govVotesHeading").textContent = `Votes (${r.voteCount})`;
          const note = $("govVotesNote");
          // A short scan must never present itself as the whole roll.
          note.style.display = r.votesPartial ? "" : "none";
          note.textContent = r.votesPartial
            ? "The node returned only part of the log range, so this list may be missing entries. The totals above are read from the contract and are complete."
            : "";
          $("govVotesRows").innerHTML = (r.votes || []).length
            ? r.votes.map((v) => {
                const tone = v.support === "For" ? "ok" : v.support === "Against" ? "warn" : "";
                const you = window.__myAddress && v.voter.toLowerCase() === String(window.__myAddress).toLowerCase();
                return `<tr><td class="mono" style="font-size:11.5px">${link(v.voter)}` +
                  `${you ? ' <span class="tag ok" style="font-size:10px">you</span>' : ""}</td>` +
                  `<td class="num"><span class="tag ${tone}" style="font-size:10px">${esc(v.support)}</span></td>` +
                  `<td class="num mono">${esc(v.weight)}</td>` +
                  `<td class="num">${esc(v.pctOfCast < 0.01 ? "<0.01" : v.pctOfCast.toFixed(2))}%</td></tr>`;
              }).join("")
            : emptyRow(4, "Nobody has voted on this yet.");
        } catch {
          govMsg("govMsg", "Could not read that proposal.", "var(--warn)");
        }
      }

      if ($("govDetailBack")) {
        $("govDetailBack").addEventListener("click", () => {
          $("govDetailCard").style.display = "none";
          $("govProposalsCard").style.display = "";
          $("govDiscussionsCard").style.display = "";
          $("govProposalsCard").scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }

      /* ---- Discussions ------------------------------------------------------ */
      async function loadDiscussions() {
        const host = $("govDiscussions");
        if (!host) return;
        try {
          const r = await (await fetch("/api/governance/discussions")).json();
          if (!r || !r.ok) { host.innerHTML = ""; return; }
          window.__discussions = r;
          $("govDiscussionNote").textContent = r.note;
          host.innerHTML = (r.drafts || []).length
            ? r.drafts.map((d) =>
                `<div style="padding:12px;border:1px solid var(--line-strong);border-radius:12px">` +
                `<div class="row-actions" style="justify-content:space-between">` +
                `<b style="font-size:14px">${esc(d.title)}</b>` +
                `<span class="tag ${d.published ? "ok" : ""}">${d.published ? "proposal #" + d.proposalId : "not published"}</span>` +
                `</div>` +
                `<div class="kv" style="margin:6px 0 8px;white-space:pre-wrap">${esc(d.body)}</div>` +
                `<div class="muted" style="font-size:11px">by ${esc(shortAddr(d.author))} · ${esc(relTime(Math.floor(d.createdAt / 1000)))}</div>` +
                (d.comments || []).map((c) =>
                  `<div style="margin-top:8px;padding-left:10px;border-left:2px solid var(--line)">` +
                  `<div class="kv" style="white-space:pre-wrap">${esc(c.body)}</div>` +
                  `<div class="muted" style="font-size:10.5px">${esc(shortAddr(c.author))} · ${esc(relTime(Math.floor(c.createdAt / 1000)))}</div></div>`).join("") +
                `<div class="row-actions" style="margin-top:10px;flex-wrap:wrap">` +
                `<input class="field discReply" data-parent="${esc(d.id)}" placeholder="Reply" style="min-width:220px" />` +
                `<button class="btn" data-disc-reply="${esc(d.id)}" style="padding:3px 10px;font-size:11px">Reply</button>` +
                (r.canPublish && !d.published
                  ? `<button class="btn primary" data-disc-publish="${esc(d.id)}" style="padding:3px 10px;font-size:11px">Publish as a proposal</button>`
                  : "") +
                `</div></div>`).join("")
            : `<div class="kv">Nothing under discussion. Open one below.</div>`;

          host.querySelectorAll("[data-disc-reply]").forEach((b) =>
            b.addEventListener("click", () => postDiscussion("comment", b.dataset.discReply)),
          );
          host.querySelectorAll("[data-disc-publish]").forEach((b) =>
            b.addEventListener("click", async () => {
              try {
                const res = await (await postJson("/api/governance/discussions/publish", { id: b.dataset.discPublish })).json();
                govMsg("govDiscMsg", res.ok ? `Opened as proposal #${res.proposalId}. Voting is live. — ${res.txHash}` : (res.error || "failed"),
                  res.ok ? "var(--good)" : "var(--warn)");
                if (res.ok) { loadDiscussions(); loadGovernance(); }
              } catch { govMsg("govDiscMsg", "Request failed.", "var(--warn)"); }
            }),
          );
        } catch {
          host.innerHTML = "";
        }
      }

      async function postDiscussion(kind, parent) {
        if (!selfMode()) {
          govMsg("govDiscMsg", "A post is signed by its author, so this needs your own wallet. " +
            'Switch on "Use my own wallet".', "var(--warn)");
          return;
        }
        const title = kind === "draft" ? ($("govDiscTitle").value || "").trim() : "";
        const body = kind === "draft"
          ? ($("govDiscBody").value || "").trim()
          : (document.querySelector(`.discReply[data-parent="${parent}"]`)?.value || "").trim();
        if (!body) { govMsg("govDiscMsg", "Say something first.", "var(--warn)"); return; }
        if (kind === "draft" && !title) { govMsg("govDiscMsg", "A discussion needs a title.", "var(--warn)"); return; }

        try {
          const from = await selfAccount();
          if (!from) { govMsg("govDiscMsg", "Connect a wallet first.", "var(--warn)"); return; }
          const at = Date.now();
          const cfg = await loadDefiConfig();
          // The signed text names this governor and this chain, so a signature
          // gathered here cannot be replayed as a post somewhere else.
          const message =
            `Tessera governance ${kind}\n` +
            `governor: ${cfg.governor}\n` +
            `chain: ${cfg.chainId}\n` +
            `at: ${at}\n\n` +
            (kind === "draft" ? `${title}\n\n${body}` : body);
          const signature = await window.ethereum.request({
            method: "personal_sign",
            params: [message, from],
          });
          const r = await (await postJson("/api/governance/discussions", {
            kind, title, body, parent, author: from, at, signature,
          })).json();
          govMsg("govDiscMsg", r.ok ? "Posted." : (r.error || "failed"), r.ok ? "var(--good)" : "var(--warn)");
          if (r.ok) {
            if (kind === "draft") { $("govDiscTitle").value = ""; $("govDiscBody").value = ""; }
            loadDiscussions();
          }
        } catch (e) {
          govMsg("govDiscMsg", String(e && e.message ? e.message : e).slice(0, 160), "var(--warn)");
        }
      }

      if ($("govDiscPost")) $("govDiscPost").addEventListener("click", () => postDiscussion("draft"));

      /** One proposal, with only the buttons that would actually work. */
      function govCard(p, r) {
        const sym = r.token.symbol;
        const live = p.state === "Active";
        const tone = { Active: "ok", Succeeded: "ok", Queued: "ok", Executed: "ok", Defeated: "warn", Cancelled: "warn" }[p.state] || "";
        const canVote = live && !p.youVoted && Number(p.yourWeightRaw) > 0;
        const why = !live
          ? ""
          : p.youVoted
            ? "You have voted on this."
            : Number(p.yourWeightRaw) === 0
              ? "You had no delegated TSRA at the snapshot block, so you cannot vote on this one. Delegate now and the next proposal will count you."
              : `Voting with ${p.yourWeight} ${sym}.`;
        const bar = (label, v) =>
          `<div class="kv" style="justify-content:space-between"><span>${label}</span><b>${esc(v)} ${esc(sym)}</b></div>`;
        return (
          `<div data-open-proposal="${p.id}" style="padding:12px;border:1px solid var(--line-strong);border-radius:12px;cursor:pointer">` +
          `<div class="row-actions" style="justify-content:space-between">` +
          `<b style="font-size:14px">#${p.id} ${esc(p.title)}</b>` +
          `<span class="tag ${tone}">${esc(p.state)}</span></div>` +
          `<div class="kv" style="margin:6px 0 10px">${esc(p.description || "")}</div>` +
          bar("For", p.forVotes) + bar("Against", p.againstVotes) + bar("Abstain", p.abstainVotes) +
          `<div class="kv" style="justify-content:space-between;margin-top:4px">` +
          `<span>Participation ${esc((p.participationPct ?? 0).toFixed(2))}%` +
          `${r.quorumPct ? ` (&gt;${esc(r.quorumPct.toFixed(0))}% needed)` : ""}</span>` +
          `<span class="${p.quorumMet ? "" : "warn"}">${p.quorumMet ? "quorum met" : "below quorum"}</span></div>` +
          `<div class="kv" style="margin-top:6px">` +
          (live ? `Voting closes ${esc(relTime(p.voteEnd))}.` : `Voting closed ${esc(relTime(p.voteEnd))}.`) +
          (p.actions ? ` Carries ${p.actions} on-chain call${p.actions === 1 ? "" : "s"}.` : " Signalling only.") +
          `</div>` +
          (why ? `<div class="kv" style="margin-top:6px">${esc(why)}</div>` : "") +
          `<div class="muted" style="font-size:11px;margin-top:6px">Open for the full result and every vote ›</div>` +
          (canVote
            ? `<div class="row-actions" style="margin-top:10px">` +
              `<button class="btn primary" data-vote="1" data-id="${p.id}">For</button>` +
              `<button class="btn" data-vote="0" data-id="${p.id}">Against</button>` +
              `<button class="btn" data-vote="2" data-id="${p.id}">Abstain</button></div>`
            : "") +
          `</div>`
        );
      }

      async function castVote(id, support) {
        if (!selfMode()) {
          govMsg("govMsg", "Voting is signed by the holder, so it needs your own wallet. " +
            "Switch on \"Use my own wallet\".", "var(--warn)");
          return;
        }
        await selfCustody("govMsg", `vote on proposal #${id}`, async (from, cfg) =>
          sendTx(from, cfg.governor, callData(cfg.selectors.govVote, encUint(id), encUint(support))),
        );
        loadGovernance();
      }

      if ($("govDelegate")) {
        $("govDelegate").addEventListener("click", async () => {
          if (!selfMode()) {
            govMsg("govMsg", "Delegating is signed by the holder — switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          await selfCustody("govMsg", "activate voting power", async (from, cfg) =>
            sendTx(from, cfg.token, callData(cfg.selectors.govDelegate, encAddr(from))),
          );
          loadGovernance();
        });
      }

      if ($("govPropose")) {
        $("govPropose").addEventListener("click", async () => {
          const title = ($("govTitle").value || "").trim();
          const description = ($("govBody").value || "").trim();
          if (!title) { govMsg("govCreateMsg", "A proposal needs a title.", "var(--warn)"); return; }
          try {
            const r = await (await postJson("/api/governance/propose", { title, description })).json();
            if (r.ok) {
              $("govTitle").value = ""; $("govBody").value = "";
              govMsg("govCreateMsg", "Proposal opened. Voting is live.", "var(--good)");
              loadGovernance();
            } else govMsg("govCreateMsg", r.error || "failed", "var(--warn)");
          } catch { govMsg("govCreateMsg", "Request failed.", "var(--warn)"); }
        });
      }

      /* ---- Emission rates (operator) --------------------------------------- */
      function renderEmissionAssets() {
        const sel = $("govEmAsset");
        if (!sel) return;
        const assets = (window.__lending && window.__lending.assets) || [];
        const sig = assets.map((a) => a.symbol).join(",");
        if (sel.dataset.sig === sig) return;
        sel.dataset.sig = sig;
        sel.innerHTML = assets
          .filter((a) => a.address)
          .map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`)
          .join("");
        const em = window.__emissions;
        if (em && em.configured) {
          $("govEmBudget").textContent =
            `Pot ${em.reward.balance} ${em.reward.symbol}` +
            (em.reward.runwayDays == null ? " · nothing streaming" : ` · ${em.reward.runwayDays.toFixed(2)} days at the current rates`) +
            `. Set rates above what the emitter delivers and the pot empties — the shortfall stays owed, not forgiven.`;
        }
      }

      if ($("govEmSet")) {
        $("govEmSet").addEventListener("click", async () => {
          const asset = $("govEmAsset").value;
          const side = Number($("govEmSide").value);
          const em = window.__emissions;
          const dec = em && em.reward ? Number(em.reward.decimals) : 18;
          const parsed = parseAmount($("govEmRate").value, dec);
          // A rate of zero is a legitimate instruction — it stops a stream — so
          // it is accepted here even though parseAmount refuses it elsewhere.
          const raw = ($("govEmRate").value || "").trim() === "0" ? "0" : parsed.raw;
          if (!raw) { govMsg("govEmMsg", parsed.error || "Enter a rate.", "var(--warn)"); return; }
          const until = $("govEmUntil").value
            ? Math.floor(new Date($("govEmUntil").value + "T23:59:59Z").getTime() / 1000)
            : 0;
          try {
            const r = await (await postJson("/api/lending/emissions/rate", {
              asset, side, ratePerSecond: raw, endsAt: until,
            })).json();
            if (r.ok) {
              govMsg("govEmMsg",
                `Rate set${until ? `, ending ${new Date(until * 1000).toDateString()}` : " (no end date)"}. ` +
                `— ${r.txHash}`, "var(--good)");
              loadEmissions();
            } else govMsg("govEmMsg", r.error || "failed", "var(--warn)");
          } catch { govMsg("govEmMsg", "Request failed.", "var(--warn)"); }
        });
      }

      /* ---- Asset registry ---------------------------------------------------
       *
       * What is listed, and what listing something else would take. The one
       * thing this refuses to blur is whether a listing vote actually enacts
       * anything: that depends on the governor owning the pool, and a page that
       * implied otherwise would be selling an authority the contract does not
       * have.
       */
      async function loadRegistry() {
        const card = $("govRegistryCard");
        if (!card) return;
        try {
          const r = await (await fetch("/api/governance/registry")).json();
          if (!r || !r.ok || !r.deployed) { card.style.display = "none"; return; }
          card.style.display = "";
          window.__registry = r;
          $("govRegistryRule").textContent = r.rule || "";
          $("govRegistryNote").textContent = r.enactment;
          // The vote board states the same rule, so somebody deciding where to
          // put their weight sees it without opening the register.
          if ($("gaRuleNote")) $("gaRuleNote").textContent = r.rule || "";
          const statusTag = (st) =>
            st === "whitelisted"
              ? `<span class="tag ok" style="font-size:10px">whitelisted</span>`
              : st === "revoked"
                ? `<span class="tag warn" style="font-size:10px">revoked</span>`
                : `<span class="tag" style="font-size:10px">undecided</span>`;
          $("govRegistryRows").innerHTML = (r.listed || []).length
            ? r.listed.map((a) => {
                // A revoked asset is struck through rather than removed: that
                // somebody looked and said no is information the list would
                // otherwise erase.
                const name = a.status === "revoked"
                  ? `<s>${esc(a.symbol)}</s>`
                  : `<b>${esc(a.symbol)}</b>`;
                return `<tr${a.status === "revoked" ? ' style="opacity:.6"' : ""}>` +
                  `<td>${name}` +
                  `<div class="muted" style="font-size:11px">${esc(a.address.slice(0, 10))}… · ${a.decimals} dp` +
                  `${a.inPool ? "" : " · not in the pool"}${a.enabled || !a.inPool ? "" : " · disabled"}</div>` +
                  (a.reason ? `<div class="muted" style="font-size:10.5px">${esc(a.reason)}</div>` : "") + `</td>` +
                  `<td class="num mono">${a.inPool ? "$" + esc(a.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })) : "—"}</td>` +
                  `<td class="num mono">${a.inPool ? "$" + esc(a.suppliedUsd.toFixed(2)) : "—"}</td>` +
                  `<td class="num mono">${a.inPool ? "$" + esc(a.borrowedUsd.toFixed(2)) : "—"}</td>` +
                  `<td class="num">${a.inPool ? esc((a.collateralBps / 100).toFixed(0)) + "%" : "—"}</td>` +
                  `<td class="num">${statusTag(a.status)}</td></tr>`;
              }).join("")
            : emptyRow(6, "Nothing listed yet.");
          $("govRegistryPropose").style.display = adminId ? "" : "none";
          $("govRegistryAdmin").style.display = adminId && r.registry ? "" : "none";

          const sel = $("regStatusAsset");
          if (sel) {
            const sig = (r.listed || []).map((a) => a.address).join(",");
            if (sel.dataset.sig !== sig) {
              sel.dataset.sig = sig;
              sel.innerHTML = (r.listed || [])
                .map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`)
                .join("");
            }
          }
        } catch {
          card.style.display = "none";
        }
      }

      if ($("regStatusSet")) {
        $("regStatusSet").addEventListener("click", async () => {
          const asset = $("regStatusAsset").value;
          const status = Number($("regStatusValue").value);
          const reason = ($("regStatusReason").value || "").trim();
          if (!reason) {
            govMsg("regStatusMsg", "Say why — the register keeps the reason, and a decision nobody can " +
              "audit later is not much of a register.", "var(--warn)");
            return;
          }
          try {
            const r = await (await postJson("/api/governance/registry/status", { asset, status, reason })).json();
            govMsg("regStatusMsg", r.ok ? `Recorded. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("regStatusReason").value = ""; loadRegistry(); loadGauge(); }
          } catch { govMsg("regStatusMsg", "Request failed.", "var(--warn)"); }
        });
      }

      if ($("regPropose")) {
        $("regPropose").addEventListener("click", async () => {
          const body = {
            asset: ($("regAsset").value || "").trim(),
            priceUsd: Number(($("regPrice").value || "0").trim()),
            collateralBps: Number($("regCollateral").value),
            liquidationBps: Number($("regLiquidation").value),
            liabilityBps: Number($("regLiability").value),
            reserveBps: Number($("regReserve").value),
            borrowable: $("regBorrowable").checked,
          };
          try {
            // Encode first: the parameters are checked against the pool's own
            // bounds before a vote is opened on them, not after it passes.
            const enc = await (await postJson("/api/governance/registry/encode", body)).json();
            if (!enc.ok) { govMsg("regMsg", enc.error || "failed", "var(--warn)"); return; }
            $("regSummary").textContent = enc.summary;

            const r = await (await postJson("/api/governance/propose", {
              title: `List ${enc.symbol} as a reserve`,
              description: enc.summary +
                (window.__registry && window.__registry.governorOwnsPool
                  ? " Passing this executes the listing."
                  : " The pool is operator-owned, so passing this is a mandate the operator carries out."),
              targets: [enc.target],
              calldatas: [enc.data],
            })).json();
            if (r.ok) {
              govMsg("regMsg", `Listing proposal opened. Voting is live. — ${r.txHash}`, "var(--good)");
              $("regAsset").value = ""; $("regPrice").value = "";
              loadGovernance();
            } else govMsg("regMsg", r.error || "failed", "var(--warn)");
          } catch { govMsg("regMsg", "Request failed.", "var(--warn)"); }
        });
      }

      /* ---- The gauge: where this epoch's rewards go ------------------------
       *
       * The vote that happens every epoch rather than every proposal. The
       * server computes the shares and the reward-zone cutoff, because two
       * implementations of "the top three" is how a page ends up promising a
       * market an emission it never receives.
       */
      window.__gauge = null;
      /** Which slice of the board is on screen. Filtering only, never hiding
       *  a market from the vote itself. */
      let gaFilter = "top";
      let gaEligibleOnly = false;

      document.querySelectorAll("[data-gafilter]").forEach((b) =>
        b.addEventListener("click", () => {
          gaFilter = b.dataset.gafilter;
          document.querySelectorAll("[data-gafilter]").forEach((x) => x.classList.toggle("active", x === b));
          if (window.__gauge) renderGaugeRows(window.__gauge);
        }),
      );
      if ($("gaWhitelistOnly")) {
        $("gaWhitelistOnly").addEventListener("change", () => {
          gaEligibleOnly = $("gaWhitelistOnly").checked;
          if (window.__gauge) renderGaugeRows(window.__gauge);
        });
      }

      function renderGaugeRows(r) {
        let rows = (r.markets || []).filter((m) => m.active || Number(m.votesRaw) > 0);
        if (gaEligibleOnly) rows = rows.filter((m) => m.eligible);
        if (gaFilter === "incentives") rows = rows.filter((m) => (m.bribes || []).length > 0);
        if (gaFilter === "mine") rows = rows.filter((m) => Number(m.yourVotesRaw) > 0);
        if (gaFilter === "zone") rows = rows.filter((m) => m.inRewardZone);
        rows = rows.slice().sort((a, b) => Number(b.votesRaw) - Number(a.votesRaw) || a.id - b.id);

        $("gaRows").innerHTML = rows.length
          ? rows.map((m) => gaugeRow(m, r)).join("")
          : emptyRow(6, gaFilter === "mine"
              ? "You have not put weight on anything this epoch."
              : gaFilter === "incentives"
                ? "No incentives are attached this epoch."
                : "Nothing matches that filter.");

        $("gaRows").querySelectorAll("[data-bribe-claim]").forEach((b) =>
          b.addEventListener("click", () => claimBribes(Number(b.dataset.bribeClaim))),
        );
      }

      async function loadGauge() {
        const card = $("govGaugeCard");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/gauge" + q)).json();
          window.__gauge = r && r.ok && r.deployed ? r : null;
          if (!window.__gauge) { card.style.display = "none"; return; }
          card.style.display = "";
          $("govGaugeAdminCard").style.display = r.canSet && adminId ? "" : "none";
          $("govBribeCard").style.display = "";

          $("gaEpoch").textContent = `#${r.epoch}`;
          $("gaCloses").textContent = relTime(r.epochEndsAt);
          $("gaTotal").textContent = `${r.totalVotes} TSRA`;
          $("gaAvailable").textContent = r.you ? `${r.you.available} TSRA` : "connect a wallet";
          $("gaBudgetNote").textContent =
            `Budget: ${r.budget.lendingPerDay} TSRA a day across lending, ${r.budget.ammPerDay} across liquidity. ` +
            (r.rewardZoneSize ? `Top ${r.rewardZoneSize} markets share it; ` : "Every market with a vote shares it; ") +
            `epochs run ${r.epochLengthHours} hours.`;

          $("gaRuleNote").textContent = (window.__registry && window.__registry.rule) || "";
          renderGaugeRows(r);
          renderDelegates(r);

          // Applying is only offered when there is actually a closed, unapplied
          // epoch — a button that always reverts teaches people to ignore it.
          const applyBtn = $("gaApply");
          applyBtn.style.display = r.applicableEpoch != null ? "" : "none";
          applyBtn.textContent = `Apply epoch #${r.applicableEpoch} result`;
          applyBtn.dataset.epoch = String(r.applicableEpoch ?? "");

          $("gaHint").textContent = !r.you
            ? "Connect your wallet to vote."
            : Number(r.you.available) === 0 && Number(r.you.used) === 0
              ? "You have no delegated TSRA. Delegate below, then vote from the next epoch."
              : `Voting with up to ${r.you.available} TSRA (${r.you.used} already allocated).`;

          // The operator boxes mirror what is set, so a change is a correction
          // rather than a re-entry from memory.
          if (r.canSet && adminId) {
            if (document.activeElement !== $("gaBudgetLending")) $("gaBudgetLending").value = r.budget.lendingPerSecond;
            if (document.activeElement !== $("gaBudgetAmm")) $("gaBudgetAmm").value = r.budget.ammPerSecond;
            if (document.activeElement !== $("gaZoneSize")) $("gaZoneSize").value = String(r.rewardZoneSize);
            $("gaAdminNote").textContent = r.lastAppliedEpoch == null
              ? "No epoch has been applied yet."
              : `Last applied: epoch #${r.lastAppliedEpoch}.`;
            renderGaugeMarketForm();
          }
          renderBribeForm(r);
        } catch {
          card.style.display = "none";
        }
      }

      function gaugeRow(m, r) {
        const badges =
          (m.inRewardZone
            ? `<span class="tag ok" style="font-size:10px">♛ reward zone</span> `
            : Number(m.votesRaw) > 0 && m.eligible
              ? `<span class="tag warn" style="font-size:10px">below the line</span> `
              : "") +
          // Eligibility is a different fact from position, and conflating them
          // is how somebody spends an epoch's weight on a market that was never
          // going to be paid.
          (m.eligible ? "" : `<span class="tag warn" style="font-size:10px">not eligible</span> `);
        const perDay = Number(m.ratePerSecond) / 1e18 * 86400;
        const pays = Number(m.ratePerSecond) > 0
          ? `<span class="tsraIcon"></span> ${perDay.toFixed(2)}/day`
          : m.eligible ? "—" : "never";
        const mine = (m.bribes || []).reduce((t, b) => t + BigInt(b.yourShareRaw || "0"), 0n);
        const bribes = (m.bribes || []).length
          ? (m.bribeApr != null
              ? `<b>up to ${esc(m.bribeApr.toFixed(2))}%</b><div class="muted" style="font-size:10.5px">APR</div>`
              : `<b>$${esc(m.bribeUsd.toFixed(2))}</b>`) +
            `<div class="muted" style="font-size:10.5px">${esc((m.bribes || []).map((b) => b.symbol).join(", "))}</div>` +
            (mine > 0n
              ? `<div><button class="btn" style="padding:2px 8px;font-size:11px" data-bribe-claim="${m.id}">Claim my share</button></div>`
              : "")
          : "—";
        return (
          `<tr${m.active && m.eligible ? "" : ' style="opacity:.6"'}>` +
          `<td><b>${esc(m.label)}</b> ${badges}` +
          `<div class="muted" style="font-size:11px">${m.venue === "lending" ? (m.side === 0 ? "lending · supply" : "lending · borrow") : "liquidity pool #" + m.poolId}` +
          `${m.active ? "" : " · retired"}</div></td>` +
          `<td class="num mono">${esc(m.votes)}<div class="muted" style="font-size:10.5px">${esc(m.sharePct.toFixed(1))}%</div></td>` +
          `<td class="num">${esc(String(m.usersVoted ?? 0))}</td>` +
          `<td class="num">${pays}</td>` +
          `<td class="num" style="font-size:11px">${bribes}</td>` +
          `<td class="num"><input class="field gaVote" data-market="${m.id}" inputmode="decimal" ` +
          `value="${esc(m.yourVotes !== "0" ? m.yourVotes : "")}" placeholder="0" style="width:96px;text-align:right"` +
          `${m.active ? "" : " disabled"} /></td>` +
          `</tr>`
        );
      }

      /* ---- The delegate directory ------------------------------------------ */
      function renderDelegates(r) {
        const host = $("govDelegateList");
        if (!host) return;
        const list = r.delegates || [];
        host.innerHTML = list.length
          ? list.map((d) =>
              `<tr><td><b>${esc(d.name)}</b>${d.isYou ? ' <span class="tag ok" style="font-size:10px">you</span>' : ""}` +
              `${d.active ? "" : ' <span class="tag warn" style="font-size:10px">stepped down</span>'}` +
              `<div class="muted" style="font-size:11px">${esc(d.statement || "")}</div>` +
              `<div class="muted mono" style="font-size:10.5px">${esc(d.address)}</div></td>` +
              `<td class="num mono">${esc(d.votingPower)}</td>` +
              `<td class="num"><button class="btn" style="padding:2px 8px;font-size:11px" ` +
              `data-delegate-to="${esc(d.address)}">Delegate to them</button></td></tr>`)
            .join("")
          : emptyRow(3, "Nobody has listed themselves yet.");
        host.querySelectorAll("[data-delegate-to]").forEach((b) =>
          b.addEventListener("click", () => delegateTo(b.dataset.delegateTo)),
        );
      }

      async function delegateTo(to) {
        if (!selfMode()) {
          govMsg("govDelegateMsg", "Delegating is signed by the holder — switch on \"Use my own wallet\".", "var(--warn)");
          return;
        }
        await selfCustody("govDelegateMsg", `delegate to ${to.slice(0, 10)}…`, async (from, cfg) =>
          sendTx(from, cfg.token, callData(cfg.selectors.govDelegate, encAddr(to))),
        );
        loadGovernance();
        loadGauge();
      }

      if ($("govDelegateRegister")) {
        $("govDelegateRegister").addEventListener("click", async () => {
          if (!selfMode()) {
            govMsg("govDelegateMsg", "Listing yourself is your own transaction — an operator-signed entry " +
              "would make it an endorsement. Switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          const name = ($("govDelegateName").value || "").trim();
          const statement = ($("govDelegateStatement").value || "").trim();
          if (!name) { govMsg("govDelegateMsg", "A directory entry needs a name.", "var(--warn)"); return; }
          await selfCustody("govDelegateMsg", "list yourself as a delegate", async (from, cfg) =>
            // registerDelegate(string,string): two dynamic arguments, so the
            // head holds an offset to each and the tails carry length + bytes.
            sendTx(from, cfg.gauge, callData(
              cfg.selectors.gaRegisterDelegate,
              encUint(64),
              encUint(64 + encStringTail(name).length / 2),
              encStringTail(name),
              encStringTail(statement),
            )),
          );
          loadGauge();
        });
      }

      /** A dynamic string, ABI-style: length word then right-padded bytes. */
      function encStringTail(str) {
        const bytes = new TextEncoder().encode(str);
        let hex = "";
        for (const b of bytes) hex += b.toString(16).padStart(2, "0");
        const words = Math.ceil(bytes.length / 32) * 64;
        return encUint(bytes.length) + hex.padEnd(words, "0");
      }

      if ($("gaSubmit")) {
        $("gaSubmit").addEventListener("click", async () => {
          const r = window.__gauge;
          if (!r) return;
          if (!selfMode()) {
            govMsg("gaMsg", "A vote is signed by the holder, so it needs your own wallet. " +
              "Switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          const ids = [], weights = [];
          let bad = null;
          document.querySelectorAll(".gaVote").forEach((el) => {
            const raw = (el.value || "").trim();
            if (!raw || Number(raw) === 0) return;
            const parsed = parseAmount(raw, 18);
            if (!parsed.raw) { bad = bad || parsed.error; return; }
            ids.push(BigInt(el.dataset.market));
            weights.push(BigInt(parsed.raw));
          });
          if (bad) { govMsg("gaMsg", bad, "var(--warn)"); return; }
          if (!ids.length) {
            govMsg("gaMsg", "Put some weight on at least one market — or use \"Take my weight back\".", "var(--warn)");
            return;
          }
          // The contract replaces the whole allocation, so the sum is measured
          // against total power rather than what is left of it.
          const total = weights.reduce((t, w) => t + w, 0n);
          const power = BigInt(r.you ? r.you.availableRaw : "0") +
            (r.markets || []).reduce((t, m) => t + BigInt(m.yourVotesRaw || "0"), 0n);
          if (total > power) {
            govMsg("gaMsg",
              `That is more than your weight at the snapshot (${r.you ? r.you.available : "0"} TSRA plus what you have already allocated).`,
              "var(--warn)");
            return;
          }
          await selfCustody("gaMsg", "cast your market vote", async (from, cfg) =>
            sendTx(from, cfg.gauge, callData(
              cfg.selectors.gaVote,
              encUint(64),
              encUint(64 + 32 + ids.length * 32),
              encArray(ids),
              encArray(weights),
            )),
          );
          loadGauge();
        });
      }

      if ($("gaClear")) {
        $("gaClear").addEventListener("click", async () => {
          if (!selfMode()) {
            govMsg("gaMsg", "Withdrawing a vote is signed by the holder — switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          await selfCustody("gaMsg", "take your weight back", async (from, cfg) =>
            sendTx(from, cfg.gauge, callData(cfg.selectors.gaClear)),
          );
          loadGauge();
        });
      }

      if ($("gaApply")) {
        $("gaApply").addEventListener("click", async () => {
          const epoch = $("gaApply").dataset.epoch;
          if (epoch === "") return;
          // Permissionless on the contract: from a connected wallet it is the
          // holder's own transaction, and the server route is just a fallback
          // for whoever is signed in as the operator.
          if (selfMode()) {
            await selfCustody("gaMsg", `apply epoch #${epoch}`, async (from, cfg) =>
              sendTx(from, cfg.gauge, callData(cfg.selectors.gaApply, encUint(epoch))),
            );
          } else {
            try {
              const r = await (await postJson("/api/gauge/apply", { epoch })).json();
              govMsg("gaMsg", r.ok ? `Applied. — ${r.txHash}` : (r.error || "failed"),
                r.ok ? "var(--good)" : "var(--warn)");
            } catch { govMsg("gaMsg", "Request failed.", "var(--warn)"); }
          }
          loadGauge();
          loadEmissions();
        });
      }

      async function claimBribes(marketId) {
        if (!selfMode()) {
          govMsg("gaMsg", "An incentive is paid to the address whose weight was used, so this needs your own wallet.",
            "var(--warn)");
          return;
        }
        const r = window.__gauge;
        // Bribes settle against the epoch they were voted in, which is the one
        // that has closed — not the one open now.
        const epoch = r && r.applicableEpoch != null ? r.applicableEpoch : (r ? r.epoch - 1 : 0);
        if (epoch < 0) { govMsg("gaMsg", "No epoch has closed yet.", "var(--warn)"); return; }
        await selfCustody("gaMsg", `claim your share of the incentives on market #${marketId}`, async (from, cfg) =>
          sendTx(from, cfg.gauge, callData(cfg.selectors.gaClaimBribes, encUint(epoch), encUint(marketId))),
        );
        loadGauge();
      }

      /* ---- Incentives (anyone) --------------------------------------------- */
      function renderBribeForm(r) {
        const sel = $("gaBribeMarket");
        if (!sel) return;
        const sig = (r.markets || []).map((m) => `${m.id}:${m.label}`).join("|");
        if (sel.dataset.sig !== sig) {
          sel.dataset.sig = sig;
          sel.innerHTML = (r.markets || [])
            .filter((m) => m.active)
            .map((m) => `<option value="${m.id}">${esc(m.label)}</option>`)
            .join("");
        }
        const tok = $("gaBribeToken");
        const assets = (window.__lending && window.__lending.assets) || [];
        const tsig = assets.map((a) => a.symbol).join(",");
        if (tok.dataset.sig !== tsig) {
          tok.dataset.sig = tsig;
          tok.innerHTML = assets
            .filter((a) => a.address)
            .map((a) => `<option value="${esc(a.address)}" data-dec="${Number(a.decimals ?? 6)}">${esc(a.symbol)}</option>`)
            .join("");
        }
      }

      if ($("gaBribeAdd")) {
        $("gaBribeAdd").addEventListener("click", async () => {
          const r = window.__gauge;
          if (!r) return;
          if (!selfMode()) {
            govMsg("gaBribeMsg", "An incentive comes out of your wallet, so it needs your own wallet.", "var(--warn)");
            return;
          }
          const marketId = Number($("gaBribeMarket").value);
          const opt = $("gaBribeToken").selectedOptions[0];
          if (!opt) { govMsg("gaBribeMsg", "Pick a token.", "var(--warn)"); return; }
          const token = opt.value;
          const dec = Number(opt.dataset.dec || 6);
          const parsed = parseAmount($("gaBribeAmount").value, dec);
          if (!parsed.raw) { govMsg("gaBribeMsg", parsed.error || "Enter an amount.", "var(--warn)"); return; }
          await selfCustody("gaBribeMsg", `attach ${$("gaBribeAmount").value} to a market`, async (from, cfg) => {
            // Exactly what is being attached, and no more — the same rule every
            // other approval in this app follows.
            await ensureAllowance(from, token, cfg.gauge, BigInt(parsed.raw));
            return sendTx(from, cfg.gauge, callData(
              cfg.selectors.gaAddBribe,
              encUint(r.epoch), encUint(marketId), encAddr(token), encUint(parsed.raw),
            ));
          });
          $("gaBribeAmount").value = "";
          loadGauge();
        });
      }

      /* ---- Operator: budget, zone, listings -------------------------------- */
      function renderGaugeMarketForm() {
        const venue = $("gaNewVenue");
        if (!venue) return;
        const isAmm = venue.value === "amm";
        $("gaNewAsset").style.display = isAmm ? "none" : "";
        $("gaNewSide").style.display = isAmm ? "none" : "";
        $("gaNewPool").style.display = isAmm ? "" : "none";
        const sel = $("gaNewAsset");
        const assets = (window.__lending && window.__lending.assets) || [];
        const sig = assets.map((a) => a.symbol).join(",");
        if (sel.dataset.sig !== sig) {
          sel.dataset.sig = sig;
          sel.innerHTML = assets
            .filter((a) => a.address)
            .map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`)
            .join("");
        }
      }
      if ($("gaNewVenue")) $("gaNewVenue").addEventListener("change", renderGaugeMarketForm);

      if ($("gaBudgetSet")) {
        $("gaBudgetSet").addEventListener("click", async () => {
          const lending = parseAmount($("gaBudgetLending").value, 18);
          const amm = parseAmount($("gaBudgetAmm").value, 18);
          // Zero is a real instruction here — it stops a venue paying at all.
          const l = ($("gaBudgetLending").value || "").trim() === "0" ? "0" : lending.raw;
          const a = ($("gaBudgetAmm").value || "").trim() === "0" ? "0" : amm.raw;
          if (!l || !a) {
            govMsg("gaAdminMsg", lending.error || amm.error || "Enter both budgets.", "var(--warn)");
            return;
          }
          try {
            const r = await (await postJson("/api/gauge/budget", { lendingPerSecond: l, ammPerSecond: a })).json();
            govMsg("gaAdminMsg", r.ok ? `Budget set. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) loadGauge();
          } catch { govMsg("gaAdminMsg", "Request failed.", "var(--warn)"); }
        });
      }

      if ($("gaZoneSet")) {
        $("gaZoneSet").addEventListener("click", async () => {
          const size = Number(($("gaZoneSize").value || "").trim());
          if (!Number.isInteger(size) || size < 0) {
            govMsg("gaAdminMsg", "The zone size is a whole number; 0 means no cutoff.", "var(--warn)");
            return;
          }
          try {
            const r = await (await postJson("/api/gauge/zone", { size })).json();
            govMsg("gaAdminMsg", r.ok ? `Reward zone set to ${size}. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) loadGauge();
          } catch { govMsg("gaAdminMsg", "Request failed.", "var(--warn)"); }
        });
      }

      if ($("gaMarketAdd")) {
        $("gaMarketAdd").addEventListener("click", async () => {
          const venue = $("gaNewVenue").value;
          const label = ($("gaNewLabel").value || "").trim();
          if (!label) { govMsg("gaAdminMsg", "A market needs a name voters will recognise.", "var(--warn)"); return; }
          const body = venue === "amm"
            ? { venue, poolId: ($("gaNewPool").value || "0").trim(), label }
            : { venue, asset: $("gaNewAsset").value, side: Number($("gaNewSide").value), label };
          try {
            const r = await (await postJson("/api/gauge/market", body)).json();
            govMsg("gaAdminMsg", r.ok ? `Listed. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("gaNewLabel").value = ""; loadGauge(); }
          } catch { govMsg("gaAdminMsg", "Request failed.", "var(--warn)"); }
        });
      }

      /* ---- Pausing emissions (operator) ------------------------------------ */
      async function setEmissionsPaused(which, paused) {
        const url = which === "lp" ? "/api/amm/emissions/pause" : "/api/lending/emissions/pause";
        try {
          const r = await (await postJson(url, { paused })).json();
          govMsg("govPauseMsg",
            r.ok
              ? `${which === "lp" ? "Liquidity" : "Lending"} emissions ${paused ? "paused" : "running"} — nothing already earned was touched. ${r.txHash}`
              : (r.error || "failed"),
            r.ok ? "var(--good)" : "var(--warn)");
          if (r.ok) { loadEmissions(); loadLpEmissions(); }
        } catch { govMsg("govPauseMsg", "Request failed.", "var(--warn)"); }
      }
      if ($("govEmPause")) {
        $("govEmPause").addEventListener("click", () =>
          setEmissionsPaused("lending", !(window.__emissions && window.__emissions.paused)));
      }
      if ($("govLpPause")) {
        $("govLpPause").addEventListener("click", () =>
          setEmissionsPaused("lp", !(window.__lpEmissions && window.__lpEmissions.paused)));
      }

      /* ---- Delegation to somebody else ------------------------------------- */
      if ($("govDelegateSet")) {
        $("govDelegateSet").addEventListener("click", async () => {
          if (!selfMode()) {
            govMsg("govDelegateMsg", "Delegating is signed by the holder — switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          const typed = ($("govDelegateTo").value || "").trim();
          if (typed && !/^0x[0-9a-fA-F]{40}$/.test(typed)) {
            govMsg("govDelegateMsg", "That is not an address. Leave it empty to delegate to yourself.", "var(--warn)");
            return;
          }
          await selfCustody("govDelegateMsg", typed ? `delegate to ${typed.slice(0, 10)}…` : "delegate to yourself",
            async (from, cfg) => sendTx(from, cfg.token, callData(cfg.selectors.govDelegate, encAddr(typed || from))),
          );
          loadGovernance();
          loadGauge();
        });
      }

      /* ---- Liquidity emissions --------------------------------------------- */
      window.__lpEmissions = null;

      async function loadLpEmissions() {
        const card = $("amEmissions");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/amm/emissions" + q)).json();
          window.__lpEmissions = r && r.ok && r.deployed && r.configured ? r : null;
          if (!window.__lpEmissions) { card.style.display = "none"; return; }
          card.style.display = "";
          $("amEmAmount").textContent = r.yourClaimable ?? "0";
          $("amEmSymbol").textContent = r.reward.symbol;
          $("amEmNote").textContent =
            (r.paused ? "Paused — nothing is accruing right now. What you have already earned is still claimable. " : "") +
            `Pot: ${r.reward.balance} ${r.reward.symbol}` +
            (r.reward.runwayDays == null ? " · nothing streaming" : ` · about ${r.reward.runwayDays.toFixed(1)} days left at the current rates`) +
            `. Paid out all time: ${r.reward.claimedAllTime}.`;
          $("amEmRows").innerHTML = (r.pools || []).length
            ? r.pools.map((p) => {
                const perDay = Number(p.ratePerSecond) / 1e18 * 86400;
                const share = Number(p.totalShares) > 0
                  ? (Number(p.yourShares) / Number(p.totalShares)) * 100
                  : 0;
                return (
                  `<tr><td><b>${esc(p.name)}</b>` +
                  `<div class="muted" style="font-size:11px">depth $${esc(p.depthUsd.toFixed(2))}</div></td>` +
                  `<td class="num">${perDay > 0 ? `<span class="tsraIcon"></span> ${perDay.toFixed(2)}/day` : "—"}</td>` +
                  `<td class="num">${esc(share.toFixed(2))}%</td>` +
                  `<td class="num mono">${esc((Number(p.claimable) / 1e18).toFixed(6))}</td></tr>`
                );
              }).join("")
            : emptyRow(4, "No pools.");
          $("amEmClaim").disabled = !(BigInt(r.yourClaimableRaw || "0") > 0n);
          const lpBtn = $("govLpPause");
          if (lpBtn) lpBtn.textContent = r.paused ? "Resume liquidity" : "Pause liquidity";
        } catch {
          card.style.display = "none";
        }
      }

      if ($("amEmClaim")) {
        $("amEmClaim").addEventListener("click", async () => {
          const em = window.__lpEmissions;
          if (!em) return;
          const ids = (em.pools || []).filter((p) => BigInt(p.claimable || "0") > 0n).map((p) => BigInt(p.poolId));
          if (!ids.length) {
            govMsg("amEmMsg", "Nothing has accrued to claim yet.", "var(--warn)");
            return;
          }
          if (!selfMode()) {
            govMsg("amEmMsg", "Rewards are paid to whoever earned them, so this needs your own wallet. " +
              "Switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          const btn = $("amEmClaim");
          btn.disabled = true;
          await selfCustody("amEmMsg", `claim ${em.yourClaimable} ${em.reward.symbol}`, async (from, cfg) =>
            // claim(uint256[]): one dynamic array, so the head is a single
            // offset to the length word.
            sendTx(from, cfg.lpEmissions, callData(cfg.selectors.lpClaim, encUint(32), encArray(ids))),
          );
          btn.disabled = false;
          loadLpEmissions();
        });
      }

      /* ---- Agent service fees: USDC or TSRA --------------------------------
       *
       * Two ways to pay for the same thing, priced side by side so the choice
       * is a comparison rather than a leap of faith.
       */
      window.__feeCredit = null;

      async function loadFeeCredit() {
        const card = $("feeCreditCard");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/fees/credit" + q)).json();
          window.__feeCredit = r && r.ok && r.deployed ? r : null;
          if (!window.__feeCredit) { card.style.display = "none"; return; }
          card.style.display = "";
          $("feeCredit").textContent = r.you ? `${r.you.credit} USDC` : "connect a wallet";
          $("feeHeldUsdc").textContent = r.you ? r.you.usdcHeld : "—";
          $("feeHeldTsra").textContent = r.you ? r.you.tsraHeld : "—";
          $("feeDiscount").textContent = r.rateSet ? `${(r.discountBps / 100).toFixed(0)}%` : "no rate set";
          $("feeBuyTsra").disabled = !r.rateSet;
          $("feeWithdraw").disabled = !(r.you && r.you.canWithdraw);
          $("feeQuote").textContent = r.rateSet
            ? `A dollar of credit costs 1.00 USDC, or ${r.tsraPerUsdcCredit} TSRA. ` +
              `${r.totalCredit} USDC of credit outstanding across all buyers; ${r.totalSpent} drawn down all time.`
            : "No TSRA rate is set, so credit is USDC-only for now.";

          $("feeAdmin").style.display = adminId ? "" : "none";
          if (adminId && r.rateSet) {
            // Shown as tokens per dollar, which is the number a human sets.
            const perDollar = Number(r.tsraPerUsdcCredit) / (1 - r.discountBps / 10000);
            if (document.activeElement !== $("feeRateTokens")) $("feeRateTokens").value = perDollar.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
            if (document.activeElement !== $("feeRateDiscount")) $("feeRateDiscount").value = String(r.discountBps);
          }
        } catch {
          card.style.display = "none";
        }
      }

      /** Live TSRA cost for the amount typed, so neither route is a guess. */
      let feeQuoteTimer = null;
      if ($("feeAmount")) {
        $("feeAmount").addEventListener("input", () => {
          clearTimeout(feeQuoteTimer);
          feeQuoteTimer = setTimeout(async () => {
            const r = window.__feeCredit;
            if (!r || !r.rateSet) return;
            const parsed = parseAmount($("feeAmount").value, 6);
            if (!parsed.raw) return;
            try {
              const q = await (await fetch(`/api/fees/quote?credit=${parsed.raw}`)).json();
              if (q.ok) {
                $("feeQuote").textContent =
                  `${q.creditUsdc} USDC of credit costs ${q.creditUsdc} USDC — or ${q.costTsra} TSRA, ` +
                  `which is ${(r.discountBps / 100).toFixed(0)}% less than the same credit at the headline rate.`;
              }
            } catch { /* leave the standing text */ }
          }, 250);
        });
      }

      async function buyCredit(inTsra) {
        const r = window.__feeCredit;
        if (!r) return;
        if (!selfMode()) {
          govMsg("feeMsg", "Credit is bought out of your own wallet, so this needs it. " +
            "Switch on \"Use my own wallet\".", "var(--warn)");
          return;
        }
        const parsed = parseAmount($("feeAmount").value, 6);
        if (!parsed.raw) { govMsg("feeMsg", parsed.error || "Enter an amount.", "var(--warn)"); return; }
        const cfgAll = await loadDefiConfig();
        const asset = inTsra ? cfgAll.token : cfgAll.usdc;
        // What has to be approved differs by route: USDC is credited at par, so
        // the approval is the credit itself; TSRA is priced by the contract, so
        // the approval is the quote.
        let approve = BigInt(parsed.raw);
        if (inTsra) {
          const q = await (await fetch(`/api/fees/quote?credit=${parsed.raw}`)).json();
          if (!q.ok) { govMsg("feeMsg", q.error || "Could not price that in TSRA.", "var(--warn)"); return; }
          approve = BigInt(q.costRaw);
        }
        await selfCustody("feeMsg", `buy ${$("feeAmount").value} USDC of credit`, async (from, cfg) => {
          await ensureAllowance(from, asset, cfg.serviceFees, approve);
          return sendTx(from, cfg.serviceFees, callData(
            inTsra ? cfg.selectors.feeTopUpTsra : cfg.selectors.feeTopUpUsdc, encUint(parsed.raw),
          ));
        });
        loadFeeCredit();
      }

      if ($("feeBuyUsdc")) $("feeBuyUsdc").addEventListener("click", () => buyCredit(false));
      if ($("feeBuyTsra")) $("feeBuyTsra").addEventListener("click", () => buyCredit(true));

      if ($("feeWithdraw")) {
        $("feeWithdraw").addEventListener("click", async () => {
          if (!selfMode()) {
            govMsg("feeMsg", "A refund goes back to the address that paid — switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          await selfCustody("feeMsg", "take back your unspent credit", async (from, cfg) =>
            sendTx(from, cfg.serviceFees, callData(cfg.selectors.feeWithdraw)),
          );
          loadFeeCredit();
        });
      }

      if ($("feeRateSet")) {
        $("feeRateSet").addEventListener("click", async () => {
          const tokensPerDollar = ($("feeRateTokens").value || "").trim();
          const discountBps = Number(($("feeRateDiscount").value || "0").trim());
          try {
            const r = await (await postJson("/api/fees/rate", { tokensPerDollar, discountBps })).json();
            govMsg("feeAdminMsg", r.ok ? `Rate set — credit already bought keeps the value it was bought at. ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) loadFeeCredit();
          } catch { govMsg("feeAdminMsg", "Request failed.", "var(--warn)"); }
        });
      }

      if ($("feeCharge")) {
        $("feeCharge").addEventListener("click", async () => {
          const user = ($("feeChargeUser").value || "").trim();
          const parsed = parseAmount($("feeChargeAmount").value, 6);
          if (!parsed.raw) { govMsg("feeAdminMsg", parsed.error || "Enter an amount.", "var(--warn)"); return; }
          try {
            const r = await (await postJson("/api/fees/charge", {
              user, amount: parsed.raw, memo: ($("feeChargeMemo").value || "agent services").trim(),
            })).json();
            govMsg("feeAdminMsg", r.ok ? `Charged. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("feeChargeAmount").value = ""; loadFeeCredit(); }
          } catch { govMsg("feeAdminMsg", "Request failed.", "var(--warn)"); }
        });
      }

      /* ---- Standing token approvals ---------------------------------------
       *
       * Until this session the app approved `type(uint256).max` on every
       * supply, deposit and swap. Auditing a real wallet on Arc found three of
       * those still live — pool, vault and AMM each holding an unlimited
       * standing permission over its USDC, granted for a single 1-USDC action
       * months ago and outliving it by design.
       *
       * Approving exactly the amount stops new ones. It does nothing about the
       * grants already out there, and those are the ones that matter: an
       * unlimited approval is a promise that whoever controls that contract —
       * now or after an upgrade — can take the whole balance. Every approval
       * drain of the last two years ran through one.
       *
       * So: show them, and make taking them back one tap.
       */
      const MAX_UINT = (1n << 256n) - 1n;
      // Treat anything within a hair of 2^256-1 as unlimited: a max approval
      // that has been partially spent is still, for every practical purpose,
      // unlimited — and that is exactly what a legacy grant looks like today.
      const isUnlimited = (v) => v > MAX_UINT / 2n;

      function allowMsg(text, colour) {
        const m = $("allowanceMsg");
        if (!m) return;
        m.style.display = "block"; m.textContent = text; m.style.color = colour || "var(--muted)";
      }

      async function loadAllowances() {
        const card = $("allowanceCard");
        if (!card) return;
        if (!selfMode() || !eth()) { card.style.display = "none"; return; }
        let from, cfg;
        try {
          const [a] = await eth().request({ method: "eth_accounts" });
          from = a;
          if (!from || !(await onArc())) { card.style.display = "none"; return; }
          cfg = await loadDefiConfig();
        } catch { card.style.display = "none"; return; }

        const spenders = [
          ["Lending pool", cfg.pool], ["Yield vault", cfg.vault],
          ["Swap router", cfg.router], ["Liquidity pools", cfg.amm],
        ].filter(([, addr]) => addr);
        const assets = (cfg.assets || []).filter((a) => a && a.address);

        const rows = [];
        await Promise.all(
          assets.flatMap((a) =>
            spenders.map(async ([label, spender]) => {
              try {
                const hex = await ethCall(
                  a.address, callData(cfg.selectors.allowance, encAddr(from), encAddr(spender)),
                );
                const v = BigInt(hex || "0x0");
                if (v > 0n) rows.push({ asset: a, label, spender, value: v });
              } catch { /* a failed read is not a zero allowance — just omit it */ }
            }),
          ),
        );

        if (!rows.length) { card.style.display = "none"; return; }
        card.style.display = "";
        // Unlimited first: it is the one worth acting on.
        rows.sort((x, y) => (isUnlimited(y.value) ? 1 : 0) - (isUnlimited(x.value) ? 1 : 0));
        const unlimited = rows.filter((r) => isUnlimited(r.value));
        card.style.borderColor = unlimited.length
          ? "color-mix(in srgb, var(--warn) 45%, var(--line))" : "";

        $("allowanceRows").innerHTML = rows
          .map((r, i) => {
            const dec = Number(r.asset.decimals ?? 6);
            const amount = isUnlimited(r.value)
              ? `<b style="color:var(--warn)">unlimited</b>`
              : `${esc(fmtUnitsStr(r.value, dec))} ${esc(r.asset.symbol)}`;
            return (
              `<div class="row-actions" style="justify-content:space-between;gap:10px;flex-wrap:wrap">` +
              `<span class="kv" style="flex:1;min-width:200px">` +
              `<b>${esc(r.asset.symbol)}</b> → ${esc(r.label)}: ${amount}</span>` +
              `<button class="btn" data-revoke="${i}">Revoke</button></div>`
            );
          })
          .join("");
        $("allowRevokeAll").style.display = unlimited.length > 1 ? "" : "none";

        const revoke = async (r) => {
          await selfCustody("allowanceMsg", `revoke ${r.asset.symbol} for ${r.label}`, async (fromAddr, c) =>
            sendTx(fromAddr, r.asset.address, c.selectors.approve + encAddr(r.spender) + encUint(0)),
          );
          loadAllowances();
        };
        $("allowanceRows").querySelectorAll("[data-revoke]").forEach((btn) => {
          btn.addEventListener("click", () => revoke(rows[Number(btn.dataset.revoke)]));
        });
        /*
         * Revoke several without looking like an attack.
         *
         * The first version called the single-revoke path in a loop, and each
         * pass re-entered the whole self-custody flow: a permission request, a
         * chain check, a transaction, then `afterTx` and a full reload of this
         * panel — every one of them firing more calls at the wallet. Three
         * revokes became a rapid burst of prompts and RPC, the wallet offered
         * to block the site, and a blocked site cannot reconnect.
         *
         * So the account and chain are resolved once, the transactions go out
         * one at a time with each confirmed before the next is offered, and the
         * panel reloads once at the end instead of after every item.
         */
        $("allowRevokeAll").onclick = async () => {
          const btn = $("allowRevokeAll");
          btn.disabled = true;
          const done = [];
          try {
            const from = await selfAccount(); // once, not once per approval
            const c = await loadDefiConfig();
            for (let i = 0; i < unlimited.length; i++) {
              const r = unlimited[i];
              allowMsg(
                `Revoking ${r.asset.symbol} for ${r.label} — ${i + 1} of ${unlimited.length}. ` +
                `Confirm in your wallet.`,
                "var(--muted)",
              );
              const hash = await sendTx(from, r.asset.address, c.selectors.approve + encAddr(r.spender) + encUint(0));
              // Wait for each one. Queueing them all at once is what makes a
              // wallet suspicious, and it also makes a failure impossible to
              // attribute to the approval it belongs to.
              const rec = await waitForTx(hash);
              if (rec && !receiptOkHex(rec.status)) {
                allowMsg(`Revoking ${r.asset.symbol} for ${r.label} failed on chain. Stopped here.`, "var(--warn)");
                return;
              }
              done.push(`${r.asset.symbol} → ${r.label}`);
            }
            allowMsg(
              done.length ? `Revoked ${done.join(", ")}. Nothing else can move those tokens.` : "Nothing to revoke.",
              "var(--good)",
            );
          } catch (e) {
            allowMsg(
              (done.length ? `Revoked ${done.join(", ")}, then stopped: ` : "") + walletError(e),
              "var(--warn)",
            );
          } finally {
            btn.disabled = false;
            // One reload, at the end.
            loadAllowances().catch(() => {});
            afterTx();
          }
        };
        if (unlimited.length) {
          allowMsg(
            `${unlimited.length} unlimited approval${unlimited.length > 1 ? "s" : ""} standing. ` +
            `Each one lets that contract move all of your ${unlimited.map((r) => r.asset.symbol).join(", ")} ` +
            `at any time. Revoking costs one transaction and breaks nothing — the app re-approves the exact ` +
            `amount next time you act.`,
            "var(--warn)",
          );
        } else allowMsg("No unlimited approvals. Everything below is a bounded leftover.", "var(--muted)");
      }
      if ($("allowRefresh")) $("allowRefresh").addEventListener("click", () => loadAllowances());

      /*
       * Reflect whether a wallet is available — and keep reflecting it.
       *
       * This used to run once, synchronously, at load. If no provider had
       * appeared by then it set `disabled = true` and `checked = false`, and
       * nothing ever undid that. But a provider arriving late is the normal
       * case, not the edge one: EIP-6963 wallets announce asynchronously, and
       * mobile in-app browsers routinely inject `window.ethereum` a second or
       * two after first paint.
       *
       * So the toggle latched off on exactly the devices this feature exists
       * for, and everything downstream followed it: `selfMode()` returned
       * false, so the vault, the swap desk and the liquidity pools all routed
       * to the operator endpoints and answered "sign in with the Admin
       * button", and the lending panel showed the *agent's* position — a
       * wallet balance of 520 USDC and no debt, to somebody holding 73 with a
       * loan outstanding. One latch, most of a bug report.
       *
       * It now re-runs whenever a provider shows up, and restores the toggle.
       */
      let hadWallet = null; // tri-state: unknown until the first check
      function reflectWalletAvailability() {
        const t = $("selfCustodyToggle");
        if (!t) return;
        const have = hasInjectedWallet();
        if (have === hadWallet) return; // nothing changed; don't fight the user
        hadWallet = have;
        const note = $("custodyNote");
        if (have) {
          // A wallet appeared. Give the control back and turn it on — landing
          // in operator mode with a wallet connected is never what was wanted.
          const wasDisabled = t.disabled;
          t.disabled = false;
          t.title = "";
          if (wasDisabled) t.checked = true;
          if (note) {
            note.textContent = selfMode()
              ? "Self-custody: your wallet signs and your own funds move. No sign-in needed."
              : "Agent wallet: actions spend the app's agent funds and require an operator (Admin) sign-in.";
          }
          refreshMyPositions().catch(() => {});
          if (typeof loadAllowances === "function") loadAllowances().catch(() => {});
          tick();
        } else {
          t.checked = false;
          t.disabled = true;
          t.title = "No browser wallet detected";
          if (note) {
            note.textContent =
              "No browser wallet detected, so self-custody is unavailable here. Actions use the app's " +
              "agent wallet and need an operator (Admin) sign-in. Open this page in a wallet browser, " +
              "or install a wallet extension, to transact with your own funds.";
          }
        }
      }
      reflectWalletAvailability();
      // Three ways a provider announces itself, and none of them is reliably
      // before load — so listen for all three rather than sampling once.
      window.addEventListener("eip6963:announceProvider", () => reflectWalletAvailability());
      window.addEventListener("ethereum#initialized", () => reflectWalletAvailability());
      (function pollForWallet() {
        // Bounded: ten seconds is far longer than any wallet takes, and after
        // that the "no wallet detected" message is the honest answer.
        let n = 0;
        const id = setInterval(() => {
          askWallets();
          reflectWalletAvailability();
          if (hasInjectedWallet() || ++n > 20) clearInterval(id);
        }, 500);
      })();

      if ($("selfCustodyToggle")) {
        $("selfCustodyToggle").addEventListener("change", () => {
          const on = selfMode();
          if (!on) clearMine(); else refreshMyPositions().catch(() => {});
          if (typeof loadAllowances === "function") loadAllowances().catch(() => {});
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
      /* Hoisted: the governance detail view renders addresses too, and two
         definitions of "short" is how the same wallet reads differently in
         two places on one page. */
      var shortAddr = (a) => String(a).slice(0, 8) + "…" + String(a).slice(-4);

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
                ? `<a href="${esc(explorerBase())}/tx/${esc(x.txHash)}" target="_blank" rel="noopener">${esc(x.txHash.slice(0, 10))}…</a>`
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
                `<span class="mono" style="font-size:12px"><a href="${esc(explorerBase())}/address/${esc(addr)}" target="_blank" rel="noopener">${esc(short(addr))}</a></span></div>`
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
      // Approvals change rarely; a slow poll keeps the panel honest without noise.
      setInterval(() => { if (typeof loadAllowances === "function") loadAllowances().catch(() => {}); }, 60000);
      // Emissions tick slowly by design; a slow poll keeps the figure honest.
      setInterval(() => { if (typeof loadEmissions === "function") loadEmissions().catch(() => {}); }, 30000);
      setInterval(() => { if (typeof loadLpEmissions === "function") loadLpEmissions().catch(() => {}); }, 30000);
      setInterval(() => { if (typeof loadFeeCredit === "function") loadFeeCredit().catch(() => {}); }, 30000);
      setInterval(() => {
        if ($("paneGov") && !$("paneGov").hidden && typeof loadGovernance === "function") loadGovernance().catch(() => {});
        if ($("paneGov") && !$("paneGov").hidden && typeof loadGauge === "function") loadGauge().catch(() => {});
      }, 20000);
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
