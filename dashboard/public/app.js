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
      const TABS = ["dashboard", "defi", "agents", "nft", "wallet", "gov", "other"];
      // Plain names: the icons live in the drawer markup as SVG now, so the
      // labels no longer smuggle a glyph that would end up in the tab title.
      const NAV_LABELS = {
        home: "Home",
        dashboard: "Dashboard",
        defi: "DeFi",
        agents: "Agent workspace",
        wallet: "Wallet",
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
      /**
       * Keep the current section's name on screen at both ends of the row.
       *
       * The label is centred under its own icon, which is right for the five
       * in the middle and wrong for the two at the ends: "Treasury & system"
       * centred under the last icon runs off the right of the screen and is
       * cut in half. CSS cannot clamp a centred absolute box to its scroll
       * container, so this measures and nudges it back inside — the label
       * stays under its icon wherever it can, and slides in only as far as it
       * must to be readable.
       */
      function placeNavLabel() {
        const btn = document.querySelector('#navDrawer [data-nav][aria-current="page"]');
        const lbl = btn && btn.querySelector(".navLbl");
        if (!lbl) return;
        lbl.style.transform = "translateX(-50%)";
        const inner = btn.closest(".inner") || btn.parentElement;
        const pad = 8;
        const r = lbl.getBoundingClientRect();
        const bounds = inner.getBoundingClientRect();
        let shift = 0;
        if (r.left < bounds.left + pad) shift = bounds.left + pad - r.left;
        else if (r.right > bounds.right - pad) shift = bounds.right - pad - r.right;
        if (shift) lbl.style.transform = `translateX(calc(-50% + ${Math.round(shift)}px))`;
      }
      window.addEventListener("resize", () => placeNavLabel());

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
          // On arrival rather than on a poll: it is a loop of contract reads,
          // and nothing it reports changes second to second.
          if (route === "dashboard" && typeof loadClaimables === "function") loadClaimables().catch(() => {});
          if (route === "gov" && typeof setGovTab === "function") setGovTab(govTab);
          // The DeFi panes are the expensive ones, so they load when you get
          // here rather than while you are somewhere else.
          if (route === "defi" && typeof setDefiTab === "function") setDefiTab(defiTab, { scroll: false });
          // Balances and the task list are reads of their own; they load when
          // you arrive rather than on every poll of every other tab.
          // Sessions first: it is the slowest of the three and the one the pane
          // is mostly made of.
          // The wallet's tabs load their own data, so arriving here is just a
          // matter of showing the one that was last open.
          if (route === "wallet" && typeof setWalletTab === "function") setWalletTab(walletTab, { scroll: false });
          // A loop of contract reads over every drop, so it loads on arrival
          // rather than on every poll of every other tab.
          if (route === "nft" && typeof loadNft === "function") loadNft().catch(() => {});
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
        placeNavLabel();
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

      /* ---- "this pane is still reading" -----------------------------------
       *
       * Every sub-tab in the app is fed by chain reads, and a few of them —
       * governance most of all — are a dozen contract calls behind a public
       * RPC. Switching to one used to show either nothing or the previous
       * tab's numbers until the reads landed, which is indistinguishable from
       * a pane that failed. One strip at the top of the pane says it is
       * working, and every tab gets it from the switcher rather than each
       * loader having to grow its own.
       *
       * Built with textContent rather than a template so it can run during the
       * script's initial evaluation, before the formatting helpers below exist.
       */
      function paneBusy(paneId, label) {
        const pane = $(paneId);
        if (!pane) return () => {};
        let strip = pane.firstElementChild;
        if (!strip || !strip.classList || !strip.classList.contains("paneBusy")) {
          strip = document.createElement("div");
          strip.className = "paneBusy";
          strip.appendChild(Object.assign(document.createElement("span"), { className: "spin" }));
          strip.appendChild(document.createElement("span"));
          pane.prepend(strip);
        }
        const said = label || "Reading the chain…";
        strip.lastElementChild.textContent = said;
        strip.style.display = "flex";
        pane.setAttribute("aria-busy", "true");
        /*
         * A ring that has been turning for fifteen seconds should say so.
         *
         * Some of these reads are genuinely slow — the fee pane's first load
         * waits on a one-off pass over the collector's whole history — and a
         * strip that says the same four words throughout is indistinguishable
         * from one that is stuck. Naming it is the difference between "this is
         * taking a while" and "this is broken".
         */
        const slow = setTimeout(() => {
          strip.lastElementChild.textContent = `${said} taking longer than usual — still going.`;
        }, 15_000);
        slow.unref?.();
        let cleared = false;
        return () => {
          if (cleared) return;
          cleared = true;
          clearTimeout(slow);
          strip.style.display = "none";
          pane.removeAttribute("aria-busy");
        };
      }
      /** Run a pane's loaders with its busy strip up until they all settle. */
      function withPaneBusy(paneId, run, label) {
        const clear = paneBusy(paneId, label);
        let out;
        try { out = run(); } catch (e) { clear(); throw e; }
        return Promise.resolve(out).then(
          (v) => { clear(); return v; },
          (e) => { clear(); throw e; },
        );
      }

      /* ---- DeFi sub-tabs -------------------------------------------------
       * One tab per function instead of four long cards stacked in a column.
       * Purely a view switch: no fetching hangs off it, because the DeFi panels
       * are all fed by the same `/api/state` poll. */
      /**
       * The Wallet pane's own tabs.
       *
       * Same reasoning as the DeFi strip: four long cards stacked meant
       * scrolling past three to reach the fourth, and the scheduled-task table
       * is the one people come back to most.
       */
      const WALLET_PANES = { send: "walletSend", sessions: "walletSessions", tasks: "walletTasks", series: "walletSeries" };
      const WALLET_TAB_KEY = "tessera_wallet_tab";
      let walletTab = (() => {
        try { return localStorage.getItem(WALLET_TAB_KEY) || "send"; } catch { return "send"; }
      })();

      function setWalletTab(tab, opts) {
        if (!(tab in WALLET_PANES)) tab = "send";
        walletTab = tab;
        try { localStorage.setItem(WALLET_TAB_KEY, tab); } catch {}
        for (const [name, id] of Object.entries(WALLET_PANES)) {
          const el = $(id);
          if (el) el.hidden = name !== tab;
        }
        document.querySelectorAll("[data-wallettab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.wallettab === tab));
        // Each tab's data loads when you arrive at it, not while you are on
        // another one — the same rule the routes follow.
        const pane = WALLET_PANES[tab];
        /*
         * A form needs what it offers, not just what it lists.
         *
         * Both the task form and the series step composer pick an asset and a
         * session, and those come from `loadWallet` and `loadSessions` — so
         * arriving straight at either tab used to show a form whose dropdowns
         * were empty until some other tab happened to fill them. They load
         * what they need, on arrival, like everything else.
         */
        const forForm = () => Promise.all([
          typeof loadWallet === "function" ? loadWallet() : null,
          typeof loadSessions === "function" ? loadSessions() : null,
        ]);
        const load =
          tab === "send" && typeof loadWallet === "function" ? () => loadWallet()
          : tab === "sessions" && typeof loadSessions === "function" ? () => loadSessions()
          : tab === "tasks" && typeof loadTasks === "function" ? () => Promise.all([loadTasks(), forForm()])
          : tab === "series" && typeof loadSeries === "function" ? () => Promise.all([loadSeries(), forForm()])
          : null;
        if (load) {
          withPaneBusy(pane, load, tab === "sessions" ? "Reading your sessions from the chain…" : "Loading…")
            .catch(() => {});
        }
        if (!opts || opts.scroll !== false) {
          const dock = $("walletTabs");
          if (dock) dock.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }

      const DEFI_PANES = {
        lending: "defiLending", vault: "defiVault", swap: "defiSwap", amm: "defiAmm", fees: "defiFees",
      };
      /** Which tab owns each card, so a deep link can open the right one. */
      const DEFI_CARD_TAB = {
        lendingCard: "lending", vaultCard: "vault", swapCard: "swap", ammCard: "amm", feesCard: "fees",
      };
      /*
       * The same map for governance, and for the same reason.
       *
       * `scrollIntoView` on a hidden element does nothing, so a deep link into a
       * card that lives inside a closed sub-tab lands the reader on whichever
       * tab happened to be open — the link appears to work and quietly goes
       * somewhere else. Every governance card the landing page points at needs
       * its pane opened first.
       */
      const GOV_CARD_TAB = {
        govProposalsCard: "proposals", govDetailCard: "proposals", govCreateCard: "proposals",
        govDiscussionsCard: "proposals", govGaugeCard: "markets", govBribeCard: "markets",
        govDelegateCard: "delegates", govEmissionsCard: "emissions", govRegistryCard: "registry",
      };
      const DEFI_TAB_KEY = "tessera_defi_tab";
      let defiTab = "lending";

      /* Per-venue state for the holder leaderboards and fee charts. Declared
         here, above setDefiTab: that runs while the script is still evaluating
         (it restores the saved tab), so anything it reaches must already exist. */
      const HOLD_VENUES = {
        Lending: { kind: "lending", series: "toLending", label: "lending pool" },
        Vault: { kind: "vault", series: "toVault", label: "vault" },
        /*
         * The swap card asks "who earns from it", and the honest answer is the
         * liquidity providers — so it reads the AMM's holders, not the router's.
         *
         * `kind: "swap"` returns an empty set by design: the router holds
         * nothing, because it takes the input, routes it and pays the output out
         * in one transaction. That was rendered as a table with headers and no
         * rows directly beneath a paragraph explaining there was no leaderboard
         * — which reads as a panel that failed to load rather than one with
         * nothing to say. The people the paragraph points at are exactly the
         * ones `kind: "amm"` lists, so it lists them here.
         */
        Swap: { kind: "amm", series: "toSwap", label: "AMM pools" },
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
        /*
         * Load the venue's data only when the venue is on screen.
         *
         * This ran during initial evaluation whatever route the page had
         * landed on, so opening #wallet fired the lending tab's holder scan,
         * prices, backstop, auction, borrowers and emissions first — six
         * chain-heavy requests, some of them five seconds each, ahead of the
         * ones that draw the pane you are actually looking at. On a phone,
         * where the browser allows six connections in total, the session table
         * waited sixteen seconds for its turn. `showView` loads this on
         * arrival instead, the same as every other route.
         */
        const onScreen = $("paneDefi") && !$("paneDefi").hidden;
        if (tab === "fees" && onScreen) withPaneBusy(DEFI_PANES.fees, loadFees).catch(() => {});
        // Each venue tab carries its own holder leaderboard and fee history.
        // Loaded on switch rather than up front: a holder scan is a windowed
        // log sweep, and doing four of them for tabs nobody opened is waste.
        const venueKey = { lending: "Lending", vault: "Vault", swap: "Swap", amm: "Amm" }[tab];
        if (venueKey && onScreen) withPaneBusy(DEFI_PANES[tab], () => loadVenuePanels(venueKey)).catch(() => {});
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

      if ($("walletTabs")) {
        document.querySelectorAll("[data-wallettab]").forEach((b) =>
          b.addEventListener("click", () => setWalletTab(b.dataset.wallettab)));
        // Show the remembered tab without loading anything: the route handler
        // does that on arrival, and this runs whatever route the page opened on.
        for (const [name, id] of Object.entries(WALLET_PANES)) {
          const el = $(id);
          if (el) el.hidden = name !== walletTab;
        }
        document.querySelectorAll("[data-wallettab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.wallettab === walletTab));
      }

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
        if (anchor && GOV_CARD_TAB[anchor]) setGovTab(GOV_CARD_TAB[anchor]);
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
      /*
       * Escape for HTML — including the quotes.
       *
       * This escaped `& < >` only, which is enough for text between tags and
       * not enough for an attribute: `title="${esc(x)}"` with a quote in `x`
       * closes the attribute and everything after it is markup. Nothing in the
       * page puts free text in an attribute today, so this is closing the door
       * rather than a live hole — but "safe as long as nobody adds a title
       * attribute" is not a property anybody can maintain.
       *
       * `esc` is never assigned to `textContent` anywhere, so escaping quotes
       * cannot leave a literal `&quot;` on screen.
       */
      const esc = (s) => String(s == null ? "" : s)
        .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
        /*
         * Emissions move with the position, so the card has to be re-read.
         *
         * Supplying changes your share of the market, and a share of the market
         * is exactly what the reward stream pays against — one system, not two
         * that happen to sit on the same page. Without this the claim figure
         * kept whatever it had been rendered with and only corrected on its own
         * poll, which reads as the number wandering and then reversing.
         */
        if (typeof loadEmissions === "function") loadEmissions();
        setTimeout(() => {
          tick({ fresh: true });
          refreshMyPositions().catch(() => {});
          // Again once the settle transaction has had time to land.
          if (typeof loadEmissions === "function") loadEmissions();
          if (defiTab === "lending" && typeof loadBorrowers === "function") loadBorrowers();
          const key = { lending: "Lending", vault: "Vault", swap: "Swap", amm: "Amm" }[defiTab];
          if (key && typeof loadHolders === "function") {
            loadHolders(key, { refresh: true });
            loadVenueChart(key);
          }
          /*
           * The reward panels move with a deposit too, and nothing was
           * re-reading them.
           *
           * Adding liquidity creates the LP shares that emissions accrue
           * against, so the moment after the transaction is exactly when the
           * card is most wrong — and it was still saying "you hold no liquidity
           * in these pools, so nothing is accruing" to somebody who had just
           * put some in. The reads are live rather than cached, so a re-read is
           * all it needed.
           */
          if (typeof loadLpEmissions === "function") loadLpEmissions().catch(() => {});
          if (typeof loadEmissions === "function") loadEmissions().catch(() => {});
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
          if (typeof loadMyAssets === "function") loadMyAssets().catch(() => {});
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
            <button class="btn" style="border-color:#14532d;background:#0c2c1e;color:var(--good)" data-verdict="approve" data-approval="${esc(a.id)}">Approve ✓</button>
            <button class="btn" style="border-color:#531414;background:#2c0c0c;color:var(--bad)" data-verdict="reject" data-approval="${esc(a.id)}">Reject ✗</button>
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
          /*
           * A missing figure prints as "n/a", never as $0.00.
           *
           * When the pool's aggregate account read fails — one listed asset the
           * risk oracle cannot price is enough — the server rebuilds supplied
           * and borrowed from the per-asset positions and sends null for the
           * borrow limit and health factor, because those are the oracle's
           * answer and it did not give one. "$0.00" there reads as "no
           * headroom" and "0.00" health reads as about to be liquidated; both
           * are alarming claims to make up.
           */
          const usd = (v) => (v == null ? "n/a" : "$" + v);
          setUnlessMine("lnSupplied", usd(ln.account.suppliedUsd));
          setUnlessMine("lnBorrowed", usd(ln.account.borrowedUsd));
          setUnlessMine("lnLimit", usd(ln.account.borrowLimitUsd));
          // Only shown when the pool exposes it. An older pool returns null and
          // the field says so rather than repeating the borrow limit as if the
          // two lines were the same.
          if ($("lnLiqLimit")) {
            $("lnLiqLimit").textContent = ln.account.liquidationLimitUsd
              ? "$" + ln.account.liquidationLimitUsd
              : ln.account.degraded
                ? "n/a"
                : "n/a on this pool";
          }
          // The collateral limit alone reads as a promise the pool may not be
          // able to keep — a $66,500 limit against $100 of lendable USDC. Show
          // what can actually be drawn, and say which constraint binds.
          if ($("lnBorrowable")) {
            $("lnBorrowable").textContent =
              ln.account.borrowableNowUsd == null ? "n/a" : "$" + ln.account.borrowableNowUsd;
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
          $("lnHealth").textContent = ln.account.healthFactor ?? "n/a";
          // Say why, once, above the numbers — a panel full of "n/a" with no
          // explanation is the same dead end as a blank one.
          if ($("lnDegraded")) {
            $("lnDegraded").style.display = ln.account.degraded ? "" : "none";
            $("lnDegraded").textContent = ln.account.why || "";
          }
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

      /*
       * The guardian's answer, on a listener rather than an `onclick`.
       *
       * These two buttons were the only inline handlers in the app, and the
       * app's own Content-Security-Policy is `script-src 'self'` with no
       * `unsafe-inline` — so the browser refused to run them and the human
       * co-signer could not answer an escalation at all. It failed closed, and
       * therefore silently: an unanswered escalation is simply never bought.
       *
       * Delegated from the card, the same way every other button here works, so
       * it survives the list being re-rendered on each poll.
       */
      const verdict = async (id, v) => {
        await postAuthed(`/api/approvals/${encodeURIComponent(id)}/${v}`).catch(() => {});
        tick();
      };
      if ($("approvals")) {
        $("approvals").addEventListener("click", async (e) => {
          const btn = e.target.closest("button[data-verdict]");
          if (!btn) return;
          btn.disabled = true;
          await verdict(btn.dataset.approval, btn.dataset.verdict);
        });
      }

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
      /*
       * The second argument is either fetch options or a JSON body.
       *
       * It started as fetch options only, so `postAuthed(url, { to, amount })`
       * spread two unknown keys into `fetch` and posted *no body at all*. The
       * request still succeeded, the server read `undefined` for every field,
       * and the failure surfaced as `row 1: "undefined" is not an address` on
       * a wallet transfer — a message that points at the recipient box, which
       * was filled in correctly. Guessing between the two shapes is not pretty,
       * but silently dropping the body of a payment request is far worse, so
       * anything that is not recognisably fetch options is treated as a body.
       */
      const FETCH_INIT_KEYS = new Set([
        "method", "headers", "body", "mode", "credentials", "cache", "redirect",
        "referrer", "referrerPolicy", "integrity", "keepalive", "signal", "window",
      ]);
      async function postAuthed(url, opts = {}) {
        const keys = Object.keys(opts);
        const init = keys.length && !keys.every((k) => FETCH_INIT_KEYS.has(k))
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(opts) }
          : opts;
        const res = await fetch(url, { method: "POST", ...init, headers: { ...(init.headers || {}), ...authHeaders() } });
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

      /**
       * A sheet that is on screen before anything can go wrong.
       *
       * The Connect button kept being reported as dead, and every cause had the
       * same shape: a branch that returned, or an await that rejected, before
       * anything had been drawn. A tap that produces no pixels is
       * indistinguishable from a broken page, and no amount of correct logic
       * behind it helps.
       *
       * So the tap opens this synchronously, and every later step only ever
       * *replaces its contents*. There is no path from here that shows nothing.
       * The wrapper carries its own inline layout as well as the class, so a
       * stylesheet that failed to load cannot hide it either.
       */
      function walletSheet() {
        closeWalletPicker();
        const wrap = document.createElement("div");
        wrap.id = "walletPicker";
        wrap.className = "modalWrap";
        wrap.style.cssText =
          "position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;" +
          "background:rgba(4,7,14,.78);padding:20px";
        const card = document.createElement("div");
        card.className = "modalCard";
        // `--text`, not `--fg`: there is no `--fg` in this stylesheet, so the
        // fallback won — a near-white default painted on a white card in light
        // mode, which is how "Connected as" and the address came out unreadable.
        card.style.cssText =
          "width:min(94vw,400px);max-height:86vh;overflow:auto;border-radius:18px;padding:18px 20px;" +
          "background:var(--bg-soft);color:var(--text);border:1px solid var(--line-strong)";
        wrap.appendChild(card);
        // The sheet's clicks are its own. Letting them reach `document` is
        // what closes menus and dropdowns behind it as a side effect.
        card.addEventListener("click", (ev) => ev.stopPropagation());
        document.body.appendChild(wrap);
        wrap.addEventListener("click", (ev) => { if (ev.target === wrap) closeWalletPicker(); });
        return {
          card,
          set(html) { card.innerHTML = html; },
          close: closeWalletPicker,
        };
      }

      const sheetCancel = '<button class="btn" data-wsheet="cancel" style="display:flex;width:100%;justify-content:center;margin-top:8px">Close</button>';

      /**
       * Connect, or explain exactly why it cannot.
       *
       * Not `async` at the top level on purpose: the sheet must be painted in
       * the same tick as the tap, before the first `await` hands control back
       * to the browser.
       */
      function connectWallet() {
        const sheet = walletSheet();
        sheet.set(`<h3 style="margin:0 0 12px;font-size:15px">Connect a wallet</h3>` +
          `<p class="muted" style="margin:0;font-size:13px"><span class="spin" aria-hidden="true"></span>Looking for a wallet…</p>` +
          sheetCancel);

        sheet.card.addEventListener("click", (ev) => {
          const b = ev.target.closest("[data-wsheet]");
          if (b && b.dataset.wsheet === "cancel") sheet.close();
        });

        runConnect(sheet).catch((e) => {
          // The last resort, and the reason this function is shaped like this:
          // whatever threw, the tap still produced something readable.
          sheet.set(`<h3 style="margin:0 0 12px;font-size:15px">Connect a wallet</h3>` +
            `<p style="margin:0;font-size:13px;color:var(--warn)">${esc(walletError(e))}</p>` + sheetCancel);
        });
      }

      async function runConnect(sheet) {
        // Wallets answer `requestProvider` synchronously, but an extension that
        // is still waking up answers a moment later. A short wait here is the
        // difference between "no wallet found" and finding it.
        askWallets();
        await new Promise((r) => setTimeout(r, 350));
        askWallets();

        const title = `<h3 style="margin:0 0 12px;font-size:15px">Connect a wallet</h3>`;
        const live = await connectedAddress();
        // A token in storage is not a session — it may have expired hours ago.
        // Ask the server before telling somebody they are connected.
        let signedIn = false;
        if (live && localStorage.getItem("tessera_token")) {
          signedIn = await fetch("/api/auth/me", { headers: authHeaders() })
            .then((r) => (r.ok ? r.json() : null)).then((j) => Boolean(j && j.address)).catch(() => false);
          if (!signedIn) localStorage.removeItem("tessera_token");
        }
        if (live && signedIn) {
          sheet.set(title +
            `<p class="muted" style="margin:0 0 6px;font-size:13px">Connected as</p>` +
            `<p class="mono" id="wsheetAddr" style="margin:0 0 10px;font-size:12.5px;word-break:break-all;color:var(--text)">${esc(live)}</p>` +
            `<button class="btn" data-wsheet="copy" style="display:flex;width:100%;justify-content:center;margin-bottom:8px">Copy address</button>` +
            `<button class="btn" data-wsheet="profile" style="display:flex;width:100%;justify-content:center;margin-bottom:8px">Open profile</button>` +
            `<button class="btn" data-wsheet="signout" style="display:flex;width:100%;justify-content:center">Sign out</button>` +
            sheetCancel);
          sheet.card.addEventListener("click", async (ev) => {
            const b = ev.target.closest("[data-wsheet]");
            if (!b) return;
            if (b.dataset.wsheet === "copy") {
              try {
                await navigator.clipboard.writeText(live);
                b.textContent = "Copied ✓";
                setTimeout(() => { b.textContent = "Copy address"; }, 1600);
              } catch {
                // Clipboard access is refused in plenty of mobile contexts.
                // Select it instead, so there is still a way to get it out.
                const r = document.createRange();
                r.selectNodeContents(sheet.card.querySelector("#wsheetAddr"));
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
                b.textContent = "Selected — copy it";
              }
            } else if (b.dataset.wsheet === "profile") {
              /*
               * Open the profile, or say why there is none.
               *
               * `#profileWrap` starts hidden and is only shown once
               * `/api/profile` has answered. With a stale token in
               * localStorage that call 401s, the wrap stays hidden, and
               * opening the panel inside it added a class to something with a
               * `display:none` parent — a button that did nothing, twice over.
               */
              const wrap = $("profileWrap");
              if (!wrap || getComputedStyle(wrap).display === "none") {
                await refreshProfile();
              }
              if (wrap && getComputedStyle(wrap).display !== "none") {
                sheet.close();
                // After this click finishes, not during it. `bindMenu` closes
                // every menu on a document click, and this click is still
                // travelling — opening now means opening and closing in the
                // same tick, which is the exact dead-button this replaced.
                setTimeout(() => { if (profileMenu && profileMenu.open) profileMenu.open(); }, 0);
              } else {
                sheet.set(title +
                  `<p style="margin:0;font-size:13px;color:var(--warn)">Your sign-in has expired, so there is no ` +
                  `profile to open. Sign out and connect again.</p>` +
                  `<button class="btn" data-wsheet="signout" style="display:flex;width:100%;justify-content:center;margin-top:10px">Sign out</button>` +
                  sheetCancel);
              }
            } else if (b.dataset.wsheet === "signout") {
              await postAuthed("/api/admin/logout").catch(() => {});
              localStorage.removeItem("tessera_token");
              setWallet(null);
              sheet.close();
              location.reload();
            }
          });
          return;
        }

        const found = [...discovered.values()];
        // `window.ethereum` without an EIP-6963 announcement is still a wallet,
        // and older injected wallets are exactly the ones that never announce.
        const legacy = !found.length && window.ethereum ? [{ info: { name: "Injected wallet", uuid: "legacy" }, provider: window.ethereum }] : [];
        const all = found.concat(legacy);

        if (all.length) {
          sheet.set(title +
            `<p class="muted" style="margin:0 0 10px;font-size:13px">Sign in with your wallet. You will be asked to approve a signature — it costs nothing and moves nothing.</p>` +
            all.map((d, i) =>
              `<button class="btn" data-wsheet="use" data-i="${i}" style="display:flex;width:100%;justify-content:flex-start;gap:10px;margin-bottom:8px">` +
              (d.info.icon ? `<img src="${esc(d.info.icon)}" alt="" width="20" height="20" style="border-radius:5px">` : "") +
              `${esc(d.info.name)}</button>`).join("") +
            sheetCancel);
          sheet.card.addEventListener("click", (ev) => {
            const b = ev.target.closest('[data-wsheet="use"]');
            if (!b) return;
            const d = all[Number(b.dataset.i)];
            chosenProvider = d.provider;
            try { localStorage.setItem("tessera_wallet_rdns", d.info.rdns || ""); } catch {}
            signInWith(sheet, d.provider).catch((e) => {
              sheet.set(title + `<p style="margin:0;font-size:13px;color:var(--warn)">${esc(walletError(e))}</p>` + sheetCancel);
            });
          });
          return;
        }

        // Nothing injected. On a phone that is normal and fixable — the wallet
        // has its own browser — and on a desktop it means no extension.
        sheet.set(title + (isMobile()
          ? `<p class="muted" style="margin:0 0 10px;font-size:13px">This browser has no wallet. Open Tessera inside your wallet's own browser — the page and the tab you are on come with you:</p>` +
            MOBILE_WALLETS.map((w) =>
              `<a class="btn" href="${w.link()}" style="display:flex;width:100%;justify-content:flex-start;margin-bottom:8px" rel="noopener">${w.name}</a>`).join("") +
            `<p class="muted" style="margin:8px 0 0;font-size:12px">Already using a wallet browser? Reload this page — some wallets only inject on a fresh load.</p>`
          : `<p class="muted" style="margin:0;font-size:13px">No wallet extension detected. Install MetaMask, Rabby or another EIP-1193 wallet, then reload this page.</p>`) +
          sheetCancel);
      }

      /** The SIWE half, with every step reported into the sheet. */
      async function signInWith(sheet, provider) {
        const title = `<h3 style="margin:0 0 12px;font-size:15px">Connect a wallet</h3>`;
        const step = (t) => sheet.set(title +
          `<p class="muted" style="margin:0;font-size:13px"><span class="spin" aria-hidden="true"></span>${esc(t)}</p>` + sheetCancel);
        step("Approve the connection in your wallet…");
        const [address] = await provider.request({ method: "eth_requestAccounts" });
        if (!address) throw new Error("Your wallet did not return an account.");
        step("Sign in — check your wallet for a signature request…");
        const { nonce } = await (await fetch("/api/auth/nonce")).json();
        const chainIdHex = await provider.request({ method: "eth_chainId" });
        const message =
          `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\n` +
          `Sign in to Tessera.\n\nURI: ${location.origin}\nVersion: 1\n` +
          `Chain ID: ${parseInt(chainIdHex, 16)}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
        const signature = await provider.request({ method: "personal_sign", params: [message, address] });
        step("Checking your signature…");
        const r = await (await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, message, signature, nonce }),
        })).json();
        if (!r.ok) throw new Error(r.error || "sign-in failed");
        localStorage.setItem("tessera_token", r.token);
        setWallet(r.address);
        /*
         * Close first, refresh after — and never await a refresh here.
         *
         * Sign-in is finished the moment the token exists; everything below is
         * the page catching up. Awaiting `loadSessions` put a dozen paced chain
         * reads between a successful signature and the sheet closing, so the
         * dialog sat on "Checking your signature…" for half a minute after the
         * work was done. A spinner that outlives what it describes is the thing
         * people read as a hang.
         */
        sheet.close();
        refreshProfile();
        refreshMyPositions().catch(() => {});
        if (typeof loadAllowances === "function") loadAllowances().catch(() => {});
        reflectWalletAvailability();
        adoptConnectedAccount();
        if (typeof loadWallet === "function") loadWallet();
        // The session card and the task list were both drawn while signed out —
        // one said "connect a wallet", the other showed nothing to schedule
        // against. Neither re-read itself when the wallet arrived.
        if (typeof loadSessions === "function") loadSessions().catch(() => {});
        if (typeof loadTasks === "function") loadTasks();
      }
      $("walletBtn").addEventListener("click", connectWallet);
      (async () => {
        const t = localStorage.getItem("tessera_token");
        if (!t) { adoptConnectedAccount(); return; }
        try {
          const me = await (await fetch("/api/auth/me", { headers: { authorization: "Bearer " + t } })).json();
          if (me.address) setWallet(me.address);
        } catch {}
        adoptConnectedAccount();
      })();

      /**
       * In self-custody, the wallet the browser is offering *is* who you are.
       *
       * "Use my own wallet" says no sign-in is needed, and it is true of every
       * action — those are signed by the wallet, not by the server. But every
       * "yours" figure on the page keys off `__myAddress`, which was only ever
       * set by a SIWE sign-in, and fell back to the operator's `actingAs`. So a
       * visitor who switched on self-custody without signing in was shown the
       * *app wallet's* rewards and positions as their own, with the claim
       * button greyed out because the app wallet had nothing to claim.
       *
       * Read-only adoption, deliberately: it decides whose numbers to display,
       * never what the server will sign. Spending endpoints still require a
       * proper session.
       */
      async function adoptConnectedAccount() {
        try {
          if (!selfMode() || window.__myAddress) return;
          const a = await connectedAddress();
          if (!a) return;
          setWallet(a);
          refreshMyPositions().catch(() => {});
          // Sessions are keyed by the connected address, so they are unreadable
          // until there is one — and this is the moment there is. First,
          // because on the Wallet route it is most of what the page shows.
          if (typeof loadSessions === "function") loadSessions().catch(() => {});
          /*
           * The rest only when their pane is on screen.
           *
           * Anything already drawn against "no address" is drawn against the
           * wrong person, and the reward cards are where that shows — but
           * re-reading three chain-heavy panels the visitor is not looking at
           * just puts them in front of the one they are. Each pane reloads on
           * arrival anyway.
           */
          const open = (id) => $(id) && !$(id).hidden;
          if (open("paneDashboard") && typeof loadClaimables === "function") loadClaimables().catch(() => {});
          if (open("paneDefi")) {
            if (typeof loadEmissions === "function") loadEmissions().catch(() => {});
            if (typeof loadLpEmissions === "function") loadLpEmissions().catch(() => {});
            // The retired contract's balance is keyed by address too, and it is
            // the one nobody would think to go looking for.
            if (typeof loadLegacyEmissions === "function") loadLegacyEmissions().catch(() => {});
          }
        } catch { /* no wallet, or one that will not answer — leave it alone */ }
      }

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
        // The column is the market's size on both tabs, so the header is the
        // same on both.
        const c = $("lnMarketCol");
        if (c) c.textContent = "Supplied / borrowed";
        // Point the action panel at the same side, so the two agree.
        const act = $("lnAction");
        if (act) {
          act.value = lnMarketSide === "supply" ? "supply" : "borrow";
          act.dispatchEvent(new Event("change"));
        }
        /*
         * Guarded, because this is now called during evaluation to paint the
         * default tab — and `renderMarket` is assigned to `window` further down
         * the file, so the bare identifier is still in its dead zone at that
         * point. The first poll renders the table a moment later regardless;
         * what this call is for is the highlight, and that is already done
         * above. The same guard is used at the other early call site.
         */
        if (typeof renderMarket === "function") renderMarket();
      }
      if ($("lnTabSupply")) $("lnTabSupply").addEventListener("click", () => setMarketSide("supply"));
      if ($("lnTabBorrow")) $("lnTabBorrow").addEventListener("click", () => setMarketSide("borrow"));
      /*
       * Paint the default the same way a click does.
       *
       * `lnMarketSide` starts at "supply" and the table duly opened on the
       * supply side — but `setMarketSide` was only ever reached from a click, so
       * on first paint neither button carried `primary` and the tab that *was*
       * selected looked like the tab that was not. Calling it once here keeps
       * one code path deciding what "selected" looks like, instead of the markup
       * carrying a duplicate of that answer for someone to forget to update.
       */
      setMarketSide(lnMarketSide);

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
            /*
             * The market's totals, not yours.
             *
             * This table is the index somebody reads to decide *where* to put
             * money, and for that the question is how big each market is and how
             * much of it is lent out — not what happens to be in the reader's
             * wallet, which they already know, and not their own position, which
             * the panel below states in full. Two attempts at this column both
             * answered a personal question in a table asking a market one.
             *
             * `cash` is what is lendable now and `borrows` is what is out on
             * loan, so supplied is the sum: every deposit is in one or the other.
             */
            const borrowsRaw = a.reserve ? Number(a.reserve.borrows) : 0;
            const cashNum = Number(fmtUnitsStr(cash, dec).replace(/,/g, "")) || 0;
            const suppliedTotal = cashNum + borrowsRaw;
            const fmtQty = (v) =>
              v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : v > 0 ? v.toLocaleString(undefined, { maximumFractionDigits: 6 })
                : "0";

            const rate = side === "supply" ? a.reserve && a.reserve.supplyApr : a.reserve && a.reserve.borrowApr;
            const em = emissionApr(a.address, side);
            /*
             * The reward badge carries its number.
             *
             * It used to fall back to a bare "rewards" whenever the APR came
             * back null, which happened for every asset here because the rate
             * was so far above the deposit base that the yearly figure blew
             * past the server's ceiling. A tag with no figure reads as a
             * calculation that failed. The server now caps rather than blanks,
             * so ">10,000%" can be shown for what it is.
             */
            const badge = em
              ? em.unpriced
                ? `<div><span class="tag ok" style="font-size:10px"><span class="tsraIcon"></span> rewards · unpriced</span></div>`
                : `<div><span class="tag ok" style="font-size:10px"><span class="tsraIcon"></span> ` +
                  `${Number(em.apr) >= 10000 ? "&gt;10,000" : esc(Number(em.apr).toFixed(2))}%</span></div>`
              : "";
            const disabled = side === "borrow" && !a.borrowable;
            /*
             * The collateral factor, next to the asset it belongs to.
             *
             * It decides how much of a deposit counts towards borrowing — 90% of
             * a USDC deposit, 50% of a TSRA one — and without it the borrow
             * limit is a number the app asserts and nobody can check. On the
             * borrow side the useful figure is the liability factor instead:
             * that is the one that decides how much a debt in this asset counts
             * *against* you, and it is why borrowing a risky asset eats headroom
             * faster than its face value.
             */
            const cF = Number(a.cFactorBps ?? 0), lF = Number(a.lFactorBps ?? 0);
            const factor =
              side === "supply"
                ? cF > 0
                  ? `<div class="muted" style="font-size:11px">${(cF / 100).toFixed(0)}% counts as collateral</div>`
                  : `<div class="muted" style="font-size:11px">not collateral</div>`
                : lF > 0 && lF < 10000
                  ? `<div class="muted" style="font-size:11px">debt counts ${(10000 / lF).toFixed(2)}&times;</div>`
                  : "";
            return (
              `<tr data-market="${esc(a.symbol)}" style="cursor:pointer${disabled ? ";opacity:.55" : ""}">` +
              `<td><b>${esc(a.symbol)}</b>${a.enabled === false ? ' <span class="tag warn" style="font-size:10px">unavailable</span>' : ""}` +
              `<div class="muted" style="font-size:11px">$${esc(a.priceUsd)}</div>${factor}</td>` +
              `<td class="num mono">${esc(fmtQty(suppliedTotal))}` +
              `<div class="muted" style="font-size:11px">${esc(fmtQty(borrowsRaw))} borrowed</div></td>` +
              `<td class="num"><b>${esc(rate ?? "—")}%</b>${badge}</td>` +
              `<td class="num muted">›</td></tr>`
            );
          })
          .join("");

        const size = $("lnMarketSize");
        if (size) size.textContent = "$" + totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 });

        // The calculator reads the same rows this table just drew, so refresh it
        // in the same breath rather than letting the two drift.
        if (typeof renderBorrowCalc === "function") renderBorrowCalc();

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

      /**
       * What a deposit would let you borrow.
       *
       * The borrow limit is one number for a whole position, which does not
       * answer the question somebody actually has standing at the supply box:
       * "if I put in X of this, how much more could I draw?" That depends on the
       * asset — 90% of a USDC deposit counts, 50% of a TSRA one — and the panel
       * had nowhere to say so.
       *
       * Arithmetic only. It sends nothing, and it is deliberately built from the
       * same figures the panel is already showing, so a reader can check it
       * against the collateral factor printed beside each asset rather than
       * trusting a number that appeared from nowhere.
       */
      function renderBorrowCalc() {
        const sel = $("lnCalcAsset"), amt = $("lnCalcAmount"), out = $("lnCalcOut");
        if (!sel || !amt || !out) return;
        const ln = window.__lending;
        const rows = (ln && ln.assets) || [];
        if (!rows.length) { out.textContent = "No reserves yet."; return; }

        // Keep the picker in step with the reserve list without stamping over
        // whatever the reader has selected.
        const want = rows.map((a) => a.symbol).join("|");
        if (sel.dataset.built !== want) {
          const keep = sel.value;
          sel.innerHTML = rows.map((a) => `<option value="${esc(a.symbol)}">${esc(a.symbol)}</option>`).join("");
          sel.dataset.built = want;
          if (rows.some((a) => a.symbol === keep)) sel.value = keep;
        }

        const a = rows.find((r) => r.symbol === sel.value) || rows[0];
        if (!a) return;
        const qty = Number(String(amt.value).replace(/,/g, ""));
        const cF = Number(a.cFactorBps ?? 0) / 10000;
        const px = Number(a.priceUsd);
        if (!Number.isFinite(qty) || qty <= 0) {
          out.textContent = cF > 0
            ? `${a.symbol} counts ${(cF * 100).toFixed(0)}% towards borrowing. Enter an amount to see what it would add.`
            : `${a.symbol} does not count as collateral, so supplying it adds no borrowing power.`;
          return;
        }
        if (!Number.isFinite(px) || px <= 0) { out.textContent = "That asset has no usable price right now."; return; }

        const value = qty * px;
        const added = value * cF;
        const acct = (ln && ln.account) || {};
        const limitNow = Number(acct.borrowLimitUsd);
        const owed = Number(acct.borrowedUsd);
        const liquidity = Number(acct.poolLiquidityUsd);
        const lines = [
          `${qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${esc(a.symbol)} ` +
          `is $${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}, and at a ` +
          `${(cF * 100).toFixed(0)}% collateral factor it adds ` +
          `<b>$${added.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> of borrowing power.`,
        ];
        if (Number.isFinite(limitNow) && Number.isFinite(owed)) {
          const headroom = Math.max(0, limitNow + added - owed);
          lines.push(
            `Your limit would go from $${limitNow.toLocaleString(undefined, { maximumFractionDigits: 2 })} to ` +
            `$${(limitNow + added).toLocaleString(undefined, { maximumFractionDigits: 2 })}, leaving ` +
            `<b>$${headroom.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> you could still draw ` +
            `against $${owed.toLocaleString(undefined, { maximumFractionDigits: 2 })} already borrowed.`,
          );
          // Headroom is not cash. Saying only the first number is how somebody
          // plans a draw the pool has nothing to fund.
          if (Number.isFinite(liquidity) && liquidity < headroom) {
            lines.push(
              `The pool only holds $${liquidity.toLocaleString(undefined, { maximumFractionDigits: 2 })} of ` +
              `borrowable cash right now, so that is the real ceiling until more is supplied.`,
            );
          }
        }
        if (acct.estimated) {
          lines.push(
            `These are estimates from the pool's own marks — the risk oracle cannot price every asset at the ` +
            `moment, and the contract prices collateral slightly more conservatively than this does.`,
          );
        }
        out.innerHTML = lines.join(" ");
      }
      window.renderBorrowCalc = renderBorrowCalc;
      ["lnCalcAsset", "lnCalcAmount"].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener("input", renderBorrowCalc);
        if (el) el.addEventListener("change", renderBorrowCalc);
      });

      /** Rewards: what is streaming, and what this wallet can take. */
      /*
       * Reachable from the page, so the reward card can be driven against a
       * doctored payload in a browser check. The card's most important states —
       * a balance the pot cannot cover, a pot that can — depend on live figures
       * that move underneath a test, and waiting for one to reappear is not a
       * test of anything.
       */
      window.loadEmissions = loadEmissions;
      window.loadLegacyEmissions = loadLegacyEmissions;
      async function loadEmissions() {
        const card = $("lnEmissions");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/lending/emissions" + q)).json();
          window.__emissions = r && r.ok ? r : null;
          // Same rule as the AMM card: once it has shown something it stays,
          // rather than blinking out on every throttled poll and coming back
          // whenever the RPC next answers.
          if (!r || !r.ok || !r.deployed || !r.configured) {
            if (!card.dataset.everShown) card.style.display = "none";
            renderMarket();
            return;
          }
          card.style.display = "";
          card.dataset.everShown = "1";
          /*
           * The headline is what a claim would *pay*, not what has been earned.
           *
           * `claim` transfers `min(your accrued, the pot)`. Printing the
           * accrued figure made the card offer 652,609 TSRA over a button,
           * against a pot holding 262 — and a claim that paid the 262 was still
           * reported as success, so the number on screen was a promise the
           * protocol had no way to keep. The payable figure is the honest one
           * to put next to a button labelled Claim; the earned total is still
           * shown, as what stays owed.
           */
          $("lnEmAmount").textContent = r.yourPayable ?? r.yourClaimable ?? "0";
          $("lnEmSymbol").textContent = r.reward.symbol;
          const runway = r.reward.runwayDays;
          $("lnEmNote").textContent =
            `Pot: ${r.reward.balance} ${r.reward.symbol}` +
            (runway == null ? " · nothing streaming" : ` · about ${runway.toFixed(1)} days left at the current rates`) +
            (r.reward.priced ? "" : " · no market price for the reward, so rows show a rate rather than an APY") +
            `. Paid out all time: ${r.reward.claimedAllTime}.`;
          // Nothing payable means the claim reverts, so the button says so by
          // being off rather than by failing after a signature.
          $("lnEmClaim").disabled = !(BigInt(r.yourPayableRaw ?? r.yourClaimableRaw ?? "0") > 0n);
          /*
           * Say when the pot cannot cover what has been earned.
           *
           * `claim` pays min(owed, held), so a contract that owes more than it
           * holds pays everybody a fraction and leaves the rest booked. The
           * panel was showing 62,668 TSRA claimable beside "Pot: 0 TSRA · about
           * 0.0 days left" and letting the reader work out for themselves that
           * those two facts are in tension. They are the most important thing on
           * the card, so they are stated rather than implied.
           */
          if ($("lnEmBacking")) {
            /*
             * What a claim would pay *you*, not a protocol-wide ratio.
             *
             * The first version of this compared the pot against `totalOwed` —
             * every address's booked debt — and reported the ratio as though it
             * were the haircut each claimant takes. It is not how the contract
             * works. `claim` sums the caller's own accrued balance and pays
             * `min(that, pot)`: whoever claims first is paid in full up to
             * whatever is in the pot, and only the shortfall stays accrued. A
             * protocol-wide percentage answers a question nobody asked and
             * reads as "you will get 0%", which is both wrong and discouraging
             * — claiming is exactly what you should do.
             *
             * Your share of a stream is proportional to your share of the
             * market, unchanged: rewards accrue as shares x (index - yourIndex).
             * The pot only limits how much of an accrued balance can be paid
             * out today.
             */
            const yours = Number(r.yourClaimable ?? "0");
            const held = Number(r.reward.balance ?? "0");
            const short = yours > held;
            $("lnEmBacking").style.display = short ? "" : "none";
            if (short) {
              const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
              // The headline is now the payable figure, so this says where the
              // difference went rather than contradicting the number above it.
              $("lnEmBacking").textContent =
                `The figure above is what the pot can pay today. You have earned ${fmt(yours)} ${r.reward.symbol} in ` +
                `total; the pot holds ${fmt(held)}, so a claim now pays ${fmt(held)} and the remaining ` +
                `${fmt(Math.max(0, yours - held))} stays accrued — it is not lost, and claiming again once the pot ` +
                `refills pays it. Claims are first come, first served.`;
            }
          }
          // Say it in the panel too: an APR next to a paused market is a lie
          // the rate itself cannot tell you about. And say *why* it is paused —
          // an automatic stop is a different fact from an operator's, and the
          // reader's next question ("when does it come back?") only has an
          // answer for one of them.
          if (r.paused) {
            $("lnEmNote").textContent =
              (r.guard && r.guard.byGuard
                ? `Paused automatically: ${guardWhy(r)} Emission stops rather than booking rewards nobody could ` +
                  "claim, and restarts on its own once the pot is ahead of what is owed. "
                : "Paused — nothing is accruing right now. ") +
              "What you have already earned is still yours and still claimable. " +
              $("lnEmNote").textContent;
          }
          const tag = $("govEmPausedTag");
          if (tag) {
            // An operator deciding whether to resume needs to know the guard
            // will simply stop it again while the pot is still empty.
            tag.textContent = r.paused ? (r.guard && r.guard.byGuard ? "auto-paused: pot empty" : "paused") : "running";
            tag.className = r.paused ? "tag warn" : "tag ok";
          }
          const btn = $("govEmPause");
          if (btn) btn.textContent = r.paused ? "Resume lending" : "Pause lending";
          renderMarket();
          renderLiveRates();
        } catch {
          if (!card.dataset.everShown) card.style.display = "none";
        }
      }

      /**
       * The balance left behind on the contract the live one replaced.
       *
       * The migration to bounded accrual deliberately did not chain the two:
       * the old book was thirty times its own pot, and carrying that across
       * would have put the new contract in the same hole immediately. Nothing
       * was swept, so the old contract keeps its pot *and* its book and those
       * balances are still real — this is what stops them being invisible.
       *
       * Deliberately a closing balance rather than a card that looks live: the
       * pot is fixed, paid first come first served, and never topped up again.
       * Saying so is more useful than a figure that implies otherwise.
       */
      async function loadLegacyEmissions() {
        const box = $("lnEmLegacy");
        if (!box) return;
        try {
          const who = String(window.__myAddress || "");
          const q = /^0x[0-9a-fA-F]{40}$/.test(who) ? `?user=${encodeURIComponent(who)}` : "";
          const r = await (await fetch("/api/lending/emissions/legacy" + q)).json();
          window.__legacyEmissions = r && r.ok && r.deployed ? r : null;
          if (!r.ok || !r.deployed || BigInt(r.yoursRaw || "0") === 0n) { box.style.display = "none"; return; }
          box.style.display = "";
          $("lnEmLegacyBody").innerHTML =
            `You are owed <b>${esc(r.yours)} ${esc(r.symbol)}</b> on ${esc(String(r.address).slice(0, 10))}…, the ` +
            `contract retired when accrual became bounded by the pot. It holds ${esc(r.pot)} ${esc(r.symbol)} against ` +
            `${esc(r.owed)} owed to everyone, is never topped up again, and pays first come first served — so a claim ` +
            `now hands over up to <b>${esc(r.payable)} ${esc(r.symbol)}</b>.`;
          $("lnEmLegacyClaim").disabled = BigInt(r.payableRaw || "0") === 0n;
        } catch { /* leave whatever is on screen */ }
      }

      if ($("lnEmLegacyClaim")) {
        $("lnEmLegacyClaim").addEventListener("click", async () => {
          const r = window.__legacyEmissions;
          if (!r) return;
          // Every side of every asset: the contract skips the empty ones, and a
          // closing balance is not worth making somebody pick through.
          const assets = [], sides = [];
          for (const a of r.assets || []) for (const side of [0, 1, 2]) { assets.push(a); sides.push(side); }
          const btn = $("lnEmLegacyClaim");
          btn.disabled = true;
          await selfCustody("lnEmLegacyMsg", `claim up to ${r.payable} ${r.symbol} from the retired contract`,
            async (from, cfg) => sendTx(from, r.address, callData(
              cfg.selectors.emClaim,
              encUint(64), encUint(64 + 32 + assets.length * 32),
              encArray(assets.map((a) => BigInt(a))), encArray(sides.map((x) => BigInt(x))),
            )));
          btn.disabled = false;
          loadLegacyEmissions();
        });
      }

      if ($("lnEmClaim")) {
        $("lnEmClaim").addEventListener("click", async () => {
          const em = window.__emissions;
          if (!em || !em.configured) return;
          // Only the streams with something in them: claiming an empty one
          // costs gas and reverts the whole call.
          // All three sides: supply, borrow, and the backstop that takes first
          // loss and is paid the most for it.
          const owedStreams = [];
          for (const a of em.assets || []) {
            [a.claimableSupply, a.claimableBorrow, a.claimableBackstop].forEach((v, side) => {
              const owed = BigInt(v || "0");
              if (owed > 0n) owedStreams.push({ address: a.address, side, owed });
            });
          }
          // Your share of the pot, not the pot — see `shareOfPot`.
          const cap = shareOfPot(em.yourClaimableRaw, em.reward && em.reward.owedRaw, em.reward && em.reward.balanceRaw);
          const picked = pickStreams(owedStreams, cap);
          const assets = picked.map((x) => x.address), sides = picked.map((x) => x.side);
          if (owedStreams.length && !assets.length) {
            const m2 = $("lnEmMsg");
            m2.style.display = "block"; m2.style.color = "var(--warn)";
            // Only reachable with an empty pot now: `pickStreams` always
            // returns at least one stream while there is anything to pay.
            m2.textContent = "The pot is empty, so a claim would pay nothing. What you have earned stays accrued.";
            return;
          }
          if (!assets.length) {
            const m = $("lnEmMsg");
            m.style.display = "block"; m.style.color = "var(--warn)";
            m.textContent = "Nothing has accrued to claim yet.";
            return;
          }
          const btn = $("lnEmClaim");
          const m = $("lnEmMsg");
          /*
           * Not in self-custody? Claim as the app wallet, server-side.
           *
           * This used to refuse outright — "rewards are paid to whoever earned
           * them, so this needs your own wallet" — which is true of a browser
           * session and false of this one. In an operator session the figure
           * above was read for `actingAs`, the app wallet, so the balance being
           * refused is the app wallet's own. `claim` takes no recipient: it
           * pays `msg.sender`, so the server signing as the agent pays the
           * agent and cannot touch anybody else's reward.
           */
          if (!selfMode()) {
            btn.disabled = true;
            showBusy("lnEmMsg", "Claiming to the app wallet…");
            try {
              const r = await (await postJson("/api/lending/emissions/claim", {})).json();
              if (r.ok) {
                const dp = (em.reward && em.reward.decimals) || 18;
                const paid = (Number(r.paid) / 10 ** dp).toFixed(6).replace(/\.?0+$/, "");
                m.style.color = "var(--good)";
                // innerHTML, so the hash is a link rather than twelve characters
                // of a hash nobody can do anything with.
                m.innerHTML = `Claimed ${esc(paid)} ${esc(em.reward.symbol)} to ${esc(String(r.to).slice(0, 10))}… ` +
                  `— view on Arcscan: ${txLink(r.txHash)}`;
              } else {
                m.style.color = "var(--warn)";
                m.textContent = `Claim failed: ${r.error}`;
              }
            } catch {
              m.style.color = "var(--warn)";
              m.textContent = "Claim request failed.";
            }
            btn.disabled = false;
            loadEmissions();
            return;
          }
          btn.disabled = true;
          /*
           * Label the receipt with what will arrive, not what is owed.
           *
           * `selfCustody` prints this string back with "confirmed ✓" once the
           * transaction lands, so passing the accrued balance produced "claim
           * 653800.646537702511044422 TSRA confirmed ✓" for a transfer of 262
           * — a true statement about the transaction wrapped around a false one
           * about the money. The pot bounds the payment, so the pot bounds the
           * sentence.
           */
          const taking = picked.reduce((t, x) => t + x.owed, 0n);
          const pot = BigInt((em.reward && em.reward.balanceRaw) || "0");
          // `claim` pays min(what these streams hold, what the pot holds), so
          // the pot has the last word on the sentence as well as on the money.
          const paying = taking < pot ? taking : pot;
          const dp = (em.reward && em.reward.decimals) || 18;
          const human = (Number(paying) / 10 ** dp).toFixed(6).replace(/\.?0+$/, "");
          const claimLabel =
            `claim ${human} ${em.reward.symbol}` +
            (paying < BigInt(em.yourClaimableRaw || "0") ? " (what the pot can pay — the rest stays owed)" : "");
          await selfCustody("lnEmMsg", claimLabel, async (from, cfg) =>
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
        /*
         * Values the server is still standing behind, but could not refresh.
         *
         * The alternative was showing zeros and "unavailable" on every reserve
         * the moment one read was refused, which reads as an outage. A stale
         * row keeps the market on screen and says which part of it is old —
         * the position is the part that is missing, so Execute waits.
         */
        if (a.stale) {
          $("lnMaxHint").textContent =
            a.note || "Showing the last values read from the pool — refreshing.";
          $("lnExecute").disabled = true;
          $("lnExecute").style.opacity = "0.5";
          return;
        }
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
        /*
         * Name the cap that binds, not just its value.
         *
         * A third constraint was invisible: the outflow limiter meters every
         * borrow and withdraw against a per-asset budget that refills over an
         * hour. It capped a borrow at 11.105 USDC while the row above showed
         * 545 of cash and the account had headroom for both — so the number
         * looked arbitrary, and anything above it reverted with an error the
         * pool's own ABI cannot decode.
         */
        const bound = a.limitedBy && a.limitedBy[action];
        // A frozen action never reaches here — the freeze check above returns
        // first, disables Execute and names the action. `limitedBy` still
        // carries "frozen" for the market table and every other consumer.
        if (bound === "outflow" && a.outflowBudget != null) {
          /*
           * A wait, not a wall.
           *
           * This used to say the limiter "will release N this hour", which
           * reads as a ceiling for the next sixty minutes. It is not: N is the
           * bucket's level right now, and it refills continuously. On the live
           * pool that meant "8.747 this hour" when the true answer was 250 an
           * hour and a two-minute wait for the rest — the app's own scheduled
           * tasks had drained the bucket moments earlier.
           *
           * Saying the rate turns an arbitrary-looking number into something a
           * reader can plan around, which is the whole difference between a
           * limit that protects the pool and one that just annoys people.
           */
          const now = Number(String(a.outflowBudget).replace(/,/g, ""));
          const rate = a.outflowRefill && Number(String(a.outflowRefill.perHour).replace(/,/g, ""));
          why = ` — capped by the outflow limiter: ${a.outflowBudget} ${a.symbol} available right now`;
          if (rate > 0) {
            why += `, refilling at ${a.outflowRefill.perHour} ${a.symbol}/hour`;
            // How long until the amount they are actually reaching for is free.
            const want = Number(String($("lnAmount") ? $("lnAmount").value : "").replace(/,/g, ""));
            const target = Number.isFinite(want) && want > now ? want : null;
            if (target !== null) {
              const mins = Math.ceil(((target - now) / rate) * 60);
              why += ` — ${target} in about ${mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${(mins / 60).toFixed(1)} hours`}`;
            }
          }
        } else if (bound === "liquidity" && action === "borrow") {
          why = " — capped by the cash in the reserve, not by your collateral";
        }
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
      $("lnAmount").addEventListener("input", () => {
        delete $("lnAmount").dataset.raw;
        // Re-draw the cap hint: when the outflow limiter is what binds, the hint
        // says how long until *this* amount is available, so it has to follow
        // what is typed rather than freeze at whatever was there on load.
        if (typeof renderLendingAsset === "function") renderLendingAsset();
      });
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
        // The server signs and waits for the receipt, which on Arc is a second
        // or three of a page that looks like nothing happened.
        showBusy("lendingMsg", `${action} ${human} ${a.symbol} — sending…`);
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
        showBusy("vaultMsg", `${action} ${human} USDC — sending…`);
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
            /*
             * "Not read yet" and "read, and it is zero" are different answers.
             *
             * `!parseFloat(x)` is true for undefined, null, "" and "0" alike, so
             * a snapshot that had not landed yet rendered as a red "no pool
             * depth — add liquidity to trade it" on every asset. The AMM
             * snapshot is served from cache and refreshed in the background, so
             * that state is reached on every cold load and after every throttled
             * refresh — the panel was accusing the pools of being empty while it
             * was still finding out. All four have depth right now.
             */
            const n = Number(a.liquidity);
            const unread = a.liquidity == null || a.liquidity === "" || !Number.isFinite(n);
            const empty = !unread && n === 0;
            const tag = unread
              ? `<span class="tag">reading depth…</span>`
              : empty
                ? `<span class="tag warn">no pool depth — add liquidity to trade it</span>`
                : `<span class="tag ok">routable</span>`;
            return (
              `<tr><td><b>${esc(a.symbol)}</b></td>` +
              `<td class="num ${empty ? "down" : ""}">${unread ? "—" : esc(a.liquidity)}</td>` +
              `<td>${tag}</td></tr>`
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
        /*
         * The sizes, not just the pair.
         *
         * "swap USDC → EURC" is the same sentence for five dollars and five
         * thousand, which makes it useless as a receipt.
         *
         * The input is exact — that is the amount leaving the wallet. The
         * output is not: the router fills at execution price, and the response
         * carries only a hash, so the quoted figure is what was expected rather
         * than what arrived. `minOut` is the one output number the chain
         * guarantees, because the transaction reverts below it — so that is the
         * one this says.
         */
        const swapWhat =
          `swap ${fmtUnitsStr(String(q.amountIn), Number(q.decIn ?? 6))} ${q.symIn}` +
          ` → at least ${fmtUnitsStr(minOut, Number(q.decOut ?? 6))} ${q.symOut}`;
        const btn = $("swExecute");
        // Self-custody: swap the user's own tokens through their wallet.
        if (selfMode()) {
          btn.disabled = true;
          await selfCustody("swapMsg", swapWhat, async (from, cfg) => {
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
        showBusy("swapMsg", `${swapWhat} — sending…`);
        try {
          const r = await (await postAuthed(`/api/swap?tokenIn=${q.tokenIn}&tokenOut=${q.tokenOut}&amountIn=${q.amountIn}&minOut=${minOut}`)).json();
          msg.style.display = "block";
          if (r.ok) msg.innerHTML = `${esc(swapWhat)} ✓ — view on Arcscan: ${txLink(r.txHash)}`;
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

          /*
           * Why the five destinations read zero.
           *
           * The pool pays its take rate by crediting the treasury a supply
           * position, and the collector splits only tokens it holds — so with
           * the collector named as treasury, revenue accrued somewhere it could
           * never leave, and every row read 0.000000 for a reason the panel
           * never mentioned. Earning-and-unrouted is a different state from
           * earning-nothing and now says so, with the fix attached.
           */
          const route = r.route;
          if ($("feeRoute")) {
            const broken = route && !route.canHarvest;
            $("feeRoute").style.display = broken ? "" : "none";
            if (broken) {
              $("feeRoute").textContent = route.strandedAtCollector
                ? "The pool is crediting its share of borrower interest to the collector itself, which has no way " +
                  "to withdraw it from the pool — so nothing ever arrives here to split. Routing it to the " +
                  "deployer lets the app collect it and forward it on."
                : `The pool credits its share of borrower interest to ${String(route.treasury).slice(0, 10)}…, ` +
                  "which this server cannot sign for, so it cannot be forwarded here.";
            }
          }
          if ($("feeAccrued")) {
            const acc = (route && route.accrued) || [];
            $("feeAccrued").style.display = acc.length ? "" : "none";
            if (acc.length) {
              $("feeAccrued").textContent =
                "Earned and waiting in the pool: " + acc.map((a) => `${a.amount} ${a.symbol}`).join(", ") +
                (route.canHarvest
                  ? " — collected automatically once it is worth the transaction."
                  : " — it keeps earning where it is, and is not lost.");
            }
          }
          if ($("feeRouteFix")) $("feeRouteFix").style.display = route && route.strandedAtCollector ? "" : "none";

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
          /*
           * Say where the money would have come from, not just that there isn't
           * any.
           *
           * "No fees distributed yet" is true and useless — it reads like a
           * panel that failed. The collector's income is the pool's
           * reserve-factor cut of *borrower interest* plus the vault's
           * performance fee on *its* yield, and both are zero while nothing is
           * borrowed. That is a fact about the market, not about the chart, and
           * naming it turns a dead panel into an explanation.
           */
          const ln = window.__lending;
          const borrowed = ln && ln.account && ln.account.borrowedUsd;
          const idle = borrowed != null && Number(borrowed) === 0;
          host.innerHTML =
            `<div class="feeChartEmpty">Nothing has been collected yet, so there is nothing to split. ` +
            `The app's revenue is the pool's cut of <b>borrower interest</b> and the vault's fee on its yield` +
            (idle ? `, and nothing is borrowed right now` : ``) +
            `. The chart fills in from the first allocation onward.</div>`;
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
          m.removeAttribute("aria-busy");
        };
        $("feeAllocate").addEventListener("click", async () => {
          const btn = $("feeAllocate");
          btn.disabled = true;
          showBusy("feeMsg", "Distributing the collected fees…");
          try {
            const r = await (await postAuthed("/api/fees/allocate")).json();
            showReceipt("feeMsg", r.ok, r.ok ? "distributed" : `failed: ${r.error}`, r.txHash);
            if (r.ok) loadFees();
          } catch { feeMsg("request failed", "var(--warn)"); }
          finally { btn.disabled = false; }
        });
        // Pull the pool's credited take rate out and hand it to the collector.
        $("feeHarvest").addEventListener("click", async () => {
          const btn = $("feeHarvest");
          btn.disabled = true;
          showBusy("feeMsg", "Collecting the interest the pool has credited…");
          try {
            const r = await (await postAuthed("/api/fees/harvest")).json();
            const moved = (r.moved || []).map((m) => `${m.amount} ${m.symbol}`).join(", ");
            showReceipt(
              "feeMsg", Boolean(r.ok && (r.moved || []).length),
              r.ok ? (moved ? `collected ${moved}` : (r.note || "nothing worth collecting yet")) : `failed: ${r.error}`,
              (r.moved || [])[0] && r.moved[0].txHash,
            );
            if (r.ok) loadFees();
          } catch { feeMsg("request failed", "var(--warn)"); }
          finally { btn.disabled = false; }
        });
        // The one owner call that gives the take rate somewhere it can go.
        $("feeRouteFix").addEventListener("click", async () => {
          const btn = $("feeRouteFix");
          btn.disabled = true;
          showBusy("feeMsg", "Pointing the pool's take rate at the app wallet…");
          try {
            const r = await (await postAuthed("/api/fees/route-treasury")).json();
            showReceipt(
              "feeMsg", Boolean(r.ok),
              r.ok
                ? (r.alreadyRouted ? "already routed" : "protocol fees now route through the app wallet")
                : `failed: ${r.error}`,
              r.txHash,
            );
            if (r.ok) loadFees();
          } catch { feeMsg("request failed", "var(--warn)"); }
          finally { btn.disabled = false; }
        });
        $("feeWithdraw").addEventListener("click", async () => {
          const human = $("feeWithdrawAmount").value.trim();
          if (!human || !(parseFloat(human) > 0)) return feeMsg("Enter an amount above zero.", "var(--warn)");
          const btn = $("feeWithdraw");
          btn.disabled = true;
          showBusy("feeMsg", `Withdrawing ${human} USDC…`);
          try {
            const raw = toRaw(human, 6); // the collector's asset is USDC
            const r = await (await postAuthed(`/api/fees/withdraw?amount=${raw}`)).json();
            showReceipt("feeMsg", r.ok, r.ok ? `withdrew ${human} USDC` : `failed: ${r.error}`, r.txHash);
            if (r.ok) { $("feeWithdrawAmount").value = ""; loadFees(); }
          } catch { feeMsg("request failed", "var(--warn)"); }
          finally { btn.disabled = false; }
        });
      }

      /* ====================================================================
       * The wallet, and the tasks that use it.
       *
       * Two features that are really one: a transfer you make now, and the same
       * transfer made later on a schedule. They share a pane because they share
       * a wallet, and because "send 50 USDC to this address every Monday" is one
       * thought, not two.
       * ================================================================== */

      /**
       * `address,amount` per line, with the bad lines named rather than dropped.
       *
       * Both the immediate bulk send and the scheduled one read a list the same
       * way, so they share this. Silently skipping an unreadable line is the
       * worst option available: the transfer looks like it worked and one
       * recipient simply never hears from you.
       */
      /**
       * A memo as calldata, appended after a call's encoded arguments.
       *
       * Solidity's decoder ignores calldata beyond what the arguments need, so
       * the call runs exactly as encoded and the extra bytes ride along in the
       * transaction input — public, permanent, and shown by the explorer. That
       * is the difference between this and the note beside it, which never
       * leaves the app.
       *
       * Bounded at 180 bytes: every byte is paid for in gas by the sender, and
       * a memo is a sentence rather than a payload.
       */
      function memoHex(memo) {
        // Mirrors agent/src/memo.ts exactly, including the whitespace
        // normalisation — a memo typed here and one scheduled through the
        // server must land on chain as the same bytes.
        const text = String(memo || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        const bytes = new TextEncoder().encode(text).slice(0, 180);
        return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      window.memoHex = memoHex;

      function parseRecipientList(text, decimals) {
        const rows = [];
        const bad = [];
        String(text || "").split(/[\r\n;]+/).forEach((line, i) => {
          const t = line.trim();
          if (!t) return;
          const [to, amt] = t.split(/[,\s]+/);
          if (!/^0x[0-9a-fA-F]{40}$/.test(to || "") || !(parseFloat(amt) > 0)) { bad.push(i + 1); return; }
          rows.push({ to, amount: toRaw(amt, decimals) });
        });
        return { rows, bad };
      }

      let walletAssets = [];
      /** Whose wallet this pane is showing — null until `loadWallet` has run. */
      let walletOwner = null;

      /**
       * The Wallet pane shows whichever wallet the page is acting as.
       *
       * In self-custody that is the visitor's own, read from the public
       * balances endpoint and spent with their own signature. Otherwise it is
       * the app wallet, which is operator-only. Reading `/api/wallet` in both
       * cases was what made this pane look broken to a connected visitor: the
       * request 403s, the pane hid itself, and a wallet with a balance sitting
       * right there reported nothing to send.
       */
      async function loadWallet() {
        const body = $("walletBody");
        if (!body) return;
        try {
          const mine = selfMode() ? await connectedAddress() : null;
          const r = mine
            ? { ...(await (await fetch(`/api/wallet/assets?user=${encodeURIComponent(mine)}&size=100`)).json()), address: mine }
            : await (await fetch("/api/wallet", { headers: authHeaders() })).json();
          if (!r.ok) throw new Error(r.error || "not signed in");
          walletOwner = r.address;
          if ($("walletWhose")) {
            $("walletWhose").textContent = mine
              ? "Sending from your connected wallet."
              : "Sending from the app wallet — switch on “Use my own wallet” to send your own funds instead.";
          }
          $("walletNotReady").style.display = "none";
          body.style.display = "";
          walletAssets = r.assets || [];
          $("walletAddress").textContent = r.address;
          $("walletRows").innerHTML = walletAssets.length
            ? walletAssets.map((a) =>
                `<tr><td><b>${esc(a.symbol)}</b><div class="muted mono" style="font-size:10.5px">${esc(String(a.address).slice(0, 10))}…</div></td>` +
                // A balance that could not be read says so; it is not zero.
                `<td class="num mono">${a.balance === null ? "unavailable" : esc(a.balance)}</td></tr>`).join("")
            : emptyRow(2, "No assets.");
          // Both asset pickers on this page: the one you send from now, and the
          // one a session would be opened against.
          for (const id of ["walSendAsset", "skAsset"]) {
            const sel = $(id);
            if (sel && sel.dataset.built !== String(walletAssets.length)) {
              sel.innerHTML = walletAssets.map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`).join("");
              sel.dataset.built = String(walletAssets.length);
            }
          }
        } catch {
          $("walletNotReady").style.display = "";
          body.style.display = "none";
        }
      }

      /**
       * A token's symbol and decimals, from whichever list has loaded.
       *
       * `walletAssets` is filled by the Send & receive card, so anything that
       * asked before that card ran got no symbol and, worse, the default of six
       * decimals — which prints a cirBTC amount a hundred times too large. The
       * deployment's own asset list carries the same three fields and does not
       * depend on which card the reader opened first.
       */
      const walAsset = (addr) => {
        const key = String(addr).toLowerCase();
        const match = (list) => (list || []).find((x) => String(x.address).toLowerCase() === key) || null;
        return match(walletAssets) || match(window.__defiCfg && window.__defiCfg.assets);
      };
      const walDecimals = (addr) => {
        const a = walAsset(addr);
        return a ? a.decimals : 6;
      };
      const walSymbol = (addr) => {
        const a = walAsset(addr);
        return a ? a.symbol : "";
      };

      /**
       * An amount with its token — the only form a receipt may state one in.
       *
       * "send 1 to 0xA005fE97… confirmed" was the whole record of a payment
       * that could equally have been 1 USDC or 1 cirBTC. Every figure a receipt
       * prints goes through here so that cannot happen a line at a time.
       */
      function amountLabel(raw, asset) {
        return `${fmtUnitsStr(String(raw), walDecimals(asset))} ${walSymbol(asset)}`.trim();
      }
      /**
       * Total a list of raw amounts.
       *
       * Raw, never the display strings: a receipt that adds up "1.5" and "2"
       * by parsing them back is one rounding rule away from reporting a figure
       * nobody sent.
       */
      function sumRaw(values) {
        return (values || []).reduce((t, v) => t + BigInt(v || 0), 0n);
      }

      if ($("walletCopy")) {
        $("walletCopy").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText($("walletAddress").textContent.trim());
            showReceipt("walMsg", true, "address copied");
          } catch { showReceipt("walMsg", false, "could not copy — select the address and copy it by hand"); }
        });
        $("walSend").addEventListener("click", async () => {
          const asset = $("walSendAsset").value;
          const to = $("walSendTo").value.trim();
          const human = $("walSendAmount").value.trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return showReceipt("walMsg", false, "that is not an address");
          if (!(parseFloat(human) > 0)) return showReceipt("walMsg", false, "enter an amount above zero");
          const btn = $("walSend");
          const raw = toRaw(human, walDecimals(asset));
          /*
           * Every figure on a receipt names its token.
           *
           * "send 1 to 0xA005fE97… confirmed" is the whole record of a payment
           * that could equally have been 1 USDC or 1 cirBTC, and the wallet
           * offers several. An amount without its unit is not a receipt.
           */
          const paid = amountLabel(raw, asset);
          const note = ($("walSendMsg") ? $("walSendMsg").value : "").trim().slice(0, 200);
          const memo = ($("walSendMemo") ? $("walSendMemo").value : "").trim().slice(0, 180);
          // Self-custody sends the visitor's own tokens with their own
          // signature. The server has no key for that wallet, so routing this
          // through `/api/wallet/send` would either 403 or — worse — move the
          // app wallet's money instead of theirs.
          if (selfMode()) {
            btn.disabled = true;
            // The memo is appended to the call's own data. Solidity ignores
            // calldata past the arguments it decodes, so the transfer executes
            // exactly as encoded and the memo lands in the transaction input.
            await selfCustody("walMsg", `send ${paid} to ${to.slice(0, 10)}…`, async (from, c) =>
              sendTx(from, asset, callData(c.selectors.erc20Transfer, encAddr(to), encUint(raw)) + memoHex(memo)));
            btn.disabled = false;
            $("walSendAmount").value = "";
            // Self-custody never reaches the server, so the note has nowhere
            // to be filed. Say that rather than appearing to have kept it.
            if (note) {
              const m = $("walMsg");
              m.innerHTML += ` <span class="muted">· note "${esc(note)}" was not saved — your wallet signed this ` +
                `transfer directly, so it never passed through this app.</span>`;
            }
            loadWallet();
            return;
          }
          btn.disabled = true;
          showBusy("walMsg", `sending ${paid} to ${to.slice(0, 10)}…`);
          try {
            const r = await (await postAuthed("/api/wallet/send", { asset, to, amount: raw, message: note, memo })).json();
            const first = r.sent && r.sent[0];
            showReceipt(
              "walMsg", Boolean(r.ok),
              r.ok
                // Say when the memo did not make it. The payment went through
                // either way, and claiming a memo that is not on chain is the
                // one thing this must not do.
                ? `sent ${paid} to ${to.slice(0, 10)}…${memo ? (first && first.memoOnChain ? " with memo" : " — the memo could not be attached, so it was not sent") : ""}`
                : `failed: ${r.error}`,
              first && first.txHash,
            );
            if (r.ok) { $("walSendAmount").value = ""; loadWallet(); }
          } catch { showReceipt("walMsg", false, "request failed"); }
          finally { btn.disabled = false; }
        });

        /** `address,amount` per line — the shape people already paste from a sheet. */
        const parseBulk = () => parseRecipientList($("walBulk").value, walDecimals($("walSendAsset").value));
        $("walBulk").addEventListener("input", () => {
          const { rows, bad } = parseBulk();
          $("walBulkCount").textContent =
            `${rows.length} recipient${rows.length === 1 ? "" : "s"}` + (bad.length ? ` · line ${bad.join(", ")} unreadable` : "");
        });
        $("walBulkSend").addEventListener("click", async () => {
          const { rows, bad } = parseBulk();
          if (bad.length) return showReceipt("walMsg", false, `line ${bad.join(", ")} is not "address,amount"`);
          if (!rows.length) return showReceipt("walMsg", false, "no recipients");
          const btn = $("walBulkSend");
          /*
           * Self-custody bulk is a transfer per row, signed one at a time.
           *
           * There is no batch call here on purpose: a multicall would need an
           * approval to a contract that then moves the whole list, which is a
           * far bigger permission than the thing being asked for. So the
           * wallet prompts per recipient, and a row that fails or is rejected
           * stops the rest rather than leaving the list half sent with no
           * record of where it stopped.
           */
          if (selfMode()) {
            const asset = $("walSendAsset").value;
            const memo = ($("walSendMemo") ? $("walSendMemo").value : "").trim().slice(0, 180);
            btn.disabled = true;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              const ok = await selfCustody(
                "walMsg",
                `send ${amountLabel(row.amount, asset)} to ${row.to.slice(0, 10)}…` +
                  ` (${i + 1} of ${rows.length})`,
                async (from, c) => sendTx(from, asset,
                  callData(c.selectors.erc20Transfer, encAddr(row.to), encUint(row.amount)) + memoHex(memo)),
              );
              if (!ok) break;
            }
            btn.disabled = false;
            loadWallet();
            return;
          }
          btn.disabled = true;
          // The total, named — a list of rows is the one place where nobody
          // has added it up for themselves.
          const bulkAsset = $("walSendAsset").value;
          const bulkTotal = amountLabel(sumRaw(rows.map((x) => x.amount)), bulkAsset);
          showBusy("walMsg", `sending ${bulkTotal} to ${rows.length} address${rows.length === 1 ? "" : "es"}…`);
          try {
            const r = await (await postAuthed("/api/wallet/send-bulk", {
              asset: $("walSendAsset").value, recipients: rows,
              message: ($("walSendMsg") ? $("walSendMsg").value : "").trim().slice(0, 200),
              memo: ($("walSendMemo") ? $("walSendMemo").value : "").trim().slice(0, 180),
            })).json();
            const sent = (r.sent || []).length, failed = (r.failed || []).length;
            /*
             * What moved, not what was asked for.
             *
             * `bulkTotal` is the plan; a run that fails half way through moved
             * less than that, and a receipt that reports the plan as the sum
             * paid is the one number an operator would never catch. The server
             * returns each sent row's raw amount for exactly this.
             */
            const moved = amountLabel(sumRaw((r.sent || []).map((x) => x.raw)), bulkAsset);
            showReceipt("walMsg", Boolean(r.ok) && !failed,
              r.ok ? `${sent} sent — ${moved}${failed ? `, ${failed} failed` : ""}` : `failed: ${r.error}`,
              (r.sent || [])[0] && r.sent[0].txHash);
            if (sent) { loadWallet(); $("walBulk").value = ""; $("walBulkCount").textContent = ""; }
          } catch { showReceipt("walMsg", false, "request failed"); }
          finally { btn.disabled = false; }
        });
      }

      /* ---- session keys -------------------------------------------------- */

      let sessionRows = [];

      /** Everything the last fetch returned, newest first. */
      let sessionAll = [];
      /** Whose sessions are on screen — the connected wallet, or a searched one. */
      let sessionOwnerShown = null;
      /** How many rows the table is showing; "Show more" raises it. */
      let sessionPage = 10;
      const SESSION_PAGE = 10;

      /** Can this app spend from it right now? */
      const sessionUsable = (x) =>
        x.ours && !x.revoked && x.expiry * 1000 > Date.now() && BigInt(x.spendableRaw || "0") > 0n;

      /**
       * Why it cannot be used, in a phrase — empty when it can.
       *
       * "Nothing left to spend" was true and unanswerable: a session with 30
       * USDC of unused cap, against a wallet holding 326, said it and left
       * nobody any way to find out why. Three ceilings bind a session — its own
       * cap, the wallet's ERC-20 allowance to the contract, and the wallet's
       * balance — and the allowance is almost always the one, because it is a
       * single shared number per wallet and token that every session draws
       * down. Name it, and say what fixes it.
       */
      function sessionWhy(x) {
        if (x.revoked) return "revoked";
        if (x.expiry * 1000 < Date.now()) return "expired";
        if (!x.ours) return "delegated to a key this app no longer holds — open a new one";
        if (BigInt(x.spendableRaw || "0") > 0n) return "";
        if (x.binds === "allowance") {
          return `${x.capLeft} ${x.symbol} of cap is unused, but your approval to the session contract is ` +
            `${x.allowance} — top it up to use this session`;
        }
        if (x.binds === "balance") return `your wallet holds ${x.balance} ${x.symbol}, less than this session could pay`;
        if (x.binds === "cap") return "its cap is fully spent — open a new session for more";
        return "nothing left to spend";
      }

      /**
       * The session table: live first, newest first, ten at a time.
       *
       * Ordering matters more than it looks. Revoked and expired delegations
       * accumulate and never go away — they are on chain — so a list in raw
       * contract order buries the one session somebody just opened under
       * everything they have ever finished with. Live at the top, newest
       * first, and the dead ones still reachable underneath.
       */
      /*
       * "No time limit" is the largest expiry a uint64 holds, not a flag.
       *
       * The contract stores one `uint64` and refuses one already past, so a
       * session that should never lapse is one that lapses long after anything
       * else does. Everything that reads an expiry back has to know that,
       * because `new Date(18446744073709551615 * 1000)` is not a date — it is
       * outside what Date can represent, and rendered as "Invalid Date".
       */
      const NO_EXPIRY = "18446744073709551615";
      const FOREVER_AFTER = 32503680000; // 1 Jan 3000, in seconds
      const isForever = (expiry) => Number(expiry) >= FOREVER_AFTER;
      const FIXED_UNITS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };

      function renderSessionTable() {
        const body = $("skRows");
        if (!body) return;
        const q = ($("skSearch") ? $("skSearch").value : "").trim().toLowerCase();
        const byAddress = /^0x[0-9a-f]{40}$/.test(q);
        const rows = sessionAll.filter((x) => {
          if (!q || byAddress) return true;           // an address query re-fetched already
          return x.id.toLowerCase().includes(q);      // otherwise match the session id
        });
        // Stable: live before dead, and within each the order they arrived in
        // (which is newest first).
        const live = rows.filter((x) => !x.revoked && x.expiry * 1000 > Date.now());
        const dead = rows.filter((x) => x.revoked || x.expiry * 1000 <= Date.now());
        const ordered = live.concat(dead);
        const shown = ordered.slice(0, sessionPage);
        const me = String(window.__myAddress || "").toLowerCase();

        body.innerHTML = shown.length
          ? shown.map((x) => {
              const when = isForever(x.expiry) ? "no expiry" : new Date(x.expiry * 1000).toLocaleDateString();
              const gone = x.revoked || x.expiry * 1000 < Date.now();
              const bad = sessionWhy(x);
              const ok = sessionUsable(x);
              // Whose wallet this delegation is out of. It is the question the
              // table could not answer — every row looked the same and none of
              // them said who was paying.
              const owner = String(x.owner || "");
              const isMine = me && owner.toLowerCase() === me;
              const tag = isMine
                ? `<span style="color:var(--good);font-size:10.5px;font-weight:600">this wallet</span>`
                : `<span style="color:var(--warn);font-size:10.5px">another wallet</span>`;
              return `<tr><td><b>${esc(x.symbol)}</b> ${tag}` +
                `${ok ? ` <span style="color:var(--good);font-size:10.5px">usable</span>` : ""}` +
                `<div class="muted mono" style="font-size:10.5px;word-break:break-all;margin-top:2px">` +
                `from ${esc(owner)} <button class="btn" data-skcopy="${esc(owner)}" style="padding:0 5px;font-size:10px">copy</button></div>` +
                `<div class="muted mono" style="font-size:10.5px">id ${esc(x.id.slice(0, 14))}…` +
                ` <button class="btn" data-skcopy="${esc(x.id)}" style="padding:0 5px;font-size:10px">copy id</button></div>` +
                `<div class="muted" style="font-size:11px">` +
                `${x.revoked ? "revoked" : isForever(x.expiry) ? "no time limit" : `until ${esc(when)}`}` +
                `${Number(x.perTxMaxRaw) > 0 ? ` · max ${esc(x.perTxMax)} each` : ""}` +
                `${x.restricted ? " · allow-list" : ""}</div>` +
                // Not repeated when the line above already says it — "revoked"
                // twice under each other read as a rendering fault.
                (bad && !ok && bad !== "revoked" ? `<div style="color:var(--warn);font-size:11px">${esc(bad)}</div>` : "") +
                // One signature to make every live session on this asset
                // usable again, rather than opening yet another one.
                (isMine && x.binds === "allowance"
                  ? `<button class="btn" data-skallow="${esc(x.asset)}" style="margin-top:5px;padding:2px 8px;font-size:11px">Top up approval</button>`
                  : "") +
                // A bigger cap or a later expiry is a new session — the contract
                // has no way to change either one in place. This fills the form
                // in and says so, rather than leaving people to work it out.
                (isMine && !gone
                  ? ` <button class="btn" data-skext="${esc(x.id)}" style="margin-top:5px;padding:2px 8px;font-size:11px">Raise or extend</button>`
                  : "") +
                `</td>` +
                `<td class="num mono">${esc(x.spent)} / ${esc(x.cap)}</td>` +
                `<td class="num mono">${gone ? "—" : esc(x.spendable)}</td>` +
                `<td class="num">${gone || !isMine ? "" : `<button class="btn" data-skrev="${esc(x.id)}">Revoke</button>`}</td></tr>`;
            }).join("")
          : emptyRow(4, q
              ? "No session matches that."
              // Name the address that was read. "No sessions yet" on its own
              // is indistinguishable from a read that went to the wrong
              // wallet, or to none at all.
              : sessionOwnerShown
                ? `No sessions for ${String(sessionOwnerShown).slice(0, 10)}… yet — open one above.`
                : "Connect a wallet, or search an address, to see sessions.");

        const more = $("skMore");
        if (more) {
          const left = ordered.length - shown.length;
          more.style.display = left > 0 ? "" : "none";
          more.textContent = `Show ${Math.min(SESSION_PAGE, left)} more (${left} hidden)`;
        }
        const count = $("skCount");
        if (count) {
          count.textContent = ordered.length
            ? `${live.length} live · ${dead.length} finished` +
              (sessionOwnerShown && me && sessionOwnerShown.toLowerCase() !== me
                ? ` · showing ${sessionOwnerShown.slice(0, 10)}…, not your own`
                : "")
            : "";
        }
      }

      /**
       * Fill the session pickers from whatever is spendable.
       *
       * Both forms that can spend a delegation have one — the scheduled task
       * and a series step — and both are rebuilt here so the labels cannot
       * disagree depending on which was drawn last.
       */
      function renderSessionPicker() {
        for (const id of ["taskSession", "stepSession"]) {
          const sel = $(id);
          if (!sel) continue;
          const keep = sel.value;
          sel.innerHTML = sessionOptions();
          if (keep && sessionRows.some((x) => x.id === keep)) sel.value = keep;
        }
      }

      /**
       * The picker's labels, which have to tell four delegations apart.
       *
       * Four options all reading "USDC · 0.018 left" is not a choice. The id
       * is what distinguishes them — it is what the table shows and what the
       * receipt names — so it leads, with the expiry and the per-payment
       * ceiling after it.
       */
      function sessionLabel(x) {
        const until = isForever(x.expiry)
          ? "no expiry"
          : new Date(x.expiry * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
        return `${x.id.slice(0, 10)}… · ${x.spendable} ${x.symbol} left` +
          `${Number(x.perTxMaxRaw) > 0 ? ` · max ${x.perTxMax}` : ""} · until ${until}`;
      }
      function sessionOptions() {
        if (!sessionRows.length) return `<option value="">no session this app can spend from — open one above</option>`;
        return sessionRows.map((x) => `<option value="${esc(x.id)}">${esc(sessionLabel(x))}</option>`).join("");
      }

      /**
       * The sessions this visitor's own wallet has opened.
       *
       * Read for the connected address rather than the app wallet: a session is
       * a thing *you* granted, and the only wallet that can grant or revoke one
       * is the one holding the tokens.
       */
      /**
       * Whose sessions the page currently wants to be showing.
       *
       * Overlapping loads are normal here — a route change, a sign-in and the
       * wallet-detection poll all ask, and each is several paced chain calls.
       * The first attempt at keeping them straight was a sequence number, and
       * it was wrong in a way that made the card *worse*: two loads start at
       * boot, the second blocks behind a slow request, and the first — the one
       * whose data had actually arrived — was discarded for being "stale".
       * The table stayed empty for as long as the slow one took.
       *
       * What actually matters is not which call is newest but which *wallet*
       * is being shown. Any answer for the wallet on screen is a good answer,
       * whoever asked for it; an answer for a different wallet is dropped.
       */
      let sessionWant = null;
      /** The load currently running, so identical ones can share it. */
      let sessionInflight = null;
      /** Pending retry after a failed read, so they cannot pile up. */
      let sessionRetry = null;

      function loadSessions() {
        if (!$("skRows")) return Promise.resolve();
        if (sessionInflight) return sessionInflight;
        sessionInflight = loadSessionsOnce().finally(() => { sessionInflight = null; });
        return sessionInflight;
      }

      async function loadSessionsOnce() {
        // Set once `lookAt` is known, below.
        let mine = null;
        const stale = () => mine !== sessionWant;

        /*
         * The key and the list are two reads, and one must not blank the other.
         *
         * They were in the same `try`, so a hiccup fetching the server's key —
         * a cold start, a slow RPC, anything — threw before the table was ever
         * written, and the whole card came up empty with no message. That is
         * the "sometimes nothing": not an empty wallet, an exception two lines
         * above the render.
         */
        /*
         * The key and the list are two reads, and the list is the one that
         * draws the table. This runs alongside rather than in front of it: it
         * used to be awaited first, holding one of the browser's six
         * connections for as long as it took while the table showed nothing.
         */
        fetch("/api/sessions/key").then((x) => x.json()).then((key) => {
          $("skKeyAddr").textContent = key.key || "no session key configured on this server";
          if ($("skOpen")) $("skOpen").disabled = !key.key;
          /*
           * Whether the key can send anything at all.
           *
           * USDC is the gas token on Arc, so a session key holding none cannot
           * broadcast a transaction however generous the delegation is — and it
           * starts with none. Every scheduled payment failed on that with a
           * message about a balance, which read as a complaint about the
           * delegating wallet and was nothing of the kind. The app tops it up
           * within a hard cap; this says where it stands.
           */
          if ($("skKeyGas") && key.key) {
            const gas = Number(key.gas || 0);
            $("skKeyGas").style.display = "";
            $("skKeyGas").style.color = gas > 0 ? "var(--muted)" : "var(--warn)";
            $("skKeyGas").textContent = gas > 0
              ? `Gas float: ${key.gas} USDC — enough to send. The app tops this up in ${key.gasFloat} USDC steps when it runs low.`
              : `Gas float: none. USDC is the gas token here, so the app will send this key ${key.gasFloat} USDC ` +
                `from its own wallet the first time a scheduled payment runs.`;
          }
        }).catch(() => {
          // No key, or it would not answer. The sessions below are still worth
          // reading — they exist on chain whatever this server can sign for.
          $("skKeyAddr").textContent = "could not read the session key just now";
        });

        try {
          const from = await connectedAddress().catch(() => null);
          /*
           * Whose sessions this table is showing.
           *
           * Normally the connected wallet's own. The search box can point it at
           * any address, because a delegation is public on chain and looking
           * one up is how you check what a wallet has signed away — but a
           * session that is not yours is read-only here, and says so.
           */
          const q = ($("skSearch") ? $("skSearch").value : "").trim();
          const searchAddr = /^0x[0-9a-fA-F]{40}$/.test(q) ? q : null;
          const lookAt = searchAddr || from;
          mine = lookAt;
          sessionWant = lookAt;
          sessionOwnerShown = lookAt;
          if (!lookAt) {
            $("skRows").innerHTML = emptyRow(4, "Connect a wallet, or search an address, to see sessions.");
            sessionRows = [];
            sessionAll = [];
            renderSessionPicker();
            return;
          }
          // Reading a list of delegations is several paced chain calls, so say
          // it is happening rather than leaving the previous owner's rows on
          // screen looking like the answer.
          if ($("skCount")) $("skCount").textContent = `Reading ${String(lookAt).slice(0, 10)}…'s sessions…`;
          const res = await fetch(`/api/sessions?owner=${lookAt}`);
          const r = await res.json().catch(() => ({ ok: false }));
          if (stale()) return;
          /*
           * A read that failed is not an empty list.
           *
           * This rendered "No sessions yet." whenever the request errored,
           * which is a statement about the wallet and was false — the
           * delegations were there, the server just could not reach the chain
           * for a moment. Keep what is on screen, say what happened, and try
           * again shortly.
           */
          if (!r.ok) {
            if ($("skCount")) {
              $("skCount").style.color = "var(--warn)";
              $("skCount").textContent = sessionAll.length
                ? "Could not re-read your sessions just now — showing the last reading, retrying…"
                : "Could not read your sessions just now — retrying…";
            }
            clearTimeout(sessionRetry);
            sessionRetry = setTimeout(() => loadSessions(), 4000);
            return;
          }
          if ($("skCount")) $("skCount").style.color = "";
          // On-chain order is creation order, so the newest is last. Newest
          // first is what a list of "what did I just open" wants.
          sessionAll = (r.sessions || []).slice().reverse();
          /*
           * Which sessions this server can actually spend from.
           *
           * `ours` is the one that kept being missed. A session names the key
           * it delegates to, and a key that has since been replaced — or a
           * session opened while the server had none — leaves a delegation that
           * looks perfectly healthy and that this server can never use. Those
           * were offered in the task picker anyway, and the only way to find
           * out was creating a task and being told "that session is delegated
           * to a different key".
           */
          sessionRows = searchAddr && from && searchAddr.toLowerCase() !== from.toLowerCase()
            ? []  // somebody else's delegation — visible, never schedulable here
            : sessionAll.filter(sessionUsable);
          renderSessionTable();
          renderSessionPicker();
          if (r.stale && r.note && $("skCount")) {
            $("skCount").style.color = "var(--warn)";
            $("skCount").textContent = r.note;
          }
        } catch (e) {
          /*
           * Say something. Anything.
           *
           * This swallowed the error and left an empty table, which reads as
           * "you have no sessions" — a claim about somebody's wallet made on
           * the strength of a failed fetch. Keep the rows that are there, name
           * the problem, and come back for another go.
           */
          if ($("skCount")) {
            $("skCount").style.color = "var(--warn)";
            $("skCount").textContent = `Could not read sessions: ${String((e && e.message) || e).slice(0, 90)} — retrying…`;
          }
          if (!sessionAll.length && $("skRows") && !$("skRows").innerHTML) {
            $("skRows").innerHTML = emptyRow(4, "Could not read sessions just now — retrying.");
          }
          clearTimeout(sessionRetry);
          sessionRetry = setTimeout(() => loadSessions(), 4000);
        }
      }

      /** The address the wallet is currently offering, or null. */
      async function connectedAddress() {
        try {
          if (!eth()) return null;
          const accts = await eth().request({ method: "eth_accounts" });
          return accts && accts[0] ? accts[0] : null;
        } catch { return null; }
      }

      /* ---- How long a session lasts -----------------------------------------
       *
       * The contract stores one `uint64` expiry and refuses one already in the
       * past, so "no time limit" is not a separate mode — it is the largest
       * expiry the field can hold. Anything past the year 3000 is treated as
       * that everywhere it is read back, because a session ending in the year
       * 584 billion is not a date a reader should ever be shown.
       *
       * Months and years are counted on the calendar rather than as a fixed
       * number of seconds. "One month" means the same day next month, which is
       * what somebody typing it means, and 30 days is only that in April.
       */

      /**
       * The expiry the form is asking for, as a unix second.
       *
       * @returns {{ expiry: string, forever: boolean, error?: string }}
       *   `forever` when the box was left empty, which is the documented way to
       *   ask for a session with no time limit at all.
       */
      function sessionExpiry() {
        const raw = ($("skFor") ? $("skFor").value : "").trim();
        if (!raw) return { expiry: NO_EXPIRY, forever: true };
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          return { expiry: "0", forever: false, error: "how long should it last? Leave it empty for no time limit." };
        }
        const unit = ($("skForUnit") && $("skForUnit").value) || "day";
        const now = new Date();
        if (unit === "month" || unit === "year") {
          const whole = Math.floor(n);
          const at = new Date(now);
          if (unit === "month") at.setMonth(at.getMonth() + whole);
          else at.setFullYear(at.getFullYear() + whole);
          // A fractional month or year is honoured as the leftover in days,
          // rather than silently rounded away.
          const daysOver = (n - whole) * (unit === "month" ? 30 : 365);
          at.setDate(at.getDate() + Math.round(daysOver));
          return { expiry: String(Math.floor(at.getTime() / 1000)), forever: false };
        }
        const secs = Math.round(n * (FIXED_UNITS[unit] || 86400));
        if (secs < 1) return { expiry: "0", forever: false, error: "that is less than a second" };
        return { expiry: String(Math.floor(Date.now() / 1000) + secs), forever: false };
      }

      /** Say in words what the two boxes add up to, under the two boxes. */
      function showSessionFor() {
        const note = $("skForNote");
        if (!note) return;
        const r = sessionExpiry();
        note.style.color = r.error ? "var(--warn)" : "var(--muted)";
        note.textContent = r.error
          ? r.error
          : r.forever
            ? "No time limit — the session lasts until you revoke it."
            : `Runs until ${new Date(Number(r.expiry) * 1000).toLocaleString()}.`;
      }
      if ($("skFor")) $("skFor").addEventListener("input", showSessionFor);
      if ($("skForUnit")) $("skForUnit").addEventListener("change", showSessionFor);
      showSessionFor();

      /**
       * The session this form is replacing, when the reader asked to raise or
       * extend one. Null while it is just opening a new session.
       */
      let replacing = null;

      /** Say what the button is about to do, and offer a way back out. */
      function renderReplacing() {
        const note = $("skReplacing");
        const btn = $("skOpen");
        if (btn) {
          btn.textContent = replacing ? "Approve & replace session" : "Approve & open session";
        }
        if (!note) return;
        if (!replacing) { note.style.display = "none"; return; }
        const row = sessionAll.find((x) => x.id === replacing);
        note.style.display = "";
        note.innerHTML =
          `Replacing session <span class="mono">${esc(replacing.slice(0, 14))}…</span>` +
          (row ? ` (${esc(row.cap)} ${esc(row.symbol)} cap, ${esc(row.spent)} spent)` : "") +
          `. The new one opens first, any scheduled tasks move onto it, and only then is the old one revoked — ` +
          `so nothing is left unable to pay. Spending already done does not carry over. ` +
          `<button class="btn" id="skReplaceCancel" style="padding:1px 8px;font-size:11px">Cancel</button>`;
        const cancel = $("skReplaceCancel");
        if (cancel) cancel.addEventListener("click", () => { replacing = null; renderReplacing(); });
      }

      if ($("skOpen")) {
        $("skOpen").addEventListener("click", async () => {
          const cfg = await loadDefiConfig();
          if (!cfg.sessionKeys) return showReceipt("skMsg", false, "session keys are not deployed on this network");
          const keyCfg = await (await fetch("/api/sessions/key")).json();
          if (!keyCfg.key) return showReceipt("skMsg", false, keyCfg.note || "no session key on this server");
          const asset = $("skAsset").value;
          const dec = walDecimals(asset);
          const cap = $("skCap").value.trim(), perTx = $("skPerTx").value.trim();
          const when = sessionExpiry();
          if (!(parseFloat(cap) > 0)) return showReceipt("skMsg", false, "set a cap above zero");
          if (when.error) return showReceipt("skMsg", false, when.error);
          const allow = $("skAllow").value.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean);
          if (allow.some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))) {
            return showReceipt("skMsg", false, "one of those allow-list entries is not an address");
          }
          const capRaw = toRaw(cap, dec);
          const perTxRaw = parseFloat(perTx) > 0 ? toRaw(perTx, dec) : "0";
          const expiry = when.expiry;
          /*
           * Two signatures, in this order, and the order matters.
           *
           * The allowance is a ceiling the wallet controls independently of
           * this contract — it is what lets somebody revoke from any wallet UI
           * without asking us. Opening the session first would leave a live
           * delegation that cannot move anything, which reads as broken.
           *
           * And it approves the new cap *plus what the live sessions still
           * have*, because `approve` replaces rather than adds. Approving only
           * the new cap silently cut the allowance every existing session was
           * relying on: open a 0.02 session after a 30 one and the 30 could
           * suddenly pay 0.02. The sum is exactly what the owner has agreed to,
           * session by session — never an unlimited approval.
           */
          const committed = sessionAll
            .filter((x) => String(x.asset).toLowerCase() === asset.toLowerCase() &&
              !x.revoked && x.expiry * 1000 > Date.now())
            .reduce((t, x) => t + BigInt(x.capLeftRaw || "0"), 0n);
          const approveRaw = (committed + BigInt(capRaw)).toString();
          const approveHuman = fmtUnitsStr(approveRaw, dec);
          // The ids that exist before this, so the new one can be identified
          // after: `open` returns the id to the chain, not to the wallet.
          const before = new Set(sessionAll.map((x) => String(x.id).toLowerCase()));
          const approved = await selfCustody(
            "skMsg",
            committed > 0n
              ? `approve ${approveHuman} — this session's ${cap} plus what your other live sessions still hold`
              : `approve ${cap} for the session`,
            async (from, c) =>
              sendTx(from, asset, callData(c.selectors.erc20Approve, encAddr(c.sessionKeys), encUint(approveRaw))));
          /*
           * Stop if the allowance did not land.
           *
           * This used to carry on regardless, and the result was the thing that
           * looks most like a bug in the whole feature: a session that reads as
           * live, with its whole cap unspent, that cannot move a cent — because
           * the allowance it draws on was never granted.
           */
          if (!approved) return;
          const opened = await selfCustody(
            "skMsg",
            `open a ${cap} session${when.forever ? " with no time limit" : ""}`,
            async (from, c) =>
              sendTx(from, c.sessionKeys, callData(
                c.selectors.skOpen,
                encAddr(keyCfg.key), encAddr(asset), encUint(capRaw), encUint(perTxRaw), encUint(expiry),
                // The allow-list is the one dynamic argument, so its offset is
                // after the six head words.
                encUint(192), encArray(allow.map((a) => BigInt(a))),
              )),
          );
          await loadSessions();
          if (!opened || !replacing) { renderReplacing(); return; }

          /*
           * Finish the replacement: move the schedules, then end the old one.
           *
           * In that order, and never the reverse. Revoking first would leave
           * every scheduled task pointing at a dead session for as long as the
           * next two signatures take — and if the reader walks away between
           * them, permanently.
           */
          const old = replacing;
          const fresh = sessionAll.find((x) =>
            !before.has(String(x.id).toLowerCase()) &&
            String(x.asset).toLowerCase() === asset.toLowerCase() && !x.revoked);
          if (!fresh) {
            showReceipt("skMsg", false,
              "the new session opened, but this page could not find it to move your tasks across — " +
              "reload, then repoint them from the task list before revoking the old one");
            replacing = null;
            renderReplacing();
            return;
          }
          let moved = 0;
          try {
            const r = await (await postAuthed("/api/tasks/repoint", { from: old, to: fresh.id })).json();
            if (!r.ok) throw new Error(r.error || "could not move the tasks");
            moved = r.moved;
          } catch (e) {
            showReceipt("skMsg", false,
              `the new session is open, but your scheduled tasks could not be moved onto it ` +
              `(${String(e.message || e)}). The old session has been left alone so they keep working.`);
            replacing = null;
            renderReplacing();
            loadTasks();
            return;
          }
          await selfCustody("skMsg", `revoke the session you replaced${moved ? ` — ${moved} task(s) moved across` : ""}`,
            async (from, c) => sendTx(from, c.sessionKeys, callData(c.selectors.skRevoke, old.replace(/^0x/, ""))));
          replacing = null;
          renderReplacing();
          loadSessions();
          loadTasks();
        });

        if ($("skMore")) {
          $("skMore").addEventListener("click", () => { sessionPage += SESSION_PAGE; renderSessionTable(); });
        }
        if ($("skSearch")) {
          /*
           * Two kinds of search, and the difference is one round trip.
           *
           * A full address is a different owner's list and has to be fetched.
           * Anything else filters what is already here. Debounced, because
           * typing an address a character at a time would otherwise be forty
           * requests for the one that matters.
           */
          let searchTimer = null;
          const runSearch = () => {
            sessionPage = SESSION_PAGE;
            const q = $("skSearch").value.trim();
            if (/^0x[0-9a-fA-F]{40}$/.test(q) || !q) loadSessions();
            else renderSessionTable();
          };
          $("skSearch").addEventListener("input", () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(runSearch, 350);
          });
          if ($("skSearchClear")) {
            $("skSearchClear").addEventListener("click", () => { $("skSearch").value = ""; runSearch(); });
          }
        }

        $("skRows").addEventListener("click", async (e) => {
          /*
           * Raise the approval to cover every live session on this asset.
           *
           * The allowance is one number per wallet and token, shared by every
           * session — so this approves the *sum* of what all the live ones
           * could still spend. Approving one session's cap is what created the
           * problem: `approve` replaces rather than adds, so opening a small
           * session silently cut the allowance the big one was relying on.
           *
           * The sum is exactly what the owner has already agreed to, session by
           * session, and not a wei more. No unlimited approval, ever.
           */
          const allow = e.target.closest("button[data-skallow]");
          if (allow) {
            const asset = allow.dataset.skallow;
            const live = sessionAll.filter((x) =>
              String(x.asset).toLowerCase() === asset.toLowerCase() &&
              !x.revoked && x.expiry * 1000 > Date.now() && BigInt(x.capLeftRaw || "0") > 0n);
            const need = live.reduce((t, x) => t + BigInt(x.capLeftRaw || "0"), 0n);
            if (need <= 0n) return showReceipt("skMsg", false, "no live session needs an approval");
            const dec = live[0].decimals, sym = live[0].symbol;
            allow.disabled = true;
            await selfCustody(
              "skMsg", `approve ${fmtUnitsStr(need.toString(), dec)} ${sym} for ${live.length} session${live.length === 1 ? "" : "s"}`,
              async (from, c) => sendTx(from, asset, callData(c.selectors.erc20Approve, encAddr(c.sessionKeys), encUint(need.toString()))),
            );
            allow.disabled = false;
            loadSessions();
            return;
          }
          /*
           * Raise a cap, or push an expiry out.
           *
           * `TesseraSessionKeys` has `open` and `revoke` and nothing between
           * them, deliberately: a session's limits are what the owner signed
           * for, and a contract that could quietly raise them would make that
           * signature worth less. So "extend" is a replacement — open the
           * bigger one, move the schedules onto it, then end the old one — and
           * the page says exactly that instead of implying an edit.
           */
          const ext = e.target.closest("button[data-skext]");
          if (ext) {
            const row = sessionAll.find((x) => x.id === ext.dataset.skext);
            if (!row) return;
            replacing = row.id;
            $("skAsset").value = row.asset;
            $("skCap").value = row.cap;
            $("skPerTx").value = Number(row.perTxMaxRaw) > 0 ? row.perTxMax : "";
            $("skFor").value = "";
            $("skForUnit").value = "day";
            showSessionFor();
            renderReplacing();
            $("skCap").scrollIntoView({ behavior: "smooth", block: "center" });
            $("skCap").focus();
            $("skCap").select();
            return;
          }
          const cp = e.target.closest("button[data-skcopy]");
          if (cp) {
            try {
              await navigator.clipboard.writeText(cp.dataset.skcopy);
              showReceipt("skMsg", true, "session id copied");
            } catch { showReceipt("skMsg", false, "could not copy — select the id and copy it by hand"); }
            return;
          }
          const btn = e.target.closest("button[data-skrev]");
          if (!btn) return;
          const cfg = await loadDefiConfig();
          btn.disabled = true;
          await selfCustody("skMsg", "revoke the session", async (from, c) =>
            sendTx(from, c.sessionKeys, callData(c.selectors.skRevoke, btn.dataset.skrev.replace(/^0x/, ""))));
          btn.disabled = false;
          loadSessions();
        });
      }

      /* ---- tasks --------------------------------------------------------- */

      let taskActions = {};
      /** The rows as the server last described them, for the Edit button. */
      let taskRowsById = new Map();
      /** The wallet an operator's task pays from, named by the server. */
      let taskAppWallet = "";
      /** The task being edited, or null when the form creates a new one. */
      let editingTask = null;
      const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

      /**
       * The schedule pickers, built once and without asking the server.
       *
       * The offsets used to be built inside `loadTasks`, and the series form
       * copied that select's markup — so the offset dropdown was blank in two
       * situations that happen constantly. `loadTasks` returns early when the
       * server says "sign in", which is every poll while signed out, so nothing
       * was ever built; and a session that goes straight to the Task series tab
       * never runs `loadTasks` at all, leaving the series form copying an empty
       * select. Editing anything then showed no zone: the value being assigned
       * matched no option, and a select with no matching option shows blank.
       *
       * A list of UTC offsets does not depend on who is signed in or on any
       * response, so it is built from nothing, at load, for both forms.
       */
      function zoneOptionsHtml() {
        // Whole and half-hour offsets, which covers every zone in use.
        return Array.from({ length: 57 }, (_, i) => (i - 28) * 30)
          .map((m) => `<option value="${m}"${m === 0 ? " selected" : ""}>${zoneLabel(m)}</option>`)
          .join("");
      }
      function zoneLabel(m) {
        const sign = m < 0 ? "-" : "+", a = Math.abs(m);
        return `GMT${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
      }
      function ensureScheduleControls() {
        let built = false;
        for (const [zoneId, daysId] of [["taskZone", "taskDays"], ["serZone", "serDays"]]) {
          const zone = $(zoneId);
          if (zone && !zone.options.length) { zone.innerHTML = zoneOptionsHtml(); built = true; }
          const days = $(daysId);
          if (days && !days.children.length) {
            days.innerHTML = DAY_NAMES.map((d, i) =>
              `<label style="font-size:12px;margin-right:7px"><input type="checkbox" value="${i}" /> ${d}</label>`).join("");
            built = true;
          }
        }
        return built;
      }
      ensureScheduleControls();

      /**
       * Show a stored offset, including one this list does not carry.
       *
       * A handful of zones are on a 15- or 45-minute offset, and assigning a
       * value no option holds leaves the select blank rather than raising
       * anything — the same silent failure as the empty list above. An offset
       * that exists is worth showing even when it is unusual.
       */
      function setZone(el, minutes) {
        if (!el) return;
        const m = Number(minutes ?? 0) || 0;
        el.value = String(m);
        if (el.value !== String(m)) {
          el.insertAdjacentHTML("beforeend", `<option value="${m}">${zoneLabel(m)}</option>`);
          el.value = String(m);
        }
      }

      /** The parameters each verb needs, so the form asks for those and no others. */
      const TASK_FIELDS = {
        /*
         * No fields, and that is the whole entry.
         *
         * A faucet decides its own amount and the address is the task's owner,
         * so there is nothing to fill in. An empty list is a real answer here —
         * `taskParamRow` renders nothing and the form is just a name and a
         * schedule.
         */
        "faucet:topUp": ["faucetAsset", "to"],
        "lending:supply": ["asset", "amount"], "lending:withdraw": ["asset", "amount"],
        "lending:borrow": ["asset", "amount"], "lending:repay": ["asset", "amount"],
        "vault:deposit": ["amount"], "vault:withdraw": ["shares"],
        "swap:swap": ["asset", "tokenOut", "amount"],
        "amm:add": ["poolId", "amounts"], "amm:remove": ["poolId", "shares"],
        "amm:swap": ["poolId", "tokenIn", "tokenOut", "amountIn"],
        "wallet:send": ["asset", "to", "amount", "message", "memo"],
        /*
         * From the deployer's balance rather than the app wallet's. No asset
         * picker: the deployer's balance is the gas token, which on Arc is USDC.
         * `to` is optional and defaults to the app wallet, which is the wallet
         * this exists to keep funded.
         */
        "wallet:fundFromOwner": ["to", "amount"],
        "wallet:bulk": ["asset", "recipients", "message", "memo"],
        // Funded by a visitor's delegation rather than the app wallet.
        "wallet:sessionSend": ["session", "to", "amount", "message", "memo"],
        "wallet:sessionBulk": ["session", "recipients", "message", "memo"],
        /*
         * The same, into a venue rather than to an address.
         *
         * No asset picker: a session names the one token it can move, so the
         * asset is the session's and offering a second choice could only ever
         * be a way to get it wrong.
         */
        "lending:sessionSupply": ["session", "amount", "message", "memo"],
        "lending:sessionRepay": ["session", "amount", "message", "memo"],
        "vault:sessionDeposit": ["session", "amount", "message", "memo"],
        /*
         * A swap consumes what it is given, so it needs a floor on what comes
         * back. `slippage` rather than a stored `minOut`: a fixed number is
         * wrong within a day on a recurring trade — either it blocks every run
         * once the price moves, or it is so loose it protects nothing.
         */
        /*
         * `pair` rather than a bare `tokenOut` dropdown.
         *
         * The token being *sold* is the session's — a session moves one asset
         * and that is the one that funds the swap — so a lone dropdown reading
         * "USDC" beside an EURC session looks like the input and is the
         * output. The pair renders as "EURC → [into]" so both sides are on
         * screen, and the list excludes the asset being sold.
         */
        "swap:sessionSwap": ["session", "pair", "amount", "slippage", "message", "memo"],
        "amm:sessionSwap": ["poolId", "session", "pair", "amountIn", "slippage", "message", "memo"],
        // One session per asset in the pool — the AMM mints nothing for a
        // one-sided deposit, and a session moves exactly one token.
        "amm:sessionAdd": ["poolId", "poolSessions", "message", "memo"],
        /*
         * The exits, which name no session at all.
         *
         * A session key moves tokens; leaving a position starts from shares,
         * which no session can reach. The authority is an approval on the
         * position itself — `approveShares` on the AMM, a position operator on
         * the vault — granted from the DeFi tab and revocable there.
         */
        "amm:sessionRemove": ["poolId", "shares", "message"],
        "lending:sessionWithdraw": ["asset", "amount", "message"],
        "lending:sessionBorrow": ["asset", "amount", "message"],
        // In USDC, like the deposit beside it. Shares are an implementation
        // detail nobody schedules in; the conversion happens when it runs.
        "vault:sessionWithdraw": ["assets", "message"],
      };

      /**
       * Build the parameter inputs for the selected verb — without losing what
       * is already typed into them.
       *
       * This is called from every form change, including the schedule
       * dropdown, and it used to rebuild the row unconditionally. So filling in
       * a recipient and *then* choosing when it should run silently emptied the
       * recipient box: the form looked complete, and the task was created with
       * an undefined address. Values are carried across a rebuild, and a
       * rebuild that would change nothing does not happen at all.
       */
      /**
       * @param {string} [prefix] Which form: `"task"` for the scheduled-task
       *   form, `"step"` for the series step composer. Both ask for exactly the
       *   same parameters for a given verb — one builder, so a field added for
       *   one can never quietly be missing from the other.
       */
      /**
       * Verbs whose `to` may be left blank, and what blank means for each.
       *
       * `wallet:send` needs a recipient — there is nowhere sensible for a
       * payment with no destination to go. These two have a default that is
       * more useful than anything a reader would type: the faucet drips to your
       * own wallet, and a top-up from the deployer lands in the app wallet it
       * exists to keep funded. Both placeholders say so.
       */
      const OPTIONAL_TO = new Set(["faucet:topUp", "wallet:fundFromOwner"]);

      /**
       * The address complaint, or null when there is nothing to complain about.
       *
       * Shared by the task form and the series-step form because they had the
       * same check written out twice, and a rule duplicated is a rule that gets
       * fixed once. Both said "that is not an address" for an empty box the
       * placeholder had just described as optional.
       */
      function addressProblem(prefix, venue, action) {
        const el = $(`${prefix}ParamRow`).querySelector('[data-tp="to"]');
        if (!el) return null;
        const value = el.value.trim();
        if (!value) return OPTIONAL_TO.has(`${venue}:${action}`) ? null : "that is not an address";
        return /^0x[0-9a-fA-F]{40}$/.test(value) ? null : "that is not an address";
      }

      function taskParamRow(prefix = "task") {
        const venue = $(`${prefix}Venue`).value, action = $(`${prefix}Action`).value;
        const fields = TASK_FIELDS[`${venue}:${action}`] || [];
        const row = $(`${prefix}ParamRow`);
        if (!row) return;
        const assetOptions = walletAssets.map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`).join("");
        // Signature of what the row would contain. Same signature, same DOM —
        // and rebuilding identical DOM is how a half-typed form gets wiped.
        const sig = JSON.stringify([venue, action, fields, assetOptions, sessionRows.map((x) => [x.id, x.symbol, x.spendable])]);
        if (row.dataset.sig === sig) return;
        const kept = {};
        row.querySelectorAll("[data-tp]").forEach((el) => { kept[el.dataset.tp] = el.value; });
        row.dataset.sig = sig;
        row.innerHTML = fields.map((f) => {
          /*
           * The faucet's asset list is the faucet's, not the pool's.
           *
           * `assetOptions` is built from the wallet's tokens and carries
           * addresses; Circle's drip takes a token *name* and knows a different
           * set. Reusing the pool picker here would offer TSRA, which no faucet
           * has, and send an address where a name is expected.
           */
          if (f === "faucetAsset") {
            return `<select class="field" data-tp="asset">` +
              ["usdc", "eurc", "cirbtc"].map((a) => `<option value="${a}">${a.toUpperCase()}</option>`).join("") +
              `</select>`;
          }
          if (f === "asset" || f === "tokenIn" || f === "tokenOut") {
            return `<select class="field" data-tp="${f}">${assetOptions}</select>`;
          }
          if (f === "session") {
            // `sessionOptions` and nowhere else — this select is built here on
            // a form change and again in `loadSessions` when the chain answers,
            // and two renderers meant the labels disagreed depending on which
            // ran last.
            return `<select class="field" id="${prefix}Session" data-tp="sessionId">${sessionOptions()}</select>`;
          }
          if (f === "recipients") {
            /*
             * A list needs room to be a list.
             *
             * This was a single-line input, which meant the newline separator
             * the parser looks for could never be typed and a list of twenty
             * addresses had to be scrolled through a 220px box. It is the same
             * editor as the send form above, so a list pasted from a sheet
             * works in both places.
             */
            return `<textarea class="field" data-tp="${f}" rows="4" placeholder="0xabc…,1.5&#10;0xdef…,2" ` +
              `style="width:100%;font-family:var(--mono,monospace);font-size:12px"></textarea>` +
              `<span id="${prefix}RecipCount" style="font-size:11.5px;color:var(--muted)"></span>`;
          }
          if (f === "slippage") {
            return `<label style="font-size:11.5px;color:var(--muted);display:flex;gap:5px;align-items:center">` +
              `accept down to <input class="field" data-tp="maxSlippageBps" inputmode="numeric" value="100" ` +
              `style="width:74px" /> bps below the quote at run time</label>`;
          }
          if (f === "pair") {
            // Built by `renderSwapPair` once the session (and, for the AMM, the
            // pool) is known: which asset is sold and what may be bought are
            // both properties of those, not of the verb.
            return `<span data-swappair="1" style="display:flex;gap:7px;align-items:center;flex-wrap:wrap"></span>`;
          }
          if (f === "poolSessions") {
            // Filled in by `renderPoolSessions` once a pool is chosen: how many
            // rows there are is a property of the pool, not of the verb.
            return `<div data-poolsessions="1" style="display:flex;flex-direction:column;gap:5px;width:100%"></div>`;
          }
          if (f === "message") {
            // Optional, and honest about where it goes: this one never leaves
            // the app, so it must not look like something the recipient reads.
            return `<input class="field" data-tp="message" maxlength="200" placeholder="Note for your own records (optional)" ` +
              `style="min-width:200px;flex:1" />`;
          }
          if (f === "memo") {
            // And this one is the opposite: written into every transaction the
            // task sends, where the recipient and the explorer can read it.
            return `<input class="field" data-tp="memo" maxlength="180" ` +
              `placeholder="On-chain memo, sent with each payment (optional)" style="min-width:200px;flex:1" />`;
          }
          const ph = (venue === "faucet" && f === "to"
            ? "0x… address (blank = your own wallet)"
            : venue === "wallet" && action === "fundFromOwner" && f === "to"
              ? "0x… address (blank = the app wallet)"
              : {
                  amount: "Amount", amountIn: "Amount in", shares: "Shares", assets: "Amount",
                  poolId: "Pool id", amounts: "Amounts, comma separated", to: "0x… recipient",
                }[f]) || f;
          return `<input class="field" data-tp="${f}" placeholder="${esc(ph)}" style="min-width:${f === "to" ? 210 : 120}px" />`;
        }).join("");
        // Restore anything the visitor had already typed that this verb still
        // asks for. A select only keeps its value if the option still exists,
        // which is exactly the condition to check.
        row.querySelectorAll("[data-tp]").forEach((el) => {
          const was = kept[el.dataset.tp];
          if (was === undefined || was === "") return;
          if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === was)) return;
          el.value = was;
        });
        // The per-asset rows depend on which pool is chosen, so they are built
        // after the pool picker exists and rebuilt whenever it changes.
        if (fields.includes("poolSessions")) {
          renderPoolSessions(prefix);
          const poolEl = row.querySelector('[data-tp="poolId"]');
          if (poolEl && !poolEl.dataset.psBound) {
            poolEl.dataset.psBound = "1";
            poolEl.addEventListener("input", () => renderPoolSessions(prefix));
            poolEl.addEventListener("change", () => renderPoolSessions(prefix));
          }
        }
        // The pair depends on the session and, on the AMM, the pool — so it is
        // drawn after both pickers exist and redrawn whenever either changes.
        if (fields.includes("pair")) {
          renderSwapPair(prefix);
          for (const sel of ['[data-tp="sessionId"]', '[data-tp="poolId"]']) {
            const el = row.querySelector(sel);
            if (!el || el.dataset.pairBound) continue;
            el.dataset.pairBound = "1";
            el.addEventListener("input", () => renderSwapPair(prefix));
            el.addEventListener("change", () => renderSwapPair(prefix));
          }
        }
      }

      /**
       * Both sides of a scheduled swap, so the pair is readable.
       *
       * The asset being sold is whichever the chosen session pays in — a
       * session key moves exactly one token, and that token funds the swap. It
       * is shown rather than offered, because it is not a choice. What *is* a
       * choice is what to buy, and that list leaves out the asset being sold
       * (a swap into itself is not a trade) and, on the AMM, anything the
       * chosen pool does not hold.
       */
      function renderSwapPair(prefix) {
        const row = $(`${prefix}ParamRow`);
        const host = row && row.querySelector("[data-swappair]");
        if (!host) return;
        const sessEl = row.querySelector('[data-tp="sessionId"]');
        const session = sessionRows.find((x) => x.id === (sessEl ? sessEl.value : ""));
        const poolEl = row.querySelector('[data-tp="poolId"]');
        const pool = poolEl
          ? ((window.__amm && window.__amm.pools) || []).find((x) => String(x.id) === String(poolEl.value).trim())
          : null;

        // Only what this venue could actually pay out.
        let out = walletAssets;
        if (poolEl) out = pool ? pool.assets : [];
        if (session) {
          out = out.filter((a) => String(a.address).toLowerCase() !== String(session.asset).toLowerCase());
        }
        const sig = JSON.stringify([session ? session.asset : null, out.map((a) => a.address)]);
        if (host.dataset.sig === sig) return;
        const kept = (host.querySelector('[data-tp="tokenOut"]') || {}).value;
        host.dataset.sig = sig;

        const from = session
          ? `<b>${esc(session.symbol)}</b>`
          : `<span class="muted">pick a session</span>`;
        const opts = out.length
          ? out.map((a) => `<option value="${esc(a.address)}">${esc(a.symbol)}</option>`).join("")
          : `<option value="">${esc(poolEl && !pool ? "pick a pool first" : "nothing to swap into")}</option>`;
        host.innerHTML =
          `<span style="font-size:12.5px">${from}</span>` +
          `<span class="muted" style="font-size:13px">→</span>` +
          `<select class="field" data-tp="tokenOut" style="min-width:110px">${opts}</select>`;
        const sel = host.querySelector('[data-tp="tokenOut"]');
        if (kept && [...sel.options].some((o) => o.value === kept)) sel.value = kept;
      }

      /**
       * One session picker and one amount per asset in the chosen pool.
       *
       * The AMM will not mint shares for a one-sided deposit — every amount has
       * to be above zero — and a session key moves exactly one token, so a pool
       * of two assets needs two delegations. Rather than explaining that in a
       * paragraph nobody reads, the form asks for them by name.
       */
      function renderPoolSessions(prefix) {
        const host = $(`${prefix}ParamRow`)?.querySelector("[data-poolsessions]");
        if (!host) return;
        const poolEl = $(`${prefix}ParamRow`).querySelector('[data-tp="poolId"]');
        const poolId = String(poolEl ? poolEl.value : "").trim();
        const pool = ((window.__amm && window.__amm.pools) || []).find((x) => String(x.id) === poolId);
        const sig = JSON.stringify([poolId, pool ? pool.assets.map((a) => a.symbol) : null,
          sessionRows.map((x) => [x.id, x.symbol, x.spendable])]);
        if (host.dataset.sig === sig) return;
        const kept = [...host.querySelectorAll("[data-ps]")].map((el) => el.value);
        host.dataset.sig = sig;
        if (!pool) {
          host.innerHTML = `<span class="muted" style="font-size:11.5px">Pick a pool and its assets will be listed here.</span>`;
          return;
        }
        host.innerHTML = pool.assets.map((a, i) => {
          // Only sessions that pay in *this* asset can fund this row.
          const usable = sessionRows.filter((x) => String(x.asset).toLowerCase() === String(a.address).toLowerCase());
          const opts = usable.length
            ? usable.map((x) => `<option value="${esc(x.id)}">${esc(sessionLabel(x))}</option>`).join("")
            : `<option value="">no ${esc(a.symbol)} session — open one first</option>`;
          return `<div class="row-actions" style="gap:6px;flex-wrap:wrap">` +
            `<span class="muted" style="font-size:11.5px;min-width:52px">${esc(a.symbol)}</span>` +
            `<select class="field" data-ps="session" data-ix="${i}" style="min-width:150px;flex:1">${opts}</select>` +
            `<input class="field" data-ps="amount" data-ix="${i}" inputmode="decimal" placeholder="Amount" style="width:110px" />` +
            `</div>`;
        }).join("") +
          `<span class="muted" style="font-size:11px">Every asset needs an amount above zero — the pool mints ` +
          `nothing for a one-sided deposit — and the shares are minted to your wallet, not the app's.</span>`;
        // Put back what was typed, where the shape still matches.
        [...host.querySelectorAll("[data-ps]")].forEach((el, i) => {
          const was = kept[i];
          if (was === undefined || was === "") return;
          if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === was)) return;
          el.value = was;
        });
      }

      /** Live count of a recipient list, and which lines will not parse. */
      function countRecipientsIn(prefix) {
        const row = $(`${prefix}ParamRow`);
        if (!row) return;
        row.addEventListener("input", (e) => {
          if (!e.target.matches('[data-tp="recipients"]')) return;
          const el = $(`${prefix}RecipCount`);
          if (!el) return;
          const { rows, bad } = parseRecipientList(e.target.value, 6);
          el.textContent = `${rows.length} recipient${rows.length === 1 ? "" : "s"}` +
            (bad.length ? ` · line ${bad.join(", ")} unreadable` : "");
        });
      }

      /** @param {string} [prefix] See `taskParamRow`. */
      function taskParams(prefix = "task") {
        const venue = $(`${prefix}Venue`).value, action = $(`${prefix}Action`).value;
        const out = {};
        $(`${prefix}ParamRow`).querySelectorAll("[data-tp]").forEach((el) => { out[el.dataset.tp] = el.value.trim(); });
        // Amounts are stored in base units: a task outlives the form that made
        // it, and a decimal re-read against a different asset would be wrong.
        const session = sessionRows.find((x) => x.id === out.sessionId);
        // A session names its own asset, so a session-funded task converts
        // against that rather than against whatever the send form has selected.
        const dec = (a) => (session ? session.decimals : walDecimals(a || $("walSendAsset").value));
        if (session) out.asset = session.asset;
        if (out.amount !== undefined) out.amount = toRaw(out.amount || "0", dec(out.asset));
        /*
         * The vault's own token, which is what a vault withdrawal is written in.
         *
         * Not the send form's selected asset: this field belongs to the vault
         * and converting it against whatever the wallet tab last had open would
         * be wrong by a factor of a million the moment they differ.
         */
        if (out.assets !== undefined) {
          const vaultTok = (window.__defiCfg && (window.__defiCfg.vaultAsset || window.__defiCfg.usdc)) || null;
          out.assets = toRaw(out.assets || "0", vaultTok ? walDecimals(vaultTok) : 6);
        }
        if (out.amountIn !== undefined) out.amountIn = toRaw(out.amountIn || "0", dec(out.tokenIn));
        if (out.amounts !== undefined) {
          // Each amount against its own asset's decimals. Six for everything
          // turned an 18-decimal deposit into dust and a task that would have
          // added nothing to the pool for as long as it kept running.
          const pool = ((window.__amm && window.__amm.pools) || []).find((x) => String(x.id) === String(out.poolId ?? 0));
          const decs = pool ? pool.assets.map((a) => a.decimals) : [];
          out.amounts = String(out.amounts).split(/[,\s]+/).filter(Boolean)
            .map((v, i) => toRaw(v, decs[i] !== undefined ? decs[i] : 6));
        }
        if (out.recipients !== undefined) out.recipients = parseRecipientList(out.recipients, dec(out.asset)).rows;
        if (venue === "amm" || action === "remove") out.poolId = Number(out.poolId || 0);
        if (out.maxSlippageBps !== undefined) out.maxSlippageBps = Number(out.maxSlippageBps || 100);
        /*
         * The per-asset rows of an AMM deposit, in the pool's own order.
         *
         * Order is not cosmetic here: the contract pairs `amounts[i]` with
         * `assets[i]`, so a list built in any other order would pay the right
         * totals against the wrong reserves. Each amount is converted against
         * *its* session's asset, which is the only decimals that can be right.
         */
        const rows = [...$(`${prefix}ParamRow`).querySelectorAll("[data-ps]")];
        if (rows.length) {
          const ids = [];
          const amounts = [];
          const count = rows.filter((el) => el.dataset.ps === "session").length;
          for (let i = 0; i < count; i++) {
            const sEl = rows.find((el) => el.dataset.ps === "session" && Number(el.dataset.ix) === i);
            const aEl = rows.find((el) => el.dataset.ps === "amount" && Number(el.dataset.ix) === i);
            const sess = sessionRows.find((x) => x.id === (sEl ? sEl.value : ""));
            ids.push(sEl ? sEl.value : "");
            amounts.push(toRaw((aEl ? aEl.value : "") || "0", sess ? sess.decimals : 6));
          }
          out.sessionIds = ids;
          out.amounts = amounts;
          // The flat pickers are not part of this shape; leaving one behind
          // would have the server validate a session the form never asked for.
          delete out.sessionId;
          delete out.asset;
        }
        return out;
      }

      /**
       * The floor the server will apply, so the form can apply the same one.
       *
       * The two used to disagree: the form previewed "runs every 10 seconds",
       * the server clamped to its 15-second floor, and the row came back saying
       * "every 15 seconds" with nothing anywhere explaining the change. Reading
       * the limit from the server means there is one number, not two.
       */
      let taskLimits = { minSeconds: 5, maxSeconds: 315360000 };

      function taskSchedule() {
        const kind = $("taskKind").value;
        if (kind === "manual") return { kind: "manual" };
        if (kind === "every") {
          const want = Math.max(1, Number($("taskEveryN").value || 1)) * Number($("taskEveryUnit").value);
          const seconds = Math.min(taskLimits.maxSeconds, Math.max(taskLimits.minSeconds, want));
          return { kind: "every", seconds };
        }
        const base = {
          hour: Number($("taskHour").value || 0),
          minute: Number($("taskMinute").value || 0),
          offsetMinutes: Number($("taskZone").value || 0),
        };
        if (kind === "weekly") {
          const days = [...$("taskDays").querySelectorAll("input:checked")].map((i) => Number(i.value));
          return { kind: "weekly", days, ...base };
        }
        if (kind === "monthly") return { kind: "monthly", day: Number($("taskDom").value || 1), ...base };
        return { kind: "yearly", month: Number($("taskMonth").value || 1), day: Number($("taskDom").value || 1), ...base };
      }

      /**
       * Load a task back into the form it was made in.
       *
       * Editing reuses the create form rather than opening a second one: two
       * forms for the same thing drift, and the one that drifts is always the
       * one used less. The form is filled from what the server last reported,
       * amounts converted back out of base units so the boxes read the way they
       * were typed.
       */
      function startEditing(id) {
        const t = taskRowsById.get(id);
        if (!t) return;
        editingTask = id;
        $("taskName").value = t.name || "";
        $("taskVenue").value = t.venue;
        $("taskAction").dataset.venue = ""; // force the verb list to rebuild
        syncTaskForm();
        $("taskAction").value = t.action;
        syncTaskForm();

        const s = t.schedule || { kind: "manual" };
        $("taskKind").value = s.kind;
        if (s.kind === "every") {
          // Show it in the largest whole unit it divides into, which is how it
          // was almost certainly typed.
          const unit = s.seconds % 604800 === 0 ? 604800
            : s.seconds % 86400 === 0 ? 86400
            : s.seconds % 3600 === 0 ? 3600
            : s.seconds % 60 === 0 ? 60 : 1;
          $("taskEveryUnit").value = String(unit);
          $("taskEveryN").value = String(s.seconds / unit);
        } else if (s.kind !== "manual") {
          $("taskHour").value = String(s.hour ?? 0);
          $("taskMinute").value = String(s.minute ?? 0);
          setZone($("taskZone"), s.offsetMinutes);
          if (s.kind === "weekly") {
            $("taskDays").querySelectorAll("input").forEach((i) => { i.checked = (s.days || []).includes(Number(i.value)); });
          }
          if (s.kind === "monthly" || s.kind === "yearly") $("taskDom").value = String(s.day ?? 1);
          if (s.kind === "yearly") $("taskMonth").value = String(s.month ?? 1);
        }
        syncTaskForm();

        // Params last: `syncTaskForm` rebuilds the inputs, so filling them
        // before it would fill boxes that are about to be replaced.
        const p = t.params || {};
        $("taskParamRow").querySelectorAll("[data-tp]").forEach((el) => {
          const k = el.dataset.tp;
          const raw = k === "sessionId" ? p.sessionId : p[k];
          if (raw === undefined || raw === null) return;
          const session = sessionRows.find((x) => x.id === p.sessionId);
          const dec = session ? session.decimals : walDecimals(p.asset);
          if (k === "amount" || k === "amountIn") el.value = fmtUnitsStr(String(raw), dec);
          else if (k === "recipients") {
            el.value = (Array.isArray(raw) ? raw : [])
              .map((x) => `${x.to},${fmtUnitsStr(String(x.amount), dec)}`).join("\n");
          } else el.value = String(raw);
        });

        previewTask();
        $("taskCreate").textContent = "Save changes";
        if ($("taskCancelEdit")) $("taskCancelEdit").style.display = "";
        showReceipt("taskMsg", true, `editing "${t.name}" — Save changes keeps its history`);
        $("taskVenue").scrollIntoView({ behavior: "smooth", block: "center" });
      }

      /** Back to creating, leaving the edited task exactly as it was. */
      /**
       * Back to creating — with an empty form, not the last task's contents.
       *
       * This cleared only the name, so everything else an edit had loaded
       * stayed in the boxes: recipient, amount, note and memo. Press Cancel and
       * then Create and you got a new task carrying the edited one's details —
       * which is how a memo written for somebody else's scheduled payment
       * turned up pre-filled on a fresh one. Values that belong to a task must
       * leave with it.
       */
      function stopEditing() {
        editingTask = null;
        $("taskName").value = "";
        $("taskCreate").textContent = "Create task";
        if ($("taskCancelEdit")) $("taskCancelEdit").style.display = "none";
        // Rebuild the parameter row from scratch rather than blanking it: the
        // `kept` restore in `taskParamRow` exists to survive a *rebuild*, and
        // would otherwise put the same values straight back.
        const row = $("taskParamRow");
        if (row) {
          row.querySelectorAll("[data-tp]").forEach((el) => {
            if (el.tagName === "SELECT") el.selectedIndex = 0;
            else el.value = "";
          });
          row.dataset.sig = "";
          // Rebuild immediately, from the blanked row. Leaving it to whatever
          // calls `taskParamRow` next means the values are only gone if nothing
          // re-reads them first, and "gone unless something looks" is not gone.
          taskParamRow();
        }
        if ($("taskRecipCount")) $("taskRecipCount").textContent = "";
        if (typeof previewTask === "function") previewTask();
      }

      function syncTaskForm() {
        const kind = $("taskKind").value;
        $("taskEvery").style.display = kind === "every" ? "" : "none";
        $("taskCalendar").style.display = kind === "manual" || kind === "every" ? "none" : "";
        $("taskDays").style.display = kind === "weekly" ? "" : "none";
        $("taskDom").style.display = kind === "monthly" || kind === "yearly" ? "" : "none";
        $("taskMonth").style.display = kind === "yearly" ? "" : "none";
        const v = $("taskVenue").value;
        const acts = taskActions[v] || [];
        if ($("taskAction").dataset.venue !== v) {
          $("taskAction").innerHTML = acts.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
          $("taskAction").dataset.venue = v;
        }
        taskParamRow();
      }

      /* ---- "only mine", for the operator ------------------------------------
       *
       * The operator sees every schedule on the deployment, which is right —
       * somebody has to be able to find one that is misbehaving, whoever wrote
       * it — but it means their own handful of standing orders sit among
       * everybody's, and the list is least readable for the person who has to
       * act on it.
       *
       * The choice is remembered because it is a working preference, not a
       * one-off: an operator who wants their own list wants it every time they
       * open the page, and having to re-tick it on every visit is the reason
       * filters like this go unused.
       */
      const MINE_KEYS = { task: "tessera_tasks_mine", series: "tessera_series_mine" };
      /** Wire one filter box: remember the choice, then re-read the list. */
      function wireMineFilter(which, reload) {
        const box = $(`${which === "task" ? "task" : "ser"}MineOnly`);
        if (!box) return;
        box.addEventListener("change", () => {
          rememberMine(which, box.checked);
          reload();
        });
      }
      const wantsMine = (which) => {
        try { return localStorage.getItem(MINE_KEYS[which]) === "1"; } catch { return false; }
      };
      const rememberMine = (which, on) => {
        try { localStorage.setItem(MINE_KEYS[which], on ? "1" : "0"); } catch { /* private mode */ }
      };
      /** `?mine=1` when the box is ticked. The server ignores it for visitors. */
      const mineQuery = (which) => (wantsMine(which) ? "?mine=1" : "");

      /**
       * Show the filter, and say what it is hiding.
       *
       * A list that is suddenly shorter with nothing explaining it reads as
       * schedules having disappeared — so the count is beside the box whether
       * it is ticked or not.
       */
      function renderMineFilter(which, r) {
        const row = $(`${which === "task" ? "task" : "ser"}MineRow`);
        const box = $(`${which === "task" ? "task" : "ser"}MineOnly`);
        const note = $(`${which === "task" ? "task" : "ser"}MineCount`);
        if (!row || !box) return;
        // Only the operator sees others' rows, so only the operator needs this.
        row.style.display = r.operator ? "" : "none";
        if (!r.operator) return;
        box.checked = wantsMine(which);
        if (!note) return;
        const total = Number(r.total ?? 0), mine = Number(r.mine ?? 0);
        const others = total - mine;
        const noun = which === "task" ? "task" : "series";
        const plural = which === "task" ? "tasks" : "series";
        // Name the two kinds by what pays for them, which is the distinction
        // that matters: the app wallet's, and visitors' own delegations.
        note.textContent = box.checked
          ? others
            ? `${mine} of ${total} — ${others} funded by visitors' own wallets, hidden`
            : `${mine} ${mine === 1 ? noun : plural}, and no visitor has any`
          : `${total} in total · ${mine} the app wallet's · ${others} from visitors' own wallets`;
      }

      async function loadTasks() {
        if (!$("taskRows")) return;
        const notReady = (why) => {
          // A card that 403s in silence looks broken: empty dropdowns, a
          // Create button that does nothing, and no reason given anywhere.
          if ($("tasksNotReady")) $("tasksNotReady").style.display = why ? "" : "none";
          if ($("taskCreate")) $("taskCreate").disabled = Boolean(why);
        };
        try {
          const res = await fetch(`/api/tasks${mineQuery("task")}`, { headers: authHeaders() });
          const r = await res.json();
          if (!r.ok) { notReady(r.error || "sign in to schedule anything"); return; }
          /*
           * A connected wallet can schedule too — from its own session key.
           *
           * The card used to be flatly operator-only, which made the session
           * key pointless from the visitor's side: you could delegate a
           * spending cap and then had no way to schedule anything against it.
           * The server decides what each caller may create; this reflects it.
           */
          notReady(r.operator || sessionRows.length
            ? null
            : "Open a session key above first — a scheduled payment from your own wallet is funded by one, " +
              "and bounded by the cap you set. Sessions that are revoked, expired, spent out, or delegated to a " +
              "key this app no longer holds cannot be scheduled against, and are not offered.");
          if ($("tasksOwnNote")) {
            $("tasksOwnNote").style.display = r.operator ? "none" : "";
            if (r.note) $("tasksOwnNote").textContent = r.note;
          }
          taskActions = r.actions || {};
          // The vault's token, for the withdrawal amount's decimals.
          if (!window.__defiCfg) loadDefiConfig().catch(() => {});
          renderMineFilter("task", r);
          if (r.limits) taskLimits = { ...taskLimits, ...r.limits };
          if (r.appWallet) taskAppWallet = r.appWallet;
          if ($("taskEveryN")) $("taskEveryN").min = "1";
          taskRowsById = new Map((r.tasks || []).map((t) => [t.id, t]));
          // Rebuild when the set of venues changes — signing in or out swaps a
          // visitor's two verbs for the operator's full list, and a stale
          // dropdown would offer verbs the server will refuse.
          const venueSig = Object.keys(taskActions).join(",");
          if ($("taskVenue").dataset.sig !== venueSig) {
            $("taskVenue").dataset.sig = venueSig;
            $("taskVenue").innerHTML = Object.keys(taskActions)
              .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
            $("taskAction").dataset.venue = "";
            syncTaskForm();
          }
          if (ensureScheduleControls()) syncTaskForm();
          $("taskRows").innerHTML = (r.tasks || []).length
            ? r.tasks.map((t) => {
                const when = stamp;
                const next = t.nextRunAt ? when(t.nextRunAt) : "—";
                /*
                 * "✓ 1 sent: 0.001 → 0x4D3163…" was the whole history, and it
                 * answered none of the questions actually asked of a task that
                 * spends on a timer: when did this last happen, how long has it
                 * been happening, who is being paid, and where is the receipt.
                 */
                const paidTo = t.venue === "wallet" && t.params && t.params.to ? String(t.params.to) : "";
                /*
                 * Where a faucet drip lands, resolved rather than left implied.
                 *
                 * The address is optional and blank means "the task's own
                 * wallet", which is exactly the case where a reader most wants
                 * it spelled out — a row that says only "faucet · topUp" gives
                 * them no way to check it is pointed where they meant before it
                 * starts running on a timer.
                 */
                const dripTo = t.venue === "faucet"
                  ? String((t.params && t.params.to) || t.owner || taskAppWallet || "")
                  : "";
                const dripDefaulted = t.venue === "faucet" && !(t.params && t.params.to);
                /*
                 * What it pays, and out of whose wallet.
                 *
                 * A row that says "wallet · send" and names a recipient still
                 * leaves the two questions people actually ask of a standing
                 * order unanswered: how much, and whose money. Both are in the
                 * task; neither was on screen.
                 */
                const p = t.params || {};
                const sess = sessionAll.find((x) => x.id === p.sessionId);
                const dec = sess ? sess.decimals : walDecimals(p.asset);
                const sym = sess ? sess.symbol : walSymbol(p.asset);
                const amountText =
                  // A faucet gives what it gives; the choice on the task is the
                  // token, so that is the thing worth showing where an amount
                  // would otherwise be.
                  t.venue === "faucet"
                    ? String(p.asset || "usdc").toUpperCase()
                  : p.amount !== undefined && p.amount !== null && p.amount !== ""
                    ? `${fmtUnitsStr(String(p.amount), dec)} ${sym}`.trim()
                    : Array.isArray(p.recipients) && p.recipients.length
                      ? `${fmtUnitsStr(String(p.recipients.reduce((sum, r) => sum + BigInt(r.amount || 0), 0n)), dec)} ${sym}`.trim() +
                        ` to ${p.recipients.length} address${p.recipients.length === 1 ? "" : "es"}`
                      : "";
                // Null owner is the app wallet — an operator's task. Anything
                // else is a visitor's, paid out of their own delegation.
                const owner = t.owner || "";
                /*
                 * "from the app wallet" is wrong for a drip.
                 *
                 * Nothing is spent to run one — the funds come from Circle, not
                 * from the wallet this line names. Printing a funding source for
                 * an inbound task states the opposite of what happens.
                 */
                const ownerLine = t.venue === "faucet"
                  ? `<div class="muted mono" style="font-size:10.5px;word-break:break-all">into ${esc(dripTo)}` +
                    `${dripDefaulted ? " (this task's own wallet)" : ""} ` +
                    `<button class="btn" data-tcopy="${esc(dripTo)}" style="padding:0 5px;font-size:10px">copy</button></div>`
                  : owner
                  ? `<div class="muted mono" style="font-size:10.5px;word-break:break-all">from ${esc(owner)} ` +
                    `<button class="btn" data-tcopy="${esc(owner)}" style="padding:0 5px;font-size:10px">copy</button></div>`
                  : `<div class="muted mono" style="font-size:10.5px;word-break:break-all">from the app wallet ${esc(taskAppWallet)} ` +
                    `<button class="btn" data-tcopy="${esc(taskAppWallet)}" style="padding:0 5px;font-size:10px">copy</button></div>`;
                const last = t.lastRunAt
                  ? `<div><b style="color:var(--${t.lastStatus === "ok" ? "good" : "warn"})">` +
                      `${t.lastStatus === "ok" ? "✓" : "✗"}</b> ${esc(when(t.lastRunAt))}</div>` +
                    `<div class="muted" style="font-size:11px">` +
                      `run ${t.runs}${t.firstRunAt ? ` · first ran ${esc(when(t.firstRunAt))}` : ""}` +
                      // What the run cost. Absent rather than zero when the
                      // receipts could not be read — free and unknown are not
                      // the same answer.
                      `${t.lastFee ? ` · fee ${esc(t.lastFee)} USDC` : ""}</div>` +
                    `<div style="font-size:11px;margin-top:2px">${esc(t.lastDetail || "")}</div>` +
                    (t.lastTxHash ? `<div style="font-size:11px;margin-top:2px">${txLink(t.lastTxHash)}</div>` : "")
                  : `<span class="muted">never run</span>` +
                    `<div class="muted" style="font-size:11px">created ${esc(when(t.createdAt))}</div>`;
                const payee = paidTo
                  ? `<div class="muted mono" style="font-size:10.5px;margin-top:3px;word-break:break-all">` +
                    `to ${esc(paidTo)} <button class="btn" data-tcopy="${esc(paidTo)}" ` +
                    `style="padding:1px 6px;font-size:10px;vertical-align:middle">copy</button></div>`
                  : "";
                /*
                 * The buttons get their own full-width row.
                 *
                 * They were a fourth cell, which on a phone put Stop and Delete
                 * off the right-hand edge of a table that scrolls — so the only
                 * control for a task that was firing every fifteen seconds was
                 * one the operator could not reach. A control that stops
                 * something spending money has to be the easiest thing on the
                 * row to hit.
                 */
                const state = t.busy
                  ? ` · <span style="color:var(--good)">running now</span>`
                  : t.enabled ? "" : ` · <span style="color:var(--warn)">paused</span>`;
                return `<tr><td><b>${esc(t.name)}</b>` +
                  `${amountText ? ` <span style="font-size:12px;color:var(--good)">${esc(amountText)}</span>` : ""}` +
                  `<div class="muted" style="font-size:11px">${esc(t.venue)} · ${esc(t.action)}${state}</div>` +
                  ownerLine + payee + `</td>` +
                  `<td style="font-size:12px">${esc(t.scheduleText)}<div class="muted" style="font-size:11px">next ${esc(next)}</div></td>` +
                  `<td style="font-size:11.5px">${last}</td></tr>` +
                  `<tr><td colspan="3" style="padding-top:0">` +
                  `<div style="display:flex;flex-wrap:wrap;gap:6px">` +
                  `<button class="btn" data-trun="${esc(t.id)}">Run now</button>` +
                  `<button class="btn" data-tedit="${esc(t.id)}">Edit</button>` +
                  // Pause and Stop are different questions — the next run, and
                  // the one happening right now — so they are different buttons.
                  `<button class="btn" data-ttog="${esc(t.id)}" data-tnext="${t.enabled ? "0" : "1"}">` +
                  `${t.enabled ? "Pause" : "Resume"}</button>` +
                  `<button class="btn warn" data-tstop="${esc(t.id)}"${t.stopping ? " disabled" : ""}>` +
                  `${t.stopping ? "Stopping…" : "Stop"}</button>` +
                  `<button class="btn" data-tdel="${esc(t.id)}">Delete</button>` +
                  `</div></td></tr>`;
              }).join("")
            : emptyRow(4, wantsMine("task") && r.total
                // "No tasks yet" under a filter that is hiding some is simply
                // untrue, and sends the reader looking for a bug.
                ? `None of the ${r.total} scheduled task${r.total === 1 ? "" : "s"} here runs on the app wallet — untick the box above to see the rest.`
                : "No tasks yet.");
        } catch { /* the pane stays as it was */ }
      }

      /*
       * Keep the list honest while something is happening in it.
       *
       * "Running now" and "Stopping…" are states that change without anybody
       * touching the page, and a Stop button is worth much less if you cannot
       * see whether it worked. Only while the pane is actually on screen — a
       * background poll of an operator-only endpoint is a request nobody asked
       * for.
       */
      setInterval(() => {
        const pane = $("paneWallet");
        if (!pane || pane.hidden || !$("taskRows")) return;
        if (document.hidden) return;
        // Only the tab in front of you: polling four cards to refresh one is
        // three requests nobody is reading.
        if (walletTab === "tasks") loadTasks();
        if (walletTab === "series") loadSeries();
      }, 5000);

      wireMineFilter("task", () => loadTasks());

      if ($("taskCreate")) {
        if ($("taskCancelEdit")) $("taskCancelEdit").addEventListener("click", () => {
          stopEditing();
          showReceipt("taskMsg", true, "edit cancelled — the task is unchanged");
        });
        ["taskKind", "taskVenue", "taskAction"].forEach((id) =>
          $(id).addEventListener("change", () => { syncTaskForm(); previewTask(); }));
        ["taskEveryN", "taskEveryUnit", "taskHour", "taskMinute", "taskZone", "taskDom", "taskMonth"].forEach((id) =>
          $(id).addEventListener("input", previewTask));
        $("taskDays").addEventListener("change", previewTask);

        /** Say the schedule back in words before it is saved, not after. */
        function previewTask() {
          const s = taskSchedule();
          const zone = zoneLabel;
          const at = () => `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")} ${zone(s.offsetMinutes)}`;
          // The typed figure, before the floor — so a raise can be named rather
          // than just silently appearing in the sentence.
          const typed = Math.max(1, Number($("taskEveryN").value || 1)) * Number($("taskEveryUnit").value);
          const raised = s.kind === "every" && s.seconds !== typed;
          const every = (n) => {
            const u = n % 604800 === 0 ? [n / 604800, "week"]
              : n % 86400 === 0 ? [n / 86400, "day"]
              : n % 3600 === 0 ? [n / 3600, "hour"]
              : n % 60 === 0 ? [n / 60, "minute"]
              : [n, "second"];
            return `every ${u[0] === 1 ? "" : u[0] + " "}${u[1]}${u[0] === 1 ? "" : "s"}`;
          };
          const text =
            s.kind === "manual" ? "runs only when you press Run"
            : s.kind === "every"
              ? `runs ${every(s.seconds)}` +
                (raised ? ` — ${taskLimits.minSeconds} seconds is the fastest the runner ticks, so ${typed} was raised` : "")
            : s.kind === "weekly" ? (s.days.length ? `runs ${s.days.map((d) => DAY_NAMES[d]).join(", ")} at ${at()}` : "pick at least one day")
            : s.kind === "monthly" ? `runs on day ${s.day} of each month at ${at()}`
            : `runs on ${s.month}/${s.day} each year at ${at()}`;
          $("taskPreview").textContent = text;
          $("taskPreview").style.color = raised ? "var(--warn)" : "";
        }
        window.previewTask = previewTask;

        // Count the list as it is typed, and name the lines that will not parse.
        countRecipientsIn("task");

        $("taskCreate").addEventListener("click", async () => {
          const btn = $("taskCreate");
          /*
           * Refuse a broken list here, not when it fires.
           *
           * A task is written once and runs unattended afterwards, so a bad
           * address that is only caught at run time is discovered in a log at
           * whatever hour the schedule chose. The form knows now.
           */
          const recipEl = $("taskParamRow").querySelector('[data-tp="recipients"]');
          if (recipEl) {
            const { rows, bad } = parseRecipientList(recipEl.value, 6);
            if (bad.length) return showReceipt("taskMsg", false, `line ${bad.join(", ")} is not "address,amount"`);
            if (!rows.length) return showReceipt("taskMsg", false, "add at least one recipient");
          }
          const toProblem = addressProblem("task", $("taskVenue").value, $("taskAction").value);
          if (toProblem) return showReceipt("taskMsg", false, toProblem);
          btn.disabled = true;
          showBusy("taskMsg", editingTask ? "saving your changes…" : "saving the task…");
          try {
            // Same body either way; only the address differs. An edit keeps the
            // task's id, and with it the run history that says whether this
            // task has ever actually worked.
            const body = {
              name: $("taskName").value.trim(),
              venue: $("taskVenue").value,
              action: $("taskAction").value,
              params: taskParams(),
              schedule: taskSchedule(),
            };
            const r = await (await postAuthed(editingTask ? `/api/tasks/${editingTask}` : "/api/tasks", body)).json();
            showReceipt(
              "taskMsg", Boolean(r.ok),
              r.ok ? `${editingTask ? "saved" : "created"} — ${r.scheduleText}` : `failed: ${r.error}`,
            );
            if (r.ok) { stopEditing(); loadTasks(); }
          } catch { showReceipt("taskMsg", false, "request failed"); }
          finally { btn.disabled = false; }
        });

        $("taskRows").addEventListener("click", async (e) => {
          const btn = e.target.closest("button");
          if (!btn) return;
          const run = btn.dataset.trun, del = btn.dataset.tdel, tog = btn.dataset.ttog;
          const edit = btn.dataset.tedit, stop = btn.dataset.tstop, copy = btn.dataset.tcopy;
          if (edit) { startEditing(edit); return; }
          if (copy) {
            try {
              await navigator.clipboard.writeText(copy);
              showReceipt("taskMsg", true, "address copied");
            } catch { showReceipt("taskMsg", false, "could not copy — select the address and copy it by hand"); }
            return;
          }
          btn.disabled = true;
          try {
            if (run) {
              showBusy("taskMsg", "running the task…");
              const r = await (await postAuthed(`/api/tasks/${run}/run`, {})).json();
              showReceipt("taskMsg", Boolean(r.ok), r.ok ? `ran: ${r.detail}` : `failed: ${r.detail || r.error}`, r.txHash);
            } else if (del) {
              const t = taskRowsById.get(del);
              if (!confirm(`Delete "${t ? t.name : "this task"}"? This cannot be undone.`)) { btn.disabled = false; return; }
              await postAuthed(`/api/tasks/${del}/delete`, {});
              if (editingTask === del) stopEditing();
              showReceipt("taskMsg", true, "task deleted");
            } else if (stop) {
              showBusy("taskMsg", "stopping…");
              const r = await (await postAuthed(`/api/tasks/${stop}/stop`, {})).json();
              showReceipt("taskMsg", Boolean(r.ok), r.ok ? r.note : `failed: ${r.error}`);
            } else if (tog) {
              // Read the intent off the button rather than its label: a
              // translated or restyled label must not be able to flip the
              // meaning of the control that stops a task from spending.
              const enabled = btn.dataset.tnext === "1";
              const r = await (await postAuthed(`/api/tasks/${tog}`, { enabled })).json();
              showReceipt("taskMsg", Boolean(r.ok),
                r.ok
                  ? (enabled
                      ? "resumed — the schedule is live again"
                      : "paused — no further runs, but anything already in progress finishes")
                  : `failed: ${r.error}`);
            }
          } catch { showReceipt("taskMsg", false, "request failed"); }
          finally { btn.disabled = false; loadTasks(); loadWallet(); }
        });
      }

      /* ---- task series ---------------------------------------------------
       *
       * The same shape as a single task, one level up: a schedule, the same
       * five controls, and a list of members it triggers. It shares the task
       * card's schedule vocabulary deliberately — an operator who has learnt
       * "every 10 minutes" once should not have to learn it again here.
       * ================================================================== */

      let seriesRowsById = new Map();
      let editingSeries = null;

      function serSchedule() {
        const kind = $("serKind").value;
        if (kind === "manual") return { kind: "manual" };
        if (kind === "every") {
          const want = Math.max(1, Number($("serEveryN").value || 1)) * Number($("serEveryUnit").value);
          return { kind: "every", seconds: Math.min(taskLimits.maxSeconds, Math.max(taskLimits.minSeconds, want)) };
        }
        const base = {
          hour: Number($("serHour").value || 0),
          minute: Number($("serMinute").value || 0),
          offsetMinutes: Number($("serZone").value || 0),
        };
        if (kind === "weekly") {
          return { kind: "weekly", days: [...$("serDays").querySelectorAll("input:checked")].map((i) => Number(i.value)), ...base };
        }
        if (kind === "monthly") return { kind: "monthly", day: Number($("serDom").value || 1), ...base };
        return { kind: "yearly", month: Number($("serMonth").value || 1), day: Number($("serDom").value || 1), ...base };
      }

      function syncSeriesForm() {
        const kind = $("serKind").value;
        $("serEvery").style.display = kind === "every" ? "" : "none";
        $("serCalendar").style.display = kind === "manual" || kind === "every" ? "none" : "";
        $("serDays").style.display = kind === "weekly" ? "" : "none";
        $("serDom").style.display = kind === "monthly" || kind === "yearly" ? "" : "none";
        $("serMonth").style.display = kind === "yearly" ? "" : "none";
        // "All at once" gives every step its turn regardless, so there is no
        // failure for a later step to be stopped by.
        $("serOnFailure").style.display = $("serMode").value === "sequential" ? "" : "none";
      }

      /** The tasks to choose from, with the order they were ticked preserved. */
      /* ---- the steps of a series ------------------------------------------
       *
       * The steps are the series'. They used to be ids ticked out of the
       * scheduled-task list, which made every step two things at once — a
       * member here and a task with its own schedule, pause switch and history
       * over there. Pausing that task silently shortened the series; deleting
       * it silently emptied it; and a step that only ever runs inside a series
       * still had to be given a schedule that would never be used.
       *
       * So the series composes its own, with the same editor the task form
       * uses (`taskParamRow("step")`) so the two can never drift apart.
       */
      let serSteps = [];
      /** The server's own ceiling on how many steps one series may carry. */
      let seriesLimits = { maxSeries: 50, maxMembers: 25, maxName: 80 };
      /** The step being edited, by id — null while the composer adds a new one. */
      let editingStep = null;

      /** The venue and verb dropdowns, from whatever the server says we may run. */
      function syncStepForm() {
        if (!$("stepVenue")) return;
        const venueSig = Object.keys(taskActions).join(",");
        if ($("stepVenue").dataset.sig !== venueSig) {
          $("stepVenue").dataset.sig = venueSig;
          $("stepVenue").innerHTML = Object.keys(taskActions)
            .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
          $("stepAction").dataset.venue = "";
        }
        const v = $("stepVenue").value;
        const acts = taskActions[v] || [];
        if ($("stepAction").dataset.venue !== v) {
          $("stepAction").innerHTML = acts.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
          $("stepAction").dataset.venue = v;
        }
        taskParamRow("step");
      }

      /** One line per step: what it does, and the controls to move or drop it. */
      /**
       * Everything a step does, in the form both places that draw one need.
       *
       * The editor's list and the series table were describing the same step
       * two different ways — the editor gained the amount, the addresses and
       * the receipt; the table still said "1. faucet topUp" and a sentence.
       * They read from one function now, so a step cannot say one thing in the
       * list and another in the table.
       *
       * `series` is the row a step belongs to, which is what its wallet lines
       * are resolved against. The editor passes nothing and gets the series
       * being edited.
       */
      function stepFacts(st, series) {
        const badge = stepAmount(st);
        const last = st.lastStatus
          ? `<div class="muted" style="font-size:10.5px;margin-top:2px">` +
              `<b style="color:var(--${st.lastStatus === "ok" ? "good" : "warn"})">` +
              `${st.lastStatus === "ok" ? "✓" : st.lastStatus === "skipped" ? "–" : "✗"}</b> ` +
              `${st.lastRunAt ? esc(stamp(st.lastRunAt)) : esc(st.lastStatus)}` +
              `${st.lastDetail ? ` — ${esc(st.lastDetail)}` : ""}</div>` +
            (st.lastTxHash ? `<div style="font-size:10.5px;margin-top:1px">${txLink(st.lastTxHash)}</div>` : "")
          : `<div class="muted" style="font-size:10.5px;margin-top:2px">never run</div>`;
        return {
          badge: badge ? ` <span style="font-size:12px;color:var(--good)">${esc(badge)}</span>` : "",
          verb: `<div class="muted" style="font-size:11px">${esc(st.venue)} · ${esc(st.action)}${stepSummary(st)}</div>`,
          detail: stepWallets(st, series) + last,
        };
      }

      function renderSteps() {
        const host = $("serSteps");
        if (!host) return;
        host.innerHTML = serSteps.length
          ? serSteps.map((st, i) => {
              const off = st.enabled === false;
              /*
               * A step is a task, so it is described like one — the same way in
               * the list here and in the series table, from one function.
               */
              const f = stepFacts(st);
              return `<div class="row-actions" style="align-items:flex-start;gap:6px;flex-wrap:wrap">` +
                `<span class="muted" style="font-size:12px;min-width:18px">${i + 1}.</span>` +
                `<span style="flex:1;min-width:150px;font-size:12.5px${off ? ";opacity:.55" : ""}">` +
                `<b>${esc(st.name)}</b>` +
                `${f.badge}` +
                `${off ? ' <span style="color:var(--warn);font-size:10.5px">off</span>' : ""}` +
                f.verb + f.detail + `</span>` +
                `<button class="btn" data-stepup="${i}" ${i === 0 ? "disabled" : ""} style="padding:1px 7px;font-size:11px">↑</button>` +
                `<button class="btn" data-stepdown="${i}" ${i === serSteps.length - 1 ? "disabled" : ""} style="padding:1px 7px;font-size:11px">↓</button>` +
                `<button class="btn" data-stepedit="${i}" style="padding:1px 8px;font-size:11px">Edit</button>` +
                `<button class="btn" data-steptoggle="${i}" style="padding:1px 8px;font-size:11px">${off ? "Turn on" : "Turn off"}</button>` +
                `<button class="btn warn" data-stepdel="${i}" style="padding:1px 8px;font-size:11px">Remove</button>` +
                `</div>`;
            }).join("")
          : `<span class="muted" style="font-size:12px">No steps yet — add the first one below.</span>`;
      }

      /**
       * A timestamp as every row here prints one.
       *
       * The task list and the series list each carried their own copy of this
       * inside a map callback, which is why a step row could not say when it
       * last ran: the formatter was not in scope where the steps are drawn.
       */
      function stamp(ms) {
        return new Date(ms).toLocaleString(undefined, {
          year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
      }

      /**
       * What a step moves, as the task row prints it — the figure in green.
       *
       * A faucet gives what it gives, so the token is the whole answer there;
       * everywhere else it is the amount, in the units of the session or asset
       * the step actually names.
       */
      function stepAmount(st) {
        const p = st.params || {};
        if (st.venue === "faucet") return String(p.asset || "usdc").toUpperCase();
        const session = sessionAll.find((x) => x.id === p.sessionId) || sessionRows.find((x) => x.id === p.sessionId);
        const dec = session ? session.decimals : walDecimals(p.asset);
        const sym = session ? session.symbol : walSymbol(p.asset);
        if (p.amount !== undefined && p.amount !== null && p.amount !== "") {
          return `${fmtUnitsStr(String(p.amount), dec)} ${sym || ""}`.trim();
        }
        if (Array.isArray(p.recipients) && p.recipients.length) {
          const total = p.recipients.reduce((sum, r) => sum + BigInt(r.amount || 0), 0n);
          return `${fmtUnitsStr(String(total), dec)} ${sym || ""}`.trim() +
            ` to ${p.recipients.length} address${p.recipients.length === 1 ? "" : "es"}`;
        }
        return "";
      }

      /**
       * Whose wallet a step would run as.
       *
       * A step carries no owner of its own — the series owns it. A series that
       * exists says so directly, whether it is the one being edited or a row in
       * the list; one still being composed belongs to whoever is composing it,
       * which is the connected wallet, or the app wallet when an operator is
       * working without one. Resolving it here is what lets a step print the
       * same two addresses a task row prints.
       */
      function stepOwner(series) {
        const row = series || (editingSeries ? seriesRowsById.get(editingSeries) : null);
        if (row) return String(row.owner || taskAppWallet || "");
        return String(window.__myAddress || taskAppWallet || "");
      }

      /**
       * Whose wallet a step spends, and whose it pays — in full, and copyable.
       *
       * The summary line truncates an address to ten characters, which is fine
       * for recognising one you already know and useless for checking one you
       * do not. The task row prints both ends in full for exactly that reason,
       * and a step is no less worth checking before it runs on a timer.
       */
      function stepWallets(st, series) {
        const p = st.params || {};
        const line = (label, addr, note) =>
          `<div class="muted mono" style="font-size:10.5px;word-break:break-all">${label} ${esc(addr)}` +
          `${note ? ` ${note}` : ""} ` +
          `<button class="btn" data-stepcopy="${esc(addr)}" style="padding:0 5px;font-size:10px">copy</button></div>`;
        if (st.venue === "faucet") {
          /*
           * Nothing is spent to run a drip — the funds come from Circle — so
           * naming a funding source here would state the opposite of what
           * happens. Only the destination is real, and a blank one is exactly
           * the case worth spelling out rather than leaving implied.
           */
          const to = String(p.to || "") || stepOwner(series);
          return to
            ? line("into", to, p.to ? "" : "(this series' own wallet)")
            : `<div class="muted" style="font-size:10.5px">into this series' own wallet</div>`;
        }
        const out = [];
        /*
         * A session-funded step spends the delegation, not the series owner's
         * balance, so the session's owner is the truthful funding side when
         * there is one.
         */
        const session = sessionAll.find((x) => x.id === p.sessionId) || sessionRows.find((x) => x.id === p.sessionId);
        const from = (session && session.owner) || stepOwner(series);
        if (from) out.push(line("from", String(from), ""));
        if (p.to) out.push(line("to", String(p.to), ""));
        return out.join("");
      }

      /**
       * What is left to say once the row has said the rest.
       *
       * This line used to carry the amount and a ten-character stub of the
       * destination, because it was the only line there was. Both are now shown
       * properly — the amount as the figure in green, the addresses in full and
       * copyable — so repeating them here would just be the same facts twice,
       * once in a form too short to check. What no other line answers is which
       * delegation a session-funded step spends.
       */
      function stepSummary(st) {
        const p = st.params || {};
        if (!p.sessionId) return "";
        const session = sessionAll.find((x) => x.id === p.sessionId) || sessionRows.find((x) => x.id === p.sessionId);
        const label = session && session.symbol ? `${session.symbol} session` : "session";
        return ` · ${esc(label)} ${esc(String(p.sessionId).slice(0, 10))}…`;
      }

      async function loadSeries() {
        if (!$("serRows")) return;
        try {
          const r = await (await fetch(`/api/series${mineQuery("series")}`, { headers: authHeaders() })).json();
          if (!r.ok) {
            if ($("seriesNotReady")) {
              $("seriesNotReady").style.display = "";
              $("seriesNotReady").textContent = r.error || "sign in to build a series";
            }
            if ($("seriesBody")) $("seriesBody").style.display = "none";
            return;
          }
          if ($("seriesNotReady")) $("seriesNotReady").style.display = "none";
          if ($("seriesBody")) $("seriesBody").style.display = "";
          // The wallet an operator's steps spend from. Set here as well as in
          // the task list because this card loads on its own.
          if (r.appWallet) taskAppWallet = r.appWallet;
          seriesRowsById = new Map((r.series || []).map((x) => [x.id, x]));
          renderMineFilter("series", r);
          // What a series may be told to do is the server's call, the same as
          // for a task — a visitor gets their two session verbs, an operator
          // the full list.
          if (r.actions) taskActions = r.actions;
          // The vault's token, for the withdrawal amount's decimals.
          if (!window.__defiCfg) loadDefiConfig().catch(() => {});
          if (r.limits) seriesLimits = { ...seriesLimits, ...r.limits };
          if (ensureScheduleControls()) syncSeriesForm();
          syncStepForm();
          renderSteps();
          const when = stamp;
          $("serRows").innerHTML = (r.series || []).length
            ? r.series.map((x) => {
                const next = x.nextRunAt ? when(x.nextRunAt) : "—";
                const state = x.busy
                  ? ` · <span style="color:var(--good)">running now</span>`
                  : x.enabled ? "" : ` · <span style="color:var(--warn)">paused</span>`;
                const last = x.lastRunAt
                  ? `<div><b style="color:var(--${x.lastStatus === "ok" ? "good" : "warn"})">` +
                      `${x.lastStatus === "ok" ? "✓" : "✗"}</b> ${esc(when(x.lastRunAt))}</div>` +
                    `<div class="muted" style="font-size:11px">run ${x.runs}` +
                      `${x.firstRunAt ? ` · first ran ${esc(when(x.firstRunAt))}` : ""}</div>` +
                    `<div style="font-size:11px;margin-top:2px">${esc(x.lastDetail || "")}</div>`
                  : `<span class="muted">never run</span>`;
                const mine = x.steps || [];
                /*
                 * The steps, described as the scheduled-task table describes a
                 * task — because that is what each one is.
                 *
                 * This row used to be the only place a series was reviewed
                 * without opening it, and it said "1. faucet topUp" and a
                 * sentence of detail: not which token, not whose wallet, not
                 * where the receipt is. All of it was already on the step.
                 */
                const steps = mine.map((m, i) => {
                  const f = stepFacts(m, x);
                  return `<div style="font-size:11.5px;margin-top:5px${m.enabled === false ? ";opacity:.55" : ""}">` +
                    `<span class="muted">${x.mode === "sequential" ? `${i + 1}. ` : "· "}</span>${esc(m.name)}${f.badge}` +
                    `${m.enabled === false ? ' <span style="color:var(--warn);font-size:10.5px">off</span>' : ""}` +
                    f.verb + f.detail + `</div>`;
                }).join("");
                const on = mine.filter((m) => m.enabled !== false).length;
                return `<tr><td><b>${esc(x.name)}</b>` +
                  `<div class="muted" style="font-size:11px">` +
                  `${x.mode === "sequential" ? "one after another" : "all at once"}` +
                  `${x.mode === "sequential" && x.onFailure === "stop" ? ", stopping at the first failure" : ""} · ` +
                  `${on} step${on === 1 ? "" : "s"}` +
                  `${on === mine.length ? "" : ` (${mine.length - on} off)`}${state}</div>${steps}</td>` +
                  `<td style="font-size:12px">${esc(x.scheduleText)}<div class="muted" style="font-size:11px">next ${esc(next)}</div></td>` +
                  `<td style="font-size:11.5px">${last}</td></tr>` +
                  `<tr><td colspan="3" style="padding-top:0">` +
                  `<div style="display:flex;flex-wrap:wrap;gap:6px">` +
                  `<button class="btn" data-srun="${esc(x.id)}">Run now</button>` +
                  `<button class="btn" data-sedit="${esc(x.id)}">Edit</button>` +
                  `<button class="btn" data-stog="${esc(x.id)}" data-snext="${x.enabled ? "0" : "1"}">` +
                  `${x.enabled ? "Pause" : "Resume"}</button>` +
                  `<button class="btn warn" data-sstop="${esc(x.id)}"${x.stopping ? " disabled" : ""}>` +
                  `${x.stopping ? "Stopping…" : "Stop"}</button>` +
                  `<button class="btn" data-sdel="${esc(x.id)}">Delete</button>` +
                  `</div></td></tr>`;
              }).join("")
            : emptyRow(4, wantsMine("series") && r.total
                ? `None of the ${r.total} series here runs on the app wallet — untick the box above to see the rest.`
                : "No series yet.");
        } catch { /* leave the card as it was */ }
      }

      function startEditingSeries(id) {
        const x = seriesRowsById.get(id);
        if (!x) return;
        editingSeries = id;
        $("serName").value = x.name || "";
        $("serMode").value = x.mode;
        $("serOnFailure").value = x.onFailure === "stop" ? "stop" : "continue";
        // A copy: editing the form must not change the loaded row underneath it.
        serSteps = (x.steps || []).map((st) => ({ ...st, params: { ...st.params } }));
        if (window.__stopEditingStep) window.__stopEditingStep();
        renderSteps();
        const sc = x.schedule || { kind: "manual" };
        $("serKind").value = sc.kind;
        if (sc.kind === "every") {
          const unit = sc.seconds % 604800 === 0 ? 604800
            : sc.seconds % 86400 === 0 ? 86400
            : sc.seconds % 3600 === 0 ? 3600
            : sc.seconds % 60 === 0 ? 60 : 1;
          $("serEveryUnit").value = String(unit);
          $("serEveryN").value = String(sc.seconds / unit);
        } else if (sc.kind !== "manual") {
          $("serHour").value = String(sc.hour ?? 0);
          $("serMinute").value = String(sc.minute ?? 0);
          setZone($("serZone"), sc.offsetMinutes);
          if (sc.kind === "weekly") {
            $("serDays").querySelectorAll("input").forEach((i) => { i.checked = (sc.days || []).includes(Number(i.value)); });
          }
          if (sc.kind === "monthly" || sc.kind === "yearly") $("serDom").value = String(sc.day ?? 1);
          if (sc.kind === "yearly") $("serMonth").value = String(sc.month ?? 1);
        }
        syncSeriesForm();
        previewSeries();
        $("serCreate").textContent = "Save changes";
        if ($("serCancelEdit")) $("serCancelEdit").style.display = "";
        showReceipt("serMsg", true, `editing "${x.name}" — Save changes keeps its history`);
        $("serName").scrollIntoView({ behavior: "smooth", block: "center" });
      }

      /** Back to creating, with an empty form — see `stopEditing` for why. */
      function stopEditingSeries() {
        editingSeries = null;
        $("serName").value = "";
        serSteps = [];
        if (window.__stopEditingStep) window.__stopEditingStep();
        renderSteps();
        $("serCreate").textContent = "Create series";
        if ($("serCancelEdit")) $("serCancelEdit").style.display = "none";
        previewSeries();
      }

      function previewSeries() {
        const sc = serSchedule();
        const n = serSteps.filter((x) => x.enabled !== false).length;
        const zone = zoneLabel;
        const at = () => `${String(sc.hour).padStart(2, "0")}:${String(sc.minute).padStart(2, "0")} ${zone(sc.offsetMinutes)}`;
        const every = (x) => {
          const u = x % 604800 === 0 ? [x / 604800, "week"]
            : x % 86400 === 0 ? [x / 86400, "day"]
            : x % 3600 === 0 ? [x / 3600, "hour"]
            : x % 60 === 0 ? [x / 60, "minute"] : [x, "second"];
          return `every ${u[0] === 1 ? "" : u[0] + " "}${u[1]}${u[0] === 1 ? "" : "s"}`;
        };
        const when =
          sc.kind === "manual" ? "only when you press Run"
          : sc.kind === "every" ? every(sc.seconds)
          : sc.kind === "weekly" ? (sc.days.length ? `${sc.days.map((d) => DAY_NAMES[d]).join(", ")} at ${at()}` : "pick at least one day")
          : sc.kind === "monthly" ? `day ${sc.day} of each month at ${at()}`
          : `${sc.month}/${sc.day} each year at ${at()}`;
        $("serPreview").textContent = n
          ? `${n} step${n === 1 ? "" : "s"}, ${$("serMode").value === "sequential" ? "one after another" : "all at once"}` +
            `${$("serMode").value === "sequential" && $("serOnFailure").value === "stop" ? ", stopping at the first failure" : ""}, ${when}`
          : "add the steps this series should run";
      }

      wireMineFilter("series", () => loadSeries());

      /* ---- the step composer ---------------------------------------------- */
      if ($("stepAdd")) {
        countRecipientsIn("step");
        ["stepVenue", "stepAction"].forEach((id) =>
          $(id).addEventListener("change", () => { syncStepForm(); }));

        /** Back to adding, with the composer emptied. */
        function stopEditingStep() {
          editingStep = null;
          $("stepName").value = "";
          $("stepAdd").textContent = "Add step";
          $("stepCancel").style.display = "none";
          $("stepHead").textContent = "Add a step";
          $("stepHint").textContent = "";
          // Blank the parameters properly rather than leaving the last step's
          // recipient sitting in a form that now reads as a new one.
          const row = $("stepParamRow");
          if (row) {
            row.querySelectorAll("[data-tp]").forEach((el) => { el.value = ""; });
            row.dataset.sig = "";
            taskParamRow("step");
          }
          if ($("stepRecipCount")) $("stepRecipCount").textContent = "";
        }
        window.__stopEditingStep = stopEditingStep;

        $("stepCancel").addEventListener("click", () => {
          stopEditingStep();
          $("stepHint").textContent = "edit cancelled — the step is unchanged";
        });

        $("stepAdd").addEventListener("click", () => {
          const venue = $("stepVenue").value, action = $("stepAction").value;
          if (!venue || !action) { $("stepHint").textContent = "pick what this step should do"; return; }
          const recipEl = $("stepParamRow").querySelector('[data-tp="recipients"]');
          if (recipEl) {
            const { rows, bad } = parseRecipientList(recipEl.value, 6);
            if (bad.length) { $("stepHint").textContent = `line ${bad.join(", ")} is not "address,amount"`; return; }
            if (!rows.length) { $("stepHint").textContent = "add at least one recipient"; return; }
          }
          const toProblem = addressProblem("step", venue, action);
          if (toProblem) { $("stepHint").textContent = toProblem; return; }
          if (serSteps.length >= (seriesLimits.maxMembers || 25) && !editingStep) {
            $("stepHint").textContent = `that is the ${seriesLimits.maxMembers}-step limit for one series`;
            return;
          }
          const step = {
            // Kept when editing, so the step's run history survives a rename.
            id: editingStep || undefined,
            name: $("stepName").value.trim(),
            venue, action,
            params: taskParams("step"),
            enabled: true,
          };
          const at = editingStep ? serSteps.findIndex((x) => x.id === editingStep) : -1;
          if (at >= 0) serSteps[at] = { ...serSteps[at], ...step };
          else serSteps.push(step);
          stopEditingStep();
          renderSteps();
          previewSeries();
        });

        $("serSteps").addEventListener("click", (e) => {
          const btn = e.target.closest("button");
          if (!btn) return;
          const d = btn.dataset;
          // Copy carries an address rather than an index, so it is answered
          // before the index lookup below rejects it.
          if (d.stepcopy) {
            navigator.clipboard.writeText(d.stepcopy)
              .then(() => showReceipt("serMsg", true, "address copied"))
              .catch(() => showReceipt("serMsg", false, "could not copy — select the address and copy it by hand"));
            return;
          }
          const at = Number(d.stepup ?? d.stepdown ?? d.stepedit ?? d.steptoggle ?? d.stepdel);
          if (!Number.isInteger(at) || !serSteps[at]) return;
          if (d.stepup !== undefined) {
            [serSteps[at - 1], serSteps[at]] = [serSteps[at], serSteps[at - 1]];
          } else if (d.stepdown !== undefined) {
            [serSteps[at + 1], serSteps[at]] = [serSteps[at], serSteps[at + 1]];
          } else if (d.steptoggle !== undefined) {
            serSteps[at].enabled = serSteps[at].enabled === false;
          } else if (d.stepdel !== undefined) {
            if (editingStep === serSteps[at].id) stopEditingStep();
            serSteps.splice(at, 1);
          } else if (d.stepedit !== undefined) {
            const st = serSteps[at];
            // A step added in this sitting has no id yet; give it one so the
            // edit can find it again after the list is re-rendered.
            if (!st.id) st.id = `new-${Math.random().toString(36).slice(2, 10)}`;
            editingStep = st.id;
            $("stepName").value = st.name || "";
            $("stepVenue").value = st.venue;
            $("stepAction").dataset.venue = "";
            syncStepForm();
            fillParams("step", st.params || {});
            $("stepAdd").textContent = "Save step";
            $("stepCancel").style.display = "";
            $("stepHead").textContent = `Editing step ${at + 1}`;
            $("stepHint").textContent = "";
            $("stepName").scrollIntoView({ behavior: "smooth", block: "center" });
          }
          renderSteps();
          previewSeries();
        });
      }

      /**
       * Put stored parameters back into a form.
       *
       * The inverse of `taskParams`: amounts come back out of base units
       * against the same asset they went in against, so editing a step shows
       * the number that was typed rather than the raw integer.
       */
      function fillParams(prefix, params) {
        const row = $(`${prefix}ParamRow`);
        if (!row) return;
        const session = sessionRows.find((x) => x.id === params.sessionId);
        const dec = (a) => (session ? session.decimals : walDecimals(a || params.asset));
        row.querySelectorAll("[data-tp]").forEach((el) => {
          const k = el.dataset.tp;
          let v = params[k];
          if (v === undefined || v === null) { el.value = ""; return; }
          if (k === "amount") v = fmtUnitsStr(String(v), dec(params.asset));
          else if (k === "assets") {
            const vaultTok = (window.__defiCfg && (window.__defiCfg.vaultAsset || window.__defiCfg.usdc)) || null;
            v = fmtUnitsStr(String(v), vaultTok ? walDecimals(vaultTok) : 6);
          }
          else if (k === "amountIn") v = fmtUnitsStr(String(v), dec(params.tokenIn));
          else if (k === "recipients" && Array.isArray(v)) {
            v = v.map((r) => `${r.to},${fmtUnitsStr(String(r.amount), dec(params.asset))}`).join("\n");
          } else if (k === "amounts" && Array.isArray(v)) {
            const pool = ((window.__amm && window.__amm.pools) || []).find((x) => String(x.id) === String(params.poolId ?? 0));
            v = v.map((x, i) => fmtUnitsStr(String(x), pool ? pool.assets[i].decimals : 6)).join(", ");
          }
          if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(v))) return;
          el.value = String(v);
        });
      }

      if ($("serCreate")) {
        ["serKind", "serMode", "serOnFailure"].forEach((id) => $(id).addEventListener("change", () => { syncSeriesForm(); previewSeries(); }));
        ["serEveryN", "serEveryUnit", "serHour", "serMinute", "serZone", "serDom", "serMonth"].forEach((id) =>
          $(id).addEventListener("input", previewSeries));
        $("serDays").addEventListener("change", previewSeries);

        if ($("serCancelEdit")) $("serCancelEdit").addEventListener("click", () => {
          stopEditingSeries();
          showReceipt("serMsg", true, "edit cancelled — the series is unchanged");
        });

        $("serCreate").addEventListener("click", async () => {
          if (!serSteps.length) return showReceipt("serMsg", false, "add at least one step");
          if (editingStep) {
            return showReceipt("serMsg", false,
              "finish the step you are editing first — Save step, or Cancel to leave it as it was");
          }
          const btn = $("serCreate");
          btn.disabled = true;
          showBusy("serMsg", editingSeries ? "saving your changes…" : "saving the series…");
          try {
            const steps = serSteps.map((st) => ({
              // A locally-minted id means "new"; the server gives it a real one.
              id: String(st.id || "").startsWith("new-") ? undefined : st.id,
              name: st.name, venue: st.venue, action: st.action, params: st.params, enabled: st.enabled !== false,
            }));
            const body = {
              name: $("serName").value.trim(),
              mode: $("serMode").value,
              onFailure: $("serOnFailure").value,
              steps,
              schedule: serSchedule(),
            };
            const r = await (await postAuthed(editingSeries ? `/api/series/${editingSeries}` : "/api/series", body)).json();
            showReceipt("serMsg", Boolean(r.ok),
              r.ok ? `${editingSeries ? "saved" : "created"} — ${r.scheduleText}` : `failed: ${r.error}`);
            if (r.ok) { stopEditingSeries(); loadSeries(); }
          } catch { showReceipt("serMsg", false, "request failed"); }
          finally { btn.disabled = false; }
        });

        $("serRows").addEventListener("click", async (e) => {
          const btn = e.target.closest("button");
          if (!btn) return;
          const run = btn.dataset.srun, del = btn.dataset.sdel, tog = btn.dataset.stog;
          const edit = btn.dataset.sedit, stop = btn.dataset.sstop;
          if (edit) { startEditingSeries(edit); return; }
          /*
           * The steps in this table print their addresses in full with a copy
           * button, and `data-tcopy` is bound to the scheduled-task table only
           * — so without this the button would look right and do nothing. It is
           * answered before the disable-and-post path below, which is for the
           * verbs that talk to the server.
           */
          if (btn.dataset.stepcopy) {
            try {
              await navigator.clipboard.writeText(btn.dataset.stepcopy);
              showReceipt("serMsg", true, "address copied");
            } catch { showReceipt("serMsg", false, "could not copy — select the address and copy it by hand"); }
            return;
          }
          btn.disabled = true;
          try {
            if (run) {
              showBusy("serMsg", "running the series…");
              const r = await (await postAuthed(`/api/series/${run}/run`, {})).json();
              showReceipt("serMsg", Boolean(r.ok), r.ok ? `ran: ${r.detail}` : `did not finish: ${r.detail || r.error}`);
            } else if (del) {
              const x = seriesRowsById.get(del);
              if (!confirm(`Delete "${x ? x.name : "this series"}"? The tasks in it are not deleted.`)) { btn.disabled = false; return; }
              await postAuthed(`/api/series/${del}/delete`, {});
              if (editingSeries === del) stopEditingSeries();
              showReceipt("serMsg", true, "series deleted — its tasks are still there");
            } else if (stop) {
              showBusy("serMsg", "stopping…");
              const r = await (await postAuthed(`/api/series/${stop}/stop`, {})).json();
              showReceipt("serMsg", Boolean(r.ok), r.ok ? r.note : `failed: ${r.error}`);
            } else if (tog) {
              const enabled = btn.dataset.snext === "1";
              const r = await (await postAuthed(`/api/series/${tog}`, { enabled })).json();
              showReceipt("serMsg", Boolean(r.ok),
                r.ok ? (enabled ? "resumed — the schedule is live again" : "paused — no further runs") : `failed: ${r.error}`);
            }
          } catch { showReceipt("serMsg", false, "request failed"); }
          finally { btn.disabled = false; loadSeries(); loadTasks(); }
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
        // The result usually replaces a spinner; a line that still claims
        // aria-busy after settling reads as loading forever.
        m.removeAttribute("aria-busy");
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
            showReceipt("backstopMsg", r.ok, r.ok ? label : `failed: ${r.error}`, r.txHash);
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
            /*
             * Say the size, in its own unit.
             *
             * "cover deposited" said nothing about how much, and a queued exit
             * is counted in *shares* — labelling that with the asset's symbol
             * would name a token that was never the unit being moved.
             */
            const said = `${label} — ${human} ${sharesNotAssets ? "share" + (human === "1" ? "" : "s") : a.symbol}`;
            // Self-custody signs its own; the pool asks no permission for this.
            if (selfMode()) {
              return selfCustody("backstopMsg", said, async (from, cfg) => {
                const sel2 = cfg.selectors;
                if (action === "deposit") {
                  await ensureAllowance(from, a.address, cfg.pool, raw);
                  return sendTx(from, cfg.pool, callData(sel2.backstopDeposit, encAddr(a.address), encUint(raw)));
                }
                return sendTx(from, cfg.pool, callData(sel2.backstopQueue, encAddr(a.address), encUint(raw)));
              }).then(() => loadBackstop());
            }
            post(`/api/lending/backstop/${action}`, `asset=${a.address}&amount=${raw}`, said);
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
        // The result usually replaces a spinner; a line that still claims
        // aria-busy after settling reads as loading forever.
        m.removeAttribute("aria-busy");
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
          showBusy("auctionMsg", `${label}…`);
          try {
            const r = await (await postJson(path, body)).json();
            showReceipt("auctionMsg", r.ok, r.ok ? label : `failed: ${r.error}`, r.txHash);
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
        if (key === "Lending") {
          loadPoolPrices(); loadBackstop(); loadAuction(); loadBorrowers(); loadEmissions();
          if (typeof loadLegacyEmissions === "function") loadLegacyEmissions().catch(() => {});
        }
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
      /* ---- What a liquidity deposit or withdrawal actually does -----------
       *
       * The form asked for a number per asset and told you nothing back. The
       * hint said "deposit every asset in proportion" and "withdrawing returns
       * a proportional slice", both true, and neither answers the question the
       * reader has: *how much*. What is the other side of this pair, how many
       * shares does it buy, and — the one that costs money — how much of what I
       * typed buys nothing at all.
       *
       * That last one is not hypothetical. `_addLiquidity` credits the
       * *smallest* ratio across the assets supplied:
       *
       *     shares = min_i(amounts[i] * totalShares / reserves[i])
       *
       * so anything above that ratio is added to the reserves and mints no
       * shares. It is a donation to every other provider, made silently, by
       * someone who typed two numbers that looked reasonable. The contract's own
       * comment says so; the page never did.
       *
       * These mirror the contract's arithmetic exactly, in the same integer
       * order, so a preview and the transaction cannot disagree.
       */

      /** The pool's minimum-liquidity burn, from TesseraAMM. */
      const AMM_MINIMUM_LIQUIDITY = 1000n;

      /** Reserve of each asset, in base units, in the pool's own order. */
      function lpReserves(pool) {
        return (pool.assets || []).map((a) => BigInt(a.raw ?? "0"));
      }

      /**
       * The matching amounts at the pool's current ratio.
       *
       * Given one asset's amount, what every other asset needs to be for the
       * deposit to be balanced — which is to say, for none of it to be donated.
       * Returns null when the pool has no ratio yet: the first deposit *sets*
       * the price, so there is nothing to match.
       */
      function lpPairFor(pool, index, rawAmount) {
        const res = lpReserves(pool);
        const from = res[index];
        if (!from || from <= 0n || res.some((r) => r <= 0n)) return null;
        const amt = BigInt(rawAmount || 0);
        if (amt <= 0n) return null;
        return res.map((r, i) => (i === index ? amt : (amt * r) / from));
      }

      /**
       * What this deposit buys, and what it gives away.
       *
       * `donated` is the part of each amount above the credited ratio: it goes
       * into the reserves and mints nothing.
       */
      function lpAddPreview(pool, typedRaws) {
        const res = lpReserves(pool);
        const total = BigInt(pool.totalShares || "0");
        const typed = typedRaws.map((v) => BigInt(v || 0));
        if (typed.some((v) => v <= 0n)) return null;

        if (total === 0n) {
          // First deposit: shares are the sum, less the burned minimum. There
          // is no ratio to be unbalanced against.
          const sum = typed.reduce((t, v) => t + v, 0n);
          if (sum <= AMM_MINIMUM_LIQUIDITY) return { first: true, shares: 0n, tooSmall: true, donated: typed.map(() => 0n), sharePct: 0 };
          return { first: true, shares: sum - AMM_MINIMUM_LIQUIDITY, tooSmall: false, donated: typed.map(() => 0n), sharePct: 100 };
        }
        if (res.some((r) => r <= 0n)) return null;

        let shares = null;
        for (let i = 0; i < typed.length; i++) {
          const minted = (typed[i] * total) / res[i];
          if (shares === null || minted < shares) shares = minted;
        }
        shares = shares ?? 0n;
        /*
         * What each asset contributed at the credited ratio; the rest is the
         * donation — above a dust bound that is derived, not guessed.
         *
         * Both `shares` and `credited` are floored, so a deposit matched exactly
         * to the pool's ratio still comes out a few base units "unbalanced". The
         * error is bounded: `shares` can be short by one, which costs
         * `res[i] / total` units of `credited`, plus one more for the second
         * floor. Anything at or below that is the arithmetic, not the deposit,
         * and reporting it would put "0.000006 USDC mints nothing" under a
         * perfectly balanced pair — which teaches the reader to ignore the one
         * warning on this panel that costs real money.
         */
        const credited = res.map((r) => (shares * r) / total);
        const dust = res.map((r) => r / total + 2n);
        const donated = typed.map((v, i) => {
          const over = v > credited[i] ? v - credited[i] : 0n;
          return over > dust[i] ? over : 0n;
        });
        const after = total + shares;
        return {
          first: false,
          shares,
          donated,
          balanced: donated.every((d) => d === 0n),
          sharePct: after > 0n ? (Number(shares) / Number(after)) * 100 : 0,
        };
      }

      /** What burning these shares pays out, per asset, in base units. */
      function lpRemovePreview(pool, sharesRaw) {
        const res = lpReserves(pool);
        const total = BigInt(pool.totalShares || "0");
        const shares = BigInt(sharesRaw || 0);
        if (shares <= 0n || total <= 0n) return null;
        // The contract divides by the total *before* the burn — see
        // `removeLiquidity`, which caches `total` and only then decrements.
        return { out: res.map((r) => (r * shares) / total), shares };
      }

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
        renderAmLpPreview();
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

      /**
       * The line that answers "how much am I actually moving?".
       *
       * Everything here is derived from figures already on the page — reserves,
       * total shares, the amounts typed — so it costs no RPC and cannot lag the
       * form. It renders under the inputs and updates as they change.
       */
      function renderAmLpPreview() {
        const box = $("amLpPreview");
        const raw = amSelected();
        if (!box || !raw) return;
        const p = amMine(raw);
        const hide = () => { box.style.display = "none"; box.innerHTML = ""; };
        const amt = (v, a) => `${esc(fmtUnitsStr(String(v), Number(a.decimals) || 6))} ${esc(a.symbol)}`;

        if ($("amLpAction").value === "remove") {
          const el = $("amLpShares");
          const want = el && el.value.trim();
          if (!want) return hide();
          let sharesRaw;
          try { sharesRaw = BigInt(want.replace(/[,\s]/g, "")); } catch { return hide(); }
          const pre = lpRemovePreview(p, sharesRaw);
          if (!pre) return hide();
          const held = BigInt(p.myShares || "0");
          const ofMine = held > 0n ? (Number(pre.shares) / Number(held)) * 100 : null;
          box.style.display = "block";
          box.innerHTML =
            `<div style="font-weight:600;margin-bottom:5px">You would receive</div>` +
            `<div>${p.assets.map((a, i) => `<b>${amt(pre.out[i], a)}</b>`).join(' <span style="opacity:.6">+</span> ')}</div>` +
            (ofMine === null ? "" :
              `<div style="color:var(--muted);margin-top:5px">Burning ${esc(String(pre.shares))} of your ` +
              `${esc(String(held))} shares — ${esc(ofMine.toFixed(ofMine < 0.01 ? 4 : 2))}% of your position.` +
              (pre.shares > held ? " <b style=\"color:var(--warn)\">That is more than you hold.</b>" : "") +
              `</div>`);
          return;
        }

        const boxes = [...document.querySelectorAll(".amLpAmt")];
        if (!boxes.length) return hide();
        const typed = boxes.map((b, i) => {
          const v = b.value.trim();
          if (!v) return null;
          const r = parseAmount(v, Number(p.assets[i]?.decimals ?? 6));
          return r.error ? null : BigInt(r.raw);
        });
        const filled = typed.filter((v) => v !== null && v > 0n).length;
        if (!filled) return hide();

        /*
         * One box filled is the common case, and the useful answer is the other
         * side of the pair rather than a share count for a deposit that is not
         * yet valid. Every box filled gets the full preview.
         */
        if (filled < boxes.length) {
          const idx = typed.findIndex((v) => v !== null && v > 0n);
          const pair = lpPairFor(p, idx, typed[idx]);
          box.style.display = "block";
          if (!pair) {
            box.innerHTML =
              `<div style="color:var(--muted)">This pool has no ratio yet — the first deposit sets it, ` +
              `so fill in every asset and the amounts you choose become the opening price.</div>`;
            return;
          }
          box.innerHTML =
            `<div style="font-weight:600;margin-bottom:5px">To stay in proportion, pair it with</div>` +
            `<div>${p.assets.map((a, i) => (i === idx ? "" : `<b>${amt(pair[i], a)}</b>`)).filter(Boolean).join(' <span style="opacity:.6">+</span> ')}</div>` +
            `<div style="color:var(--muted);margin-top:5px">Press <b>Pair</b> to fill these in.</div>`;
          return;
        }

        const pre = lpAddPreview(p, typed.map((v) => v ?? 0n));
        if (!pre) return hide();
        box.style.display = "block";
        if (pre.first) {
          box.innerHTML = pre.tooSmall
            ? `<div style="color:var(--warn)">Too small for a first deposit — the pool burns ` +
              `${esc(String(AMM_MINIMUM_LIQUIDITY))} units of the first shares, so this would mint none.</div>`
            : `<div style="font-weight:600;margin-bottom:5px">You would mint ${esc(String(pre.shares))} shares</div>` +
              `<div style="color:var(--muted)">This is the pool's first deposit, so these amounts set its ` +
              `opening ratio — and its price.</div>`;
          return;
        }
        const donatedRows = p.assets
          .map((a, i) => (pre.donated[i] > 0n ? `<b>${amt(pre.donated[i], a)}</b>` : null))
          .filter(Boolean);
        box.innerHTML =
          `<div style="font-weight:600;margin-bottom:5px">You would mint ${esc(String(pre.shares))} shares` +
          ` — ${esc(pre.sharePct.toFixed(pre.sharePct < 0.01 ? 4 : 2))}% of the pool</div>` +
          `<div>${p.assets.map((a, i) => `${amt(typed[i] ?? 0n, a)}`).join(' <span style="opacity:.6">+</span> ')}</div>` +
          (donatedRows.length
            ? `<div style="color:var(--warn);margin-top:6px">` +
              `${donatedRows.join(" and ")} of that mints nothing. Shares are credited at the smallest ratio ` +
              `you supply, so the excess is added to the reserves and shared with every other provider. ` +
              `Press <b>Pair</b> to match the pool instead.</div>`
            : `<div style="color:var(--good);margin-top:6px">In proportion — none of it is donated.</div>`);
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
        $("amLpAction").addEventListener("change", () => {
          renderAmLpInputs(); renderAmLpHint(); renderAmLpPreview();
        });
        /*
         * Delegated, because the inputs are rebuilt whenever the pool or the
         * action changes — a listener bound to the boxes themselves would be
         * thrown away with them and the preview would go quiet after the first
         * switch.
         */
        if ($("amLpInputs")) $("amLpInputs").addEventListener("input", () => renderAmLpPreview());
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
          showBusy("ammMsg", `swapping ${q.ai.symbol} → ${q.ao.symbol}…`);
          try {
            const r = await (
              await postJson("/api/amm/swap", {
                poolId: q.poolId, tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, minOut,
              })
            ).json();
            showReceipt("ammMsg", r.ok, r.ok ? "swapped" : `failed: ${r.error}`, r.txHash);
          } catch {
            msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = "request failed";
          } finally { btn.disabled = false; afterTx(); }
        });

        // "Max" fills the boxes: for a withdrawal, every share you hold; for a
        // deposit, the largest balanced deposit your wallet can actually cover.
        /*
         * Fill the rest of the pair at the pool's current ratio.
         *
         * The whole cost of an unbalanced deposit is the part that mints
         * nothing, and it is invisible at the moment somebody types. Max already
         * fills every box from the wallet; this fills them from *one* number the
         * reader has chosen, which is the other half of the same need — "I want
         * to put in 10 USDC, what does that pair with?"
         */
        if ($("amLpPair")) {
          $("amLpPair").addEventListener("click", () => {
            const raw = amSelected();
            if (!raw || $("amLpAction").value !== "add") return;
            const p = amMine(raw);
            const boxes = [...document.querySelectorAll(".amLpAmt")];
            const m = $("ammMsg");
            const say = (t) => { if (m) { m.style.display = "block"; m.style.color = "var(--warn)"; m.textContent = t; } };
            // Whichever box the reader filled in. The first one wins, so a
            // half-typed second value cannot silently drive the ratio.
            let idx = -1;
            let from = 0n;
            for (let i = 0; i < boxes.length; i++) {
              const v = boxes[i].value.trim();
              if (!v) continue;
              const r = parseAmount(v, Number(p.assets[i]?.decimals ?? 6));
              if (r.error) continue;
              if (BigInt(r.raw) > 0n) { idx = i; from = BigInt(r.raw); break; }
            }
            if (idx < 0) { say("Type an amount into one of the boxes first — Pair fills in the others."); return; }
            const pair = lpPairFor(p, idx, from);
            if (!pair) {
              say("This pool has no ratio yet — the first deposit sets it, so there is nothing to match.");
              return;
            }
            boxes.forEach((b, i) => {
              if (i === idx) return;
              b.value = fmtUnitsStr(String(pair[i]), Number(p.assets[i]?.decimals ?? 6)).replace(/,/g, "");
            });
            if (m) m.style.display = "none";
            renderAmLpPreview();
          });
        }

        $("amLpMax").addEventListener("click", async () => {
          const raw = amSelected();
          if (!raw) return;
          const p = amMine(raw);
          if ($("amLpAction").value === "remove") {
            const el = $("amLpShares");
            if (el) el.value = p.myShares;
            // Filling a value in code fires no `input` event, so the preview is
            // told by hand — otherwise Max leaves the panel describing the
            // amount that was there before it.
            renderAmLpPreview();
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
              : "Could not read the app wallet's balances yet — the lending panel supplies them, " +
                "so give it a moment and try again.");
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
            renderAmLpPreview();
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
          // Programmatic fills fire no `input` event; the preview is told.
          renderAmLpPreview();
        });

        /** The connected wallet's balance of each pool asset (self-custody only). */
        /**
         * Whose balances "Max" should fill from.
         *
         * This only ever read the browser wallet, so in an operator session it
         * returned null and the button answered "switch on Use my own wallet" —
         * advice that is wrong for that session. An operator's deposit spends
         * the **app wallet**, and `amLpExec` sends it server-side through
         * `/api/amm/add`; refusing to size it from that wallet's balances told
         * the operator to change modes in order to do the thing they were
         * already doing.
         *
         * The balances are already on the page: the lending snapshot carries
         * `position.wallet` per asset for the app wallet, and the AMM's assets
         * are the same four. An asset the snapshot has never heard of returns
         * null for the whole set rather than a zero, because a zero here silently
         * sizes a deposit at nothing.
         */
        function appWalletBalances(p) {
          const ln = window.__lending;
          if (!ln || !ln.assets) return null;
          const by = new Map(ln.assets.map((a) => [String(a.address).toLowerCase(), a]));
          const out = [];
          for (const a of p.assets) {
            const row = by.get(String(a.address).toLowerCase());
            const bal = row && row.position && row.position.wallet;
            if (bal == null) return null;
            out.push(String(bal));
          }
          return out;
        }

        async function amWalletBalances(p) {
          if (!selfMode()) return appWalletBalances(p);
          if (!eth()) return null;
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
          showBusy("ammMsg", adding ? "adding liquidity…" : "withdrawing liquidity…");
          try {
            const body = adding ? { poolId: p.id, amounts } : { poolId: p.id, shares };
            const r = await (await postJson(`/api/amm/${adding ? "add" : "remove"}`, body)).json();
            showReceipt("ammMsg", r.ok, r.ok ? `${adding ? "added" : "withdrew"} liquidity` : `failed: ${r.error}`, r.txHash);
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
        // Also parked on `window` so the task form can read the vault's token
        // without being async — it builds inputs synchronously.
        window.__defiCfg = defiCfg;
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
       *
       * Returns true only for a confirmed success. Callers that chain several
       * transactions — a bulk send, an approve-then-act — need to know whether
       * to carry on, and "it did not throw" is not that: a revert and a
       * rejected prompt both land in here without throwing to the caller.
       */
      async function selfCustody(msgEl, label, fn) {
        const msg = $(msgEl);
        const show = (text, colour, html) => {
          msg.style.display = "block";
          msg.style.color = colour;
          if (html) msg.innerHTML = text; else msg.textContent = text;
        };
        // The two waits worth showing: the wallet's, then the chain's. Both are
        // the same line the receipt lands on, so the state never moves around.
        const busy = (text, html) =>
          show(`<span class="spin" aria-hidden="true"></span>${text}`, "var(--muted)", true);
        busy(esc("Confirm in your wallet…"));
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
            return false;
          }
          busy(`${esc(label)} sent — waiting for the chain to confirm it…${link()}`);
          const receipt = await waitForTx(safeHash, 120000);
          if (!receipt) {
            // Still pending. Not a success and not a failure; say which.
            show(`${esc(label)} is still pending after two minutes. It may yet land — ` +
                 `check the explorer rather than sending it again.${link()}`, "var(--warn)", true);
            return false;
          }
          if (!receiptOkHex(receipt.status)) {
            show(`${esc(label)} <b>failed on chain</b> — it was mined but reverted, so nothing moved. ` +
                 `Your funds are untouched.${link()}`, "var(--warn)", true);
            return false;
          }
          show(`${esc(label)} confirmed ✓${link()}`, "var(--good)", true);
          return true;
        } catch (e) {
          show(walletError(e) + (safeHash ? ` (${safeHash.slice(0, 12)}…)` : ""), "var(--warn)");
          return false;
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
      /**
       * One receipt, everywhere, with the hash always clickable.
       *
       * Six panels each grew their own version of this line, and every one of
       * them wrote `textContent` with `hash.slice(0, 12)` — twelve characters of
       * a transaction and nothing to do with them. The information the user
       * actually wants after signing is "did it land", and that lives on the
       * explorer. A shared helper means the next panel gets it right without
       * anyone remembering to.
       *
       * `esc` on the label, `txLink` on the hash: the only markup that reaches
       * innerHTML is the anchor this function builds.
       */
      /**
       * "Working on it", on the line the answer will appear on.
       *
       * Every action here ended in a receipt and began with nothing: the button
       * greyed out and a line of text appeared, which on a still screen is
       * indistinguishable from a finished message that happens to end in an
       * ellipsis. The ring turns for as long as the transaction is in flight
       * and is replaced by `showReceipt` in the same element, so the status of
       * a transaction is always exactly one line in one place.
       */
      /**
       * The caller's share of a pot that cannot pay everybody, in the browser.
       *
       * The server caps its own claims this way — see `claim-share.ts` — but a
       * visitor in self-custody signs for themselves, so the server never sees
       * the call and the cap has to exist here too. Without it the fairness rule
       * held only for the app wallet, which is the address that needed it least:
       * a holder with 641,528 TSRA accrued against a pot of 15,140 takes all of
       * it in one transaction, the pot guard pauses the emission for being
       * empty, and nobody else is ever paid. That is the loop this closes.
       *
       * Honest about its limits: `claim` takes no amount, so the cap is applied
       * by choosing which streams to hand it, and anyone calling the contract
       * directly is still first come, first served until `claim` itself pays
       * pro-rata. Exposed on `window` so the rule can be checked from outside.
       */
      function shareOfPot(yourOwedRaw, totalOwedRaw, potRaw) {
        const yours = BigInt(yourOwedRaw || "0");
        const total = BigInt(totalOwedRaw || "0");
        const pot = BigInt(potRaw || "0");
        if (yours <= 0n || pot <= 0n) return 0n;
        if (total <= pot) return yours < pot ? yours : pot;
        const share = (pot * yours) / total;
        return share < yours ? share : yours;
      }

      /**
       * Largest first, then one more stream if the cap still has room.
       *
       * The twin of `planClaim` in agent/src/claim-share.ts — see there for
       * why the plan is allowed to overshoot by exactly one stream. The short
       * version: stopping at the last stream that fits meant a holder whose
       * rewards sit in one large stream claimed a rounding error, or nothing
       * at all, and `claim` already pays no more than the pot holds.
       */
      function pickStreams(streams, cap) {
        const owed = streams.reduce((t, s) => t + s.owed, 0n);
        if (owed <= 0n || cap <= 0n) return [];
        if (cap >= owed) return streams;
        const sorted = [...streams].sort((a, b) => (a.owed < b.owed ? 1 : a.owed > b.owed ? -1 : 0));
        const take = [];
        let amount = 0n;
        for (const st of sorted) {
          if (amount + st.owed <= cap) { take.push(st); amount += st.owed; }
        }
        if (amount < cap) {
          const rest = sorted.filter((st) => !take.includes(st));
          const smallest = rest[rest.length - 1];
          if (smallest) take.push(smallest);
        }
        return take;
      }
      window.shareOfPot = shareOfPot;
      window.pickStreams = pickStreams;

      /**
       * Why the guard stopped this emission, from the numbers on the page.
       *
       * "The reward pot ran out" was hard-coded here, and it was wrong in the
       * case that actually happens: the guard trips on `held - owed`, so a pot
       * holding 46,925 TSRA against 200,000 already owed is paused with a very
       * visible balance sitting in it. Telling somebody the pot is empty while
       * the same card prints its balance destroys the card's credibility, so
       * this says which of the two it is.
       */
      function guardWhy(r) {
        const rw = (r && r.reward) || {};
        const held = BigInt(rw.balanceRaw || "0");
        const owed = BigInt(rw.owedRaw || "0");
        if (held === 0n) return "the reward pot is empty.";
        if (owed >= held) {
          return `the pot holds ${rw.balance} ${rw.symbol} but ${rw.owed} is already owed to claimants, ` +
            "so there is nothing spare to keep emitting.";
        }
        return "the pot no longer covers the current rates for long enough.";
      }

      function showBusy(id, label) {
        const el = $(id);
        if (!el) return;
        el.style.display = "block";
        el.style.color = "var(--muted)";
        el.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label)}`;
        el.setAttribute("aria-busy", "true");
      }

      function showReceipt(id, ok, label, txHash) {
        const busy = $(id);
        if (busy) busy.removeAttribute("aria-busy");
        const el = $(id);
        if (!el) return;
        el.style.display = "block";
        el.style.color = ok ? "var(--good)" : "var(--warn)";
        // Not everything that succeeds is a transaction. Saving a task, copying
        // an address and changing a setting all land here, and offering "view
        // on Arcscan:" followed by nothing reads as a link that failed to load.
        if (ok) {
          el.innerHTML = /^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))
            ? `${esc(label)} ✓ — view on Arcscan: ${txLink(txHash)}`
            : `${esc(label)} ✓`;
        } else el.textContent = label;
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
        // The result usually replaces a spinner; a line that still claims
        // aria-busy after settling reads as loading forever.
        m.removeAttribute("aria-busy");
      }

      const relTime = (secs) => {
        const d = secs - Math.floor(Date.now() / 1000);
        const a = Math.abs(d), unit = a < 3600 ? [60, "min"] : a < 86400 ? [3600, "hour"] : [86400, "day"];
        const n = Math.round(a / unit[0]);
        return `${d >= 0 ? "in " : ""}${n} ${unit[1]}${n === 1 ? "" : "s"}${d < 0 ? " ago" : ""}`;
      };

      /** @param {boolean} [fresh] Skip the server's short read cache — see loadGauge. */
      async function loadGovernance(fresh) {
        const host = $("govProposals");
        if (!host) return;
        try {
          const who = String(window.__myAddress || "");
          const parts = [];
          if (/^0x[0-9a-fA-F]{40}$/.test(who)) parts.push(`user=${encodeURIComponent(who)}`);
          if (fresh) parts.push("fresh=1");
          const q = parts.length ? `?${parts.join("&")}` : "";
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
          const emOperator = Boolean(r.canPropose && adminId);
          $("govEmissionsCard").style.display = emOperator ? "" : "none";
          /*
           * The Emissions tab holds exactly one card, and that card is operator
           * only — so for everybody else the tab opened onto nothing at all. Not
           * a slow pane, not a failed fetch: a permanently empty room with a
           * button in the navigation inviting people into it. The smoke test
           * called it (0 characters after 10s) and it was right.
           *
           * A tab nobody but the operator can ever see content in does not
           * belong in a public tab bar, so it is hidden rather than filled with
           * an apology. If the tab was the one open when the page loaded — the
           * choice is remembered across sessions — the view falls back to the
           * overview instead of leaving the reader staring at a blank pane with
           * no tab highlighted.
           */
          const emTab = document.querySelector('[data-govtab="emissions"]');
          if (emTab) {
            emTab.style.display = emOperator ? "" : "none";
            if (!emOperator && govTab === "emissions") setGovTab("overview");
          }

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

      /* ---- The wallet's assets ----------------------------------------------
       *
       * Five at a time, sliced server-side. The browser could fetch every
       * balance and cut locally, and for four assets that is the same thing —
       * the reason not to is that one `balanceOf` per asset per poll from every
       * open tab is a load that grows with the product and lands on a throttled
       * public RPC. The totals still count everything, because a summary of
       * only the visible page would be wrong in a way nobody would catch.
       */
      const ASSET_PAGE = 5;
      let assetSize = ASSET_PAGE;
      let assetPage = 1;
      let assetPaged = false;

      async function loadMyAssets() {
        const host = $("myAssetRows");
        if (!host) return;
        const who = String(window.__myAddress || "");
        if (!/^0x[0-9a-fA-F]{40}$/.test(who)) { host.innerHTML = ""; return; }
        try {
          const size = assetPaged ? ASSET_PAGE : assetSize;
          const r = await (await fetch(
            `/api/wallet/assets?user=${encodeURIComponent(who)}&page=${assetPage}&size=${size}`)).json();
          if (!r || !r.ok) { host.innerHTML = ""; return; }

          host.innerHTML = (r.assets || []).length
            ? r.assets.map((a) =>
                `<tr><td>${a.isProtocolToken ? '<span class="tsraIcon"></span> ' : ""}<b>${esc(a.symbol)}</b>` +
                `<div class="muted" style="font-size:10.5px">${a.priceUsd > 0 ? "$" + esc(a.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 4 })) : "no mark"}</div></td>` +
                `<td class="num mono">${esc(a.balance)}</td>` +
                `<td class="num mono">${a.valueUsd == null ? "—" : "$" + esc(a.valueUsd.toFixed(2))}</td></tr>`).join("")
            : emptyRow(3, "Nothing held in the assets this deployment knows about.");

          const pager = $("myAssetPager");
          if (pager) {
            pager.style.display = r.total > ASSET_PAGE ? "" : "none";
            $("myAssetMore").style.display = assetPaged || assetSize >= r.total ? "none" : "";
            $("myAssetAll").style.display = assetPaged ? "none" : "";
            $("myAssetPrev").style.display = assetPaged ? "" : "none";
            $("myAssetNext").style.display = assetPaged ? "" : "none";
            $("myAssetPrev").disabled = r.page <= 1;
            $("myAssetNext").disabled = r.page >= r.pages;
            $("myAssetPage").textContent = assetPaged
              ? `page ${r.page} of ${r.pages}`
              : `${(r.assets || []).length} of ${r.total}`;
          }
          $("myAssetNote").textContent =
            `${r.heldCount} of ${r.total} assets held · about $${r.totalUsd.toFixed(2)} in total` +
            // Never present a partial total as the whole picture.
            (r.unpriced && r.unpriced.length
              ? ` (${r.unpriced.join(", ")} ${r.unpriced.length === 1 ? "has" : "have"} no mark, so ${r.unpriced.length === 1 ? "it is" : "they are"} not counted)`
              : "");
        } catch {
          host.innerHTML = "";
        }
      }

      if ($("myAssetMore")) {
        $("myAssetMore").addEventListener("click", () => { assetSize += ASSET_PAGE; loadMyAssets(); });
      }
      if ($("myAssetAll")) {
        $("myAssetAll").addEventListener("click", () => { assetPaged = true; assetPage = 1; loadMyAssets(); });
      }
      if ($("myAssetPrev")) {
        $("myAssetPrev").addEventListener("click", () => { if (assetPage > 1) { assetPage--; loadMyAssets(); } });
      }
      if ($("myAssetNext")) {
        $("myAssetNext").addEventListener("click", () => { assetPage++; loadMyAssets(); });
      }
      setInterval(() => { if (typeof loadMyAssets === "function") loadMyAssets().catch(() => {}); }, 30000);

      /* ---- The NFT launchpad ------------------------------------------------
       *
       * Two audiences on one panel. Anybody can submit a drop and watch for a
       * verdict; an operator additionally sees Approve and Reject on everything
       * still pending. Which one you are is decided by the server — `admin` is
       * the launchpad's on-chain owner — rather than by hiding buttons that
       * would fail anyway.
       */
      let nftState = null;
      /** One figure in the metrics strip, the same shape every other panel uses. */
      const nftMetric = (k, v) =>
        `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;

      window.loadNft = async function loadNft() {
        const card = $("nftCard");
        if (!card) return;
        const notReady = $("nftNotReady");
        try {
          const r = await (await fetch("/api/nft")).json();
          nftState = r;
          if (!r || !r.ok || !r.deployed) {
            if (notReady) {
              notReady.style.display = "block";
              notReady.textContent = (r && r.error) ||
                "The NFT launchpad is not deployed on this network yet.";
            }
            $("nftRows").innerHTML = emptyRow(6, "Nothing to show until the launchpad is deployed.");
            $("nftMeta").innerHTML = "";
            return;
          }
          if (notReady) notReady.style.display = "none";
          const pct = (Number(r.feeBps) / 100).toFixed(2);
          $("nftMeta").innerHTML =
            nftMetric("Drops", String(r.total)) +
            nftMetric("Protocol fee", pct + "%") +
            nftMetric("Contract", short(r.address)) +
            nftMetric("Admin", short(r.admin));
          renderNftRows();
        } catch {
          if (notReady) {
            notReady.style.display = "block";
            notReady.textContent = "Could not read the launchpad just now — retrying on the next visit.";
          }
        }
      };

      /** Am I the launchpad's admin in this session? */
      function nftIsAdmin() {
        if (!nftState || !nftState.admin) return false;
        // An operator session acts as the app wallet; a connected wallet acts as
        // itself. Either can be the owner, and neither is assumed to be.
        const me = String(window.__myAddress || "").toLowerCase();
        return Boolean(me) && me === String(nftState.admin).toLowerCase();
      }

      function renderNftRows() {
        const body = $("nftRows");
        if (!body || !nftState || !nftState.drops) return;
        const want = ($("nftFilter") && $("nftFilter").value) || "all";
        const rows = nftState.drops.filter((d) => want === "all" || d.status === want);
        const admin = nftIsAdmin();
        body.innerHTML = rows.length
          ? rows.map((d) => {
              const tone = d.status === "approved" ? "ok" : d.status === "rejected" ? "warn" : "";
              const label = d.status === "pending" ? "waiting for review" : d.status;
              const actions = [];
              if (d.mintable) {
                actions.push(
                  `<button class="btn" data-nft="mint" data-id="${d.id}" data-price="${esc(d.price)}">Mint</button>`,
                );
              }
              if (admin && d.status === "pending") {
                actions.push(`<button class="btn" data-nft="approve" data-id="${d.id}">Approve</button>`);
                actions.push(`<button class="btn" data-nft="reject" data-id="${d.id}">Reject</button>`);
              }
              if (admin && d.status === "approved") {
                actions.push(
                  `<button class="btn" data-nft="pause" data-id="${d.id}" data-paused="${d.paused ? "0" : "1"}">` +
                    `${d.paused ? "Unpause" : "Pause"}</button>`,
                );
              }
              return (
                `<tr><td><b>${esc(d.name)}</b>` +
                `<div style="font-size:11px;color:var(--muted)">#${d.id} · ${esc(d.uri)}</div>` +
                (d.status === "rejected" && d.reason
                  ? `<div style="font-size:11px;color:var(--warn)">${esc(d.reason)}</div>` : "") +
                (!d.mintable && d.status === "approved"
                  ? `<div style="font-size:11px;color:var(--muted)">${esc(d.why)}</div>` : "") +
                `</td>` +
                `<td class="mono" style="font-size:11px">${esc(short(d.creator))}</td>` +
                `<td class="num mono">${esc(d.price)} USDC</td>` +
                `<td class="num mono">${d.minted} / ${d.supply}</td>` +
                `<td><span class="tag ${tone}">${esc(label)}</span></td>` +
                `<td class="num">${actions.join(" ")}</td></tr>`
              );
            }).join("")
          : emptyRow(6, want === "all" ? "No drops submitted yet." : `No ${want} drops.`);
      }

      if ($("nftFilter")) $("nftFilter").addEventListener("change", renderNftRows);
      if ($("nftRefresh")) $("nftRefresh").addEventListener("click", () => loadNft().catch(() => {}));

      /* ---- Artwork: upload it, or bring your own URI -----------------------
       *
       * A launchpad that only takes a URI asks every creator to have solved
       * hosting before they arrive. Both paths end at the same field, because
       * the contract only ever sees a URI — uploading just fills it in.
       *
       * Single and collection are the same drop with a different supply. The
       * mode exists because "supply" is not the word anybody reaches for when
       * they mean "one of one", and because a collection wants many images
       * where a single wants one.
       */
      function nftIsCollection() {
        return $("nftKind") && $("nftKind").value === "collection";
      }

      function renderNftKind() {
        const many = nftIsCollection();
        const files = $("nftFiles");
        if (files) files.multiple = many;
        const supply = $("nftSupply");
        if (supply) {
          supply.disabled = !many;
          // A single NFT is one of one — the field says so rather than being a
          // number somebody has to know to type.
          if (!many) supply.value = "1";
          else if (supply.value === "1") supply.value = "";
          supply.placeholder = many ? "Editions" : "1";
        }
        const plural = $("nftFilesPlural");
        if (plural) plural.textContent = many ? "s" : "";
        const note = $("nftKindNote");
        if (note) {
          note.textContent = many
            ? "One drop, many editions. Upload one image per edition — item 7 of the drop gets image 7 — or one image for all of them."
            : "A single token. One image, supply of one.";
        }
        const uri = $("nftUri");
        if (uri) uri.placeholder = many
          ? "…or a metadata base URI you already host"
          : "…or a metadata URI you already host";
        nftPicked = [];
        if ($("nftFilesPicked")) $("nftFilesPicked").textContent = "";
        if ($("nftUpload")) $("nftUpload").disabled = true;
        if ($("nftPreview")) { $("nftPreview").style.display = "none"; $("nftPreview").innerHTML = ""; }
      }

      let nftPicked = [];
      if ($("nftKind")) { $("nftKind").addEventListener("change", renderNftKind); renderNftKind(); }

      if ($("nftFiles")) {
        $("nftFiles").addEventListener("change", async () => {
          const list = [...($("nftFiles").files || [])];
          const msg = $("nftSubmitMsg");
          const say = (t) => { msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = t; };
          nftPicked = [];
          // 4 MB each is the server's cap; saying so here beats a rejected
          // upload after the file has been read and sent.
          const tooBig = list.find((f) => f.size > 4 * 1024 * 1024);
          if (tooBig) { say(`${tooBig.name} is ${(tooBig.size / 1e6).toFixed(1)} MB — the cap is 4 MB per image.`); return; }
          if (list.length > 200) { say("A collection tops out at 200 images."); return; }
          for (const f of list) {
            const dataUrl = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result));
              r.onerror = () => reject(r.error);
              r.readAsDataURL(f);
            }).catch(() => null);
            if (dataUrl) nftPicked.push({ name: f.name, dataUrl });
          }
          $("nftFilesPicked").textContent = nftPicked.length
            ? `${nftPicked.length} image${nftPicked.length === 1 ? "" : "s"} ready`
            : "";
          $("nftUpload").disabled = !nftPicked.length;
          const prev = $("nftPreview");
          if (prev) {
            prev.style.display = nftPicked.length ? "flex" : "none";
            prev.innerHTML = nftPicked.slice(0, 12).map((p) =>
              `<img src="${esc(p.dataUrl)}" alt="" style="width:54px;height:54px;object-fit:cover;border-radius:8px;border:1px solid var(--line)" />`,
            ).join("") + (nftPicked.length > 12 ? `<span style="font-size:11.5px;color:var(--muted);align-self:center">+${nftPicked.length - 12} more</span>` : "");
          }
          if (msg) msg.style.display = "none";
        });
      }

      if ($("nftUpload")) {
        $("nftUpload").addEventListener("click", async () => {
          const msg = $("nftSubmitMsg");
          const say = (t, good) => {
            msg.style.display = "block";
            msg.style.color = good ? "var(--good)" : "var(--warn)";
            msg.textContent = t;
          };
          if (!nftPicked.length) return say("Choose an image first.");
          $("nftUpload").disabled = true;
          say("Uploading…", true);
          try {
            const r = await (await postJson("/api/nft/media", {
              name: $("nftName").value.trim(),
              items: nftPicked.map((p) => ({ dataUrl: p.dataUrl })),
            })).json();
            if (r.ok) {
              $("nftUri").value = r.base;
              // Supply follows the upload for a collection: one image per
              // edition is the common case and typing the count again is a
              // chance to get it wrong.
              if (nftIsCollection() && !$("nftSupply").value.trim()) $("nftSupply").value = String(r.count);
              say(`Hosted ${r.count} image${r.count === 1 ? "" : "s"} — the URI is filled in below.`, true);
            } else say(r.error || "Upload failed.");
          } catch {
            say("The upload request failed.");
          }
          $("nftUpload").disabled = false;
        });
      }

      if ($("nftSubmit")) {
        $("nftSubmit").addEventListener("click", async () => {
          const m = $("nftSubmitMsg");
          const say = (t, good) => {
            m.style.display = "block";
            m.style.color = good ? "var(--good)" : "var(--warn)";
            m.innerHTML = t;
          };
          const body = {
            name: $("nftName").value.trim(),
            uri: $("nftUri").value.trim(),
            price: $("nftPrice").value.trim() || "0",
            supply: Number($("nftSupply").value.trim()),
          };
          if (!body.name) return say("A drop needs a name.");
          if (!body.uri) return say("Upload an image, or paste a metadata URI you already host.");
          if (!Number.isFinite(body.supply) || body.supply < 1) {
            return say(nftIsCollection()
              ? "How many editions? Enter a whole number of at least 1."
              : "Supply must be a whole number of at least 1.");
          }
          if (!nftIsCollection() && body.supply !== 1) return say("A single NFT has a supply of 1.");
          $("nftSubmit").disabled = true;
          try {
            const r = await (await postJson("/api/nft/submit", body)).json();
            if (r.ok) {
              say(`Submitted — an admin decides next. ${txLink(r.txHash)}`, true);
              $("nftName").value = ""; $("nftUri").value = "";
              $("nftPrice").value = "";
              renderNftKind();
              loadNft().catch(() => {});
            } else say(esc(r.error || "Submission failed."));
          } catch {
            say("Submission request failed.");
          }
          $("nftSubmit").disabled = false;
        });
      }

      if ($("nftRows")) {
        // Delegated: the rows are rebuilt on every load and filter change, so a
        // listener bound to a button would be thrown away with it.
        $("nftRows").addEventListener("click", async (ev) => {
          const btn = ev.target.closest("[data-nft]");
          if (!btn) return;
          const what = btn.dataset.nft;
          const id = Number(btn.dataset.id);
          const m = $("nftMsg");
          const say = (t, good) => {
            m.style.display = "block";
            m.style.color = good ? "var(--good)" : "var(--warn)";
            m.innerHTML = t;
          };
          let url = "/api/nft/decide";
          let body = { id, verdict: what };
          if (what === "reject") {
            const reason = prompt("Why is this drop rejected? The submitter sees this.", "");
            if (reason === null) return;
            body.reason = reason;
          } else if (what === "mint") {
            /*
             * The price the row was showing, not one re-read at send time.
             * That is the whole point: the contract refuses anything above the
             * figure the buyer agreed to, and re-reading here would agree to
             * whatever the creator had set a moment ago.
             */
            url = "/api/nft/mint";
            body = { id, maxPrice: btn.dataset.price };
            if (!confirm(`Mint drop #${id} for ${btn.dataset.price} USDC?`)) return;
          } else if (what === "pause") {
            url = "/api/nft/pause";
            body = { id, paused: btn.dataset.paused === "1" };
          }
          btn.disabled = true;
          try {
            const r = await (await postJson(url, body)).json();
            if (r.ok) say(`Done. ${txLink(r.txHash)}`, true);
            else say(esc(r.error || "That did not go through."));
          } catch {
            say("The request failed.");
          }
          btn.disabled = false;
          loadNft().catch(() => {});
        });
      }

      /* ---- Governance sub-tabs ---------------------------------------------
       *
       * Six jobs that were eleven cards in one column: reading a result,
       * casting a market vote, choosing a delegate, setting a rate, deciding
       * what is listed. Only the visible one loads, which also stops the tab
       * from firing six loops of contract reads on arrival.
       */
      /* ---- What is waiting for you -------------------------------------------
       *
       * Every one of these was already somewhere on the site. The question
       * nobody could answer was "is there anything", because answering it meant
       * knowing which four panels to open — so it went unasked and rewards sat.
       *
       * The card hides itself entirely when there is nothing, because a
       * permanent empty box is a box people stop reading, and this needs to
       * still be noticed on the day it says something urgent.
       */
      /*
       * "Nothing is waiting" and "we could not find out" are different answers.
       *
       * The server goes to some trouble to tell them apart — every read is
       * counted, every failure is named, and the response carries `partial`
       * and `unreadable` precisely so this card can say which one it is. This
       * function used to throw all of that away: any response without items hid
       * the card, so a throttled RPC (the live node refuses roughly a quarter of
       * calls under load) made the whole "Waiting for you" panel vanish, TSRA
       * rewards and a matured backstop exit with it. The reader's conclusion was
       * that the claim feature had been removed.
       *
       * Now a partial read keeps the card up and says so, and a card that has
       * already shown something stays up rather than blinking out on the next
       * throttled poll — the same rule the emissions and AMM cards follow.
       */
      function claimNotice(text, warn) {
        const el = document.createElement("div");
        el.style.cssText =
          "font-size:11.5px;margin-top:2px;color:" + (warn ? "var(--warn,#c47)" : "var(--muted)");
        el.textContent = text;
        return el;
      }
      async function loadClaimables() {
        const card = $("claimCard"), list = $("claimList");
        if (!card || !list) return;
        const show = () => { card.style.display = ""; card.dataset.everShown = "1"; };
        // Hide only a card that has never had anything to say. Once it has, a
        // failed poll leaves the last good answer on screen.
        const hide = () => { if (!card.dataset.everShown) card.style.display = "none"; };
        const who = String(window.__myAddress || "");
        if (!/^0x[0-9a-fA-F]{40}$/.test(who)) { card.style.display = "none"; return; }
        try {
          const r = await (await fetch("/api/claimables?user=" + encodeURIComponent(who))).json();
          if (!r || !r.ok) { hide(); return; }
          const items = r.items || [];
          if (!items.length && !r.partial) { hide(); return; }
          if (!items.length) {
            // Nothing readable came back, and the server says so. Saying "all
            // clear" here is how a matured backstop exit goes on taking first
            // loss while the page reassures its owner.
            show();
            list.innerHTML = "";
            list.appendChild(claimNotice(
              "Couldn't check what's waiting for you — the Arc RPC refused " +
              (r.unreadable && r.unreadable.length ? r.unreadable.length + " of the reads" : "some reads") +
              ". This is not an all-clear. Press Refresh in a moment.", true));
            return;
          }
          show();
          list.innerHTML = "";
          for (const it of r.items) {
            const row = document.createElement("div");
            row.className = "kv";
            row.style.cssText =
              "display:flex;justify-content:space-between;gap:12px;align-items:center;" +
              "border:1px solid var(--line);border-radius:8px;padding:9px 11px" +
              (it.urgent ? ";border-color:var(--warn,#c47)" : "");
            const left = document.createElement("div");
            left.innerHTML =
              "<b>" + esc(it.label) + "</b>" +
              (it.note ? '<div style="font-size:11.5px;color:var(--muted);margin-top:3px">' + esc(it.note) + "</div>" : "");
            const right = document.createElement("div");
            right.style.cssText = "text-align:right;white-space:nowrap";
            right.innerHTML =
              "<div><b>" + esc(it.amount) + "</b> " + esc(it.symbol) + "</div>";
            const go = document.createElement("button");
            go.className = "btn ghost";
            go.style.marginTop = "4px";
            go.textContent = "Go";
            go.addEventListener("click", () => navigate(it.route));
            right.appendChild(go);
            row.appendChild(left);
            row.appendChild(right);
            list.appendChild(row);
          }
          if (r.partial) {
            list.appendChild(claimNotice(
              "Some checks didn't answer, so there may be more than this. Press Refresh in a moment.", true));
          }
        } catch {
          hide();
        }
      }
      // Bound directly rather than through the builder's helper, which is
      // declared further down and would still be in its temporal dead zone here.
      if ($("claimRefresh")) $("claimRefresh").addEventListener("click", () => loadClaimables());

      /* ---- The proposal builder --------------------------------------------
       *
       * A proposal that changes something needs calldata, and calldata written
       * by hand is calldata nobody writes — so governance here has always been
       * able to configure the protocol and never has. This turns the surfaces
       * the server is willing to expose into a form, and asks the server to
       * encode each call from the contract's own ABI. The operator sees the
       * target, the summary and the hex before anything opens; a vote is not
       * the moment to find out what was asked.
       */
      let gbActions = [];
      let gbCalls = [];
      /** Bind only if the element is there — these live in an operator-only card. */
      const gbOn = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); };

      async function loadProposalBuilder() {
        const card = $("govBuilderCard");
        if (!card) return;
        // Only an operator can open a proposal, so only an operator is shown
        // the form — rather than being offered it and refused at the end.
        const isOp = !!(profileState && profileState.isOperator);
        card.style.display = isOp ? "" : "none";
        if (!isOp || gbActions.length) return;
        try {
          const j = await (await fetch("/api/governance/actions", { headers: authHeaders() })).json();
          gbActions = (j.actions || []).filter((a) => a.available);
          const sel = $("gbAction");
          if (!sel) return;
          sel.innerHTML = "";
          let group = null, og = null;
          for (const a of gbActions) {
            if (a.group !== group) {
              group = a.group;
              og = document.createElement("optgroup");
              og.label = group;
              sel.appendChild(og);
            }
            const o = document.createElement("option");
            o.value = a.id;
            o.textContent = a.label;
            og.appendChild(o);
          }
          renderBuilderParams();
        } catch { /* the card simply stays empty rather than half-built */ }
      }

      function renderBuilderParams() {
        const sel = $("gbAction"), box = $("gbParams");
        if (!sel || !box) return;
        const spec = gbActions.find((a) => a.id === sel.value);
        box.innerHTML = "";
        if (!spec) return;
        for (const p of spec.params) {
          const lab = document.createElement("label");
          lab.textContent = p.label;
          const input = p.type === "bool" ? document.createElement("select") : document.createElement("input");
          input.className = "field";
          input.dataset.param = p.name;
          if (p.type === "bool") {
            for (const v of ["false", "true"]) {
              const o = document.createElement("option");
              o.value = v; o.textContent = v;
              input.appendChild(o);
            }
          } else if (p.hint) {
            input.placeholder = p.hint;
          }
          lab.appendChild(input);
          if (p.hint && p.type !== "bool") {
            const h = document.createElement("div");
            h.className = "kv";
            h.style.fontSize = "11.5px";
            h.textContent = p.hint;
            lab.appendChild(h);
          }
          box.appendChild(lab);
        }
      }

      function renderBuilderCalls() {
        const box = $("gbCalls");
        if (!box) return;
        box.innerHTML = "";
        gbCalls.forEach((c, i) => {
          const row = document.createElement("div");
          row.className = "kv";
          row.style.cssText = "border:1px solid var(--line);border-radius:8px;padding:8px 10px";
          const head = document.createElement("div");
          head.innerHTML = "<b>" + (i + 1) + ". " + esc(c.summary) + "</b>";
          const meta = document.createElement("div");
          meta.style.cssText = "font-size:11.5px;color:var(--muted);margin-top:4px;word-break:break-all";
          meta.textContent = c.contract + "." + c.fn + " → " + c.target + "\n" + c.calldata;
          meta.style.whiteSpace = "pre-wrap";
          row.appendChild(head);
          row.appendChild(meta);
          box.appendChild(row);
        });
      }

      gbOn($("gbAction"), "change", renderBuilderParams);
      gbOn($("gbClear"), "click", () => { gbCalls = []; renderBuilderCalls(); });
      gbOn($("gbAdd"), "click", async () => {
        const sel = $("gbAction"), msg = $("gbMsg");
        if (!sel) return;
        const params = {};
        document.querySelectorAll("#gbParams [data-param]").forEach((el) => { params[el.dataset.param] = el.value; });
        try {
          if (msg) msg.className = "msg";
          showBusy("gbMsg", "Encoding the call…");
          const res = await postAuthed("/api/governance/encode-action", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: sel.value, params }),
          });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || "could not encode that");
          if (gbCalls.length >= 8) throw new Error("a proposal carries at most 8 calls");
          gbCalls.push(j);
          renderBuilderCalls();
          if (msg) { msg.style.display = "none"; }
        } catch (e) {
          if (msg) { msg.style.display = "block"; msg.className = "msg err"; msg.textContent = String(e.message || e); }
        }
      });
      gbOn($("gbSubmit"), "click", async () => {
        const msg = $("gbMsg");
        const title = ($("gbTitle") || {}).value || "";
        const body = ($("gbBody") || {}).value || "";
        try {
          if (!title.trim()) throw new Error("a proposal needs a title");
          // The calls are named in the body too, so what was voted on is
          // legible from the proposal itself and not only from its calldata.
          const enacts = gbCalls.length
            ? "\n\nIf this passes:\n" + gbCalls.map((c, i) => (i + 1) + ". " + c.summary).join("\n")
            : "";
          if (msg) msg.className = "msg";
          showBusy("gbMsg", "Opening the proposal…");
          const res = await postAuthed("/api/governance/propose", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              description: body.trim() + enacts,
              targets: gbCalls.map((c) => c.target),
              calldatas: gbCalls.map((c) => c.calldata),
            }),
          });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || "could not open it");
          gbCalls = [];
          renderBuilderCalls();
          if ($("gbTitle")) $("gbTitle").value = "";
          if ($("gbBody")) $("gbBody").value = "";
          if (msg) { msg.style.display = "block"; msg.className = "msg ok"; msg.textContent = "Proposal opened."; }
          loadGovernance(true);
        } catch (e) {
          if (msg) { msg.style.display = "block"; msg.className = "msg err"; msg.textContent = String(e.message || e); }
        }
      });

      const GOV_LOADERS = {
        overview: () => loadGovernance(),
        proposals: () => Promise.all([loadGovernance(), loadDiscussions(), loadProposalBuilder()]),
        markets: () => Promise.all([loadGauge(), loadRegistry()]),
        delegates: () => Promise.all([loadGovernance(), loadGauge()]),
        emissions: () => Promise.all([loadEmissions(), loadLpEmissions(), loadGovernance()]),
        registry: () => loadRegistry(),
      };
      let govTab = "overview";

      function setGovTab(tab) {
        govTab = tab;
        for (const key of Object.keys(GOV_LOADERS)) {
          const pane = $("gov_" + key);
          if (pane) pane.hidden = key !== tab;
        }
        document.querySelectorAll("[data-govtab]").forEach((b) =>
          b.classList.toggle("active", b.dataset.govtab === tab));
        const load = GOV_LOADERS[tab];
        if (load) withPaneBusy("gov_" + tab, load, "Reading governance from the chain…").catch(() => {});
      }
      document.querySelectorAll("[data-govtab]").forEach((b) =>
        b.addEventListener("click", () => setGovTab(b.dataset.govtab)));

      /* ---- Which build is serving this page --------------------------------
       *
       * Two versions, deliberately, because they fail apart. The server's is
       * what the container is running; the browser's is what the service worker
       * has cached. A stale server needs a redeploy; a stale browser needs a
       * hard refresh. Showing one number could not tell those apart, and they
       * are the two ways an update "does not take".
       */
      async function loadBuild() {
        const pill = $("buildPill");
        if (!pill) return;
        try {
          const r = await (await fetch("/api/version", { cache: "no-store" })).json();
          if (!r || !r.ok) return;
          const mine = (typeof CLIENT_SHELL === "string" && CLIENT_SHELL) || null;
          const stale = mine && mine !== r.shell;
          pill.textContent = `build: ${r.shell}·${r.digest}` + (stale ? ` (page: ${mine})` : "");
          pill.title = stale
            ? `The server is serving ${r.shell} but this page came from ${mine}. Pull to refresh, or ` +
              `close every tab of the site and reopen it.`
            : `Server build ${r.shell}, front end ${r.digest}, up since ${new Date(r.startedAt).toLocaleString()}.`;
          pill.className = stale ? "pill warn" : "pill";
        } catch { /* the pill just stays as it was */ }
      }
      // The shell this page was served with, so a cached browser can notice it
      // is behind the server rather than silently disagreeing with it.
      const CLIENT_SHELL = (() => {
        try {
          return document.querySelector('meta[name="tessera-shell"]')?.content || null;
        } catch { return null; }
      })();

      /* ---- Getting the token into a wallet ---------------------------------
       *
       * A wallet cannot discover a token's name, decimals or logo from the
       * chain — ERC-20 carries no icon, and nothing indexes an Arc testnet
       * deployment. Until something tells it, TSRA shows as a grey circle with
       * a truncated address, and the balance reads as raw units.
       *
       * `wallet_watchAsset` is the standard way to say it. The image has to be
       * an absolute URL the wallet can fetch, so it is built from this page's
       * own origin rather than hard-coded.
       */
      if ($("govAddToken")) {
        $("govAddToken").addEventListener("click", async () => {
          if (!hasInjectedWallet()) {
            govMsg("govMsg", "No wallet detected in this browser.", "var(--warn)");
            return;
          }
          try {
            const cfg = await loadDefiConfig();
            if (!cfg.token) { govMsg("govMsg", "No token on this deployment.", "var(--warn)"); return; }
            const added = await eth().request({
              method: "wallet_watchAsset",
              params: {
                type: "ERC20",
                options: {
                  address: cfg.token,
                  symbol: "TSRA",
                  decimals: 18,
                  // Absolute, because the wallet fetches it from its own
                  // context and a relative path resolves against nothing there.
                  image: new URL("tsra-256.png", location.href).href,
                },
              },
            });
            govMsg("govMsg",
              added
                ? "TSRA added — your wallet will show the balance and the mark from now on."
                : "Your wallet declined to add it.",
              added ? "var(--good)" : "var(--warn)");
          } catch (e) {
            govMsg("govMsg", String(e && e.message ? e.message : e).slice(0, 160), "var(--warn)");
          }
        });
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
                showBusy("govDiscMsg", "Opening it as a proposal…");
                const res = await (await postJson("/api/governance/discussions/publish", { id: b.dataset.discPublish })).json();
                govMsg("govDiscMsg", res.ok ? `Opened as proposal #${res.proposalId}. Voting is live. — ${res.txHash}` : (res.error || "failed"),
                  res.ok ? "var(--good)" : "var(--warn)");
                if (res.ok) { loadDiscussions(); loadGovernance(true); }
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
          showBusy("govDiscMsg", kind === "draft" ? "Posting the draft…" : "Posting your reply…");
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
        loadGovernance(true);
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
          loadGovernance(true);
        });
      }

      if ($("govPropose")) {
        $("govPropose").addEventListener("click", async () => {
          const title = ($("govTitle").value || "").trim();
          const description = ($("govBody").value || "").trim();
          if (!title) { govMsg("govCreateMsg", "A proposal needs a title.", "var(--warn)"); return; }
          try {
            showBusy("govCreateMsg", "Opening the proposal…");
            const r = await (await postJson("/api/governance/propose", { title, description })).json();
            if (r.ok) {
              $("govTitle").value = ""; $("govBody").value = "";
              govMsg("govCreateMsg", "Proposal opened. Voting is live.", "var(--good)");
              loadGovernance(true);
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
            showBusy("govEmMsg", "Setting the rate…");
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

      /**
       * What is streaming right now, on both venues, with a way back into the form.
       *
       * The editor set rates and never showed one, so an operator had to
       * remember what they last typed — or read it off a different tab and
       * retype it, which is how a digit gets dropped from a number denominated
       * in wei per second. Each row loads its own current value into the form,
       * because "edit" should start from what is there.
       */
      function renderLiveRates() {
        const body = $("govEmLiveRows");
        if (!body) return;
        const em = window.__emissions;
        const lp = window.__lpEmissions;
        const dec = (em && em.reward && Number(em.reward.decimals)) || 18;
        const sym = (em && em.reward && em.reward.symbol) || "TSRA";
        const per = (raw) => {
          const n = Number(raw) / 10 ** dec;
          return { sec: n, day: n * 86400 };
        };
        const rows = [];
        for (const a of (em && em.assets) || []) {
          // The payload names each side rather than indexing them, so the map is
          // written out instead of guessed at — an off-by-one here would show an
          // operator the backstop's rate and set the supply side's.
          const bySide = [
            [0, "Supply", a.supplyRatePerSecond],
            [1, "Borrow", a.borrowRatePerSecond],
            [2, "Backstop", a.backstopRatePerSecond],
          ];
          for (const [side, label, raw] of bySide) {
            if (raw == null) continue;
            const v = per(raw);
            // Every side is listed, including the zeroes: a market paying
            // nothing is a fact an operator needs, and hiding it makes the
            // table look like the whole schedule when it is only part of it.
            rows.push(
              `<tr><td><b>${esc(a.symbol)}</b></td><td>${label}</td>` +
              `<td class="num mono">${esc(String(raw))}</td>` +
              `<td class="num">${v.day > 0 ? `<span class="tsraIcon"></span> ${esc(v.day.toFixed(4))}` : "—"}</td>` +
              `<td class="num"><button class="btn" data-emedit="${esc(a.address)}|${side}|${esc(String(raw))}" style="padding:3px 10px;font-size:11px">Edit</button></td></tr>`,
            );
          }
        }
        for (const p of (lp && lp.pools) || []) {
          const v = per(p.ratePerSecond);
          rows.push(
            `<tr><td><b>${esc(p.name)}</b><div class="muted" style="font-size:11px">AMM pool ${esc(String(p.poolId))}</div></td>` +
            `<td>Liquidity</td><td class="num mono">${esc(String(p.ratePerSecond))}</td>` +
            `<td class="num">${v.day > 0 ? `<span class="tsraIcon"></span> ${esc(v.day.toFixed(4))}` : "—"}</td>` +
            `<td class="num"><button class="btn" data-lpedit="${esc(String(p.poolId))}|${esc(String(p.ratePerSecond))}" style="padding:3px 10px;font-size:11px">Edit</button></td></tr>`,
          );
        }
        body.innerHTML = rows.length ? rows.join("") : emptyRow(5, `No streams configured. Rates are in ${esc(sym)} per second.`);

        const fill = (id, value) => {
          const el = $(id);
          if (!el) return;
          el.value = (Number(value) / 10 ** dec).toString();
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.focus();
        };
        body.querySelectorAll("[data-emedit]").forEach((b) =>
          b.addEventListener("click", () => {
            const [asset, side, raw] = b.dataset.emedit.split("|");
            $("govEmAsset").value = asset;
            $("govEmSide").value = side;
            fill("govEmRate", raw);
          }));
        body.querySelectorAll("[data-lpedit]").forEach((b) =>
          b.addEventListener("click", () => {
            const [poolId, raw] = b.dataset.lpedit.split("|");
            $("govLpPool").value = poolId;
            fill("govLpRate", raw);
          }));
      }

      /*
       * The AMM's streams had no editor at all.
       *
       * `/api/amm/emissions/rate` has existed the whole time; nothing in the app
       * called it, so liquidity rates were set once by a script and then
       * unreachable — an operator could pause the venue but not retune it.
       */
      if ($("govLpSet")) {
        $("govLpSet").addEventListener("click", async () => {
          const poolId = Number($("govLpPool").value);
          const lp = window.__lpEmissions;
          const dec = (lp && lp.reward && Number(lp.reward.decimals)) || 18;
          const typed = ($("govLpRate").value || "").trim();
          const parsed = parseAmount(typed, dec);
          // Zero stops a stream, which is a real instruction rather than an error.
          const raw = typed === "0" ? "0" : parsed.raw;
          if (raw == null) { govMsg("govLpMsg", parsed.error || "Enter a rate.", "var(--warn)"); return; }
          if (!Number.isInteger(poolId)) { govMsg("govLpMsg", "Pick a pool.", "var(--warn)"); return; }
          try {
            showBusy("govLpMsg", `Setting pool ${poolId} to ${typed} per second…`);
            const r = await (await postJson("/api/amm/emissions/rate", { poolId, ratePerSecond: String(raw) })).json();
            if (r.ok) {
              showReceipt("govLpMsg", true, `pool ${poolId} now pays ${typed} per second`, r.txHash);
              loadLpEmissions();
            } else govMsg("govLpMsg", r.error || "failed", "var(--warn)");
          } catch { govMsg("govLpMsg", "Request failed.", "var(--warn)"); }
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
            showBusy("regStatusMsg", "Recording the decision…");
            const r = await (await postJson("/api/governance/registry/status", { asset, status, reason })).json();
            govMsg("regStatusMsg", r.ok ? `Recorded. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("regStatusReason").value = ""; loadRegistry(); loadGauge(true); }
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
            showBusy("regMsg", "Checking the parameters against the pool…");
            const enc = await (await postJson("/api/governance/registry/encode", body)).json();
            if (!enc.ok) { govMsg("regMsg", enc.error || "failed", "var(--warn)"); return; }
            $("regSummary").textContent = enc.summary;

            showBusy("regMsg", `Opening the proposal to list ${enc.symbol}…`);
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
              loadGovernance(true);
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

      /**
       * @param {boolean} [fresh] Skip the server's short read cache.
       *
       * The reads behind this are ten-odd contract calls and are cached for a
       * few seconds so the tab does not re-derive them on every poll. Right
       * after your own vote that cache is exactly wrong, so the caller that
       * made the transaction asks for the uncached answer.
       */
      async function loadGauge(fresh) {
        const card = $("govGaugeCard");
        if (!card) return;
        try {
          const who = String(window.__myAddress || "");
          const parts = [];
          if (/^0x[0-9a-fA-F]{40}$/.test(who)) parts.push(`user=${encodeURIComponent(who)}`);
          if (fresh) parts.push("fresh=1");
          const q = parts.length ? `?${parts.join("&")}` : "";
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
          renderGaugePct();
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

      /* ---- The delegate directory ------------------------------------------
       *
       * Ten by default, heaviest first, because a directory people scroll is a
       * directory nobody reads past the top of. "Show more" doubles it, "Show
       * all" pages — all three are slices of one already-fetched list, so none
       * of them costs the server anything beyond the poll it was doing anyway.
       */
      const DELEGATE_PAGE = 10;
      let delegateShown = DELEGATE_PAGE;
      let delegatePaged = false;
      let delegatePage = 1;

      function renderDelegates(r) {
        const host = $("govDelegateList");
        if (!host) return;
        // Heaviest first: the weight is what a delegator is actually choosing.
        const list = (r.delegates || []).slice()
          .sort((a, b) => Number(b.votingPower) - Number(a.votingPower));

        let slice, label;
        if (delegatePaged) {
          const pages = Math.max(1, Math.ceil(list.length / DELEGATE_PAGE));
          if (delegatePage > pages) delegatePage = pages;
          slice = list.slice((delegatePage - 1) * DELEGATE_PAGE, delegatePage * DELEGATE_PAGE);
          label = `${(delegatePage - 1) * DELEGATE_PAGE + 1}–${Math.min(delegatePage * DELEGATE_PAGE, list.length)} of ${list.length}`;
        } else {
          slice = list.slice(0, delegateShown);
          label = `${slice.length} of ${list.length}`;
        }

        host.innerHTML = slice.length
          ? slice.map((d) =>
              `<tr><td><b>${esc(d.name)}</b>${d.isYou ? ' <span class="tag ok" style="font-size:10px">you</span>' : ""}` +
              `${d.active ? "" : ' <span class="tag warn" style="font-size:10px">stepped down</span>'}` +
              `<div class="muted" style="font-size:11px">${esc(d.statement || "")}</div>` +
              `<div class="row-actions" style="gap:6px;margin-top:3px">` +
              `<span class="muted mono" style="font-size:10.5px">${esc(shortAddr(d.address))}</span>` +
              `<button class="btn" style="padding:1px 7px;font-size:10.5px" ` +
              `data-copy-addr="${esc(d.address)}">Copy</button></div></td>` +
              `<td class="num mono">${esc(d.votingPower)}</td>` +
              `<td class="num"><button class="btn" style="padding:2px 8px;font-size:11px" ` +
              `data-delegate-to="${esc(d.address)}">Delegate</button></td></tr>`)
            .join("")
          : emptyRow(3, "Nobody has listed themselves yet.");

        host.querySelectorAll("[data-delegate-to]").forEach((b) =>
          b.addEventListener("click", () => delegateTo(b.dataset.delegateTo)),
        );
        host.querySelectorAll("[data-copy-addr]").forEach((b) =>
          b.addEventListener("click", () => copyAddress(b, b.dataset.copyAddr)),
        );

        const pager = $("govDelegatePager");
        if (pager) {
          pager.style.display = list.length > DELEGATE_PAGE ? "" : "none";
          $("govDelegateMore").style.display = delegatePaged || delegateShown >= list.length ? "none" : "";
          $("govDelegateAll").style.display = delegatePaged ? "none" : "";
          const pages = Math.max(1, Math.ceil(list.length / DELEGATE_PAGE));
          $("govDelegatePrev").style.display = delegatePaged ? "" : "none";
          $("govDelegateNext").style.display = delegatePaged ? "" : "none";
          $("govDelegatePrev").disabled = delegatePage <= 1;
          $("govDelegateNext").disabled = delegatePage >= pages;
          $("govDelegatePage").textContent = label;
        }
      }

      if ($("govDelegateMore")) {
        $("govDelegateMore").addEventListener("click", () => {
          delegateShown += DELEGATE_PAGE;
          if (window.__gauge) renderDelegates(window.__gauge);
        });
      }
      if ($("govDelegateAll")) {
        $("govDelegateAll").addEventListener("click", () => {
          delegatePaged = true; delegatePage = 1;
          if (window.__gauge) renderDelegates(window.__gauge);
        });
      }
      if ($("govDelegatePrev")) {
        $("govDelegatePrev").addEventListener("click", () => {
          if (delegatePage > 1) { delegatePage--; renderDelegates(window.__gauge); }
        });
      }
      if ($("govDelegateNext")) {
        $("govDelegateNext").addEventListener("click", () => {
          delegatePage++; renderDelegates(window.__gauge);
        });
      }

      /**
       * Copy an address, and say so on the button itself.
       *
       * `navigator.clipboard` needs a secure context and is refused outright by
       * some in-app browsers, so the fallback is a hidden textarea — an address
       * you cannot copy is an address you have to retype, which is how people
       * delegate to the wrong wallet.
       */
      async function copyAddress(btn, addr) {
        const was = btn.textContent;
        let done = false;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(addr);
            done = true;
          }
        } catch { /* fall through */ }
        if (!done) {
          try {
            const ta = document.createElement("textarea");
            ta.value = addr;
            ta.setAttribute("readonly", "");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            done = document.execCommand("copy");
            document.body.removeChild(ta);
          } catch { done = false; }
        }
        btn.textContent = done ? "Copied" : "Copy failed";
        setTimeout(() => { btn.textContent = was; }, 1400);
      }

      async function delegateTo(to) {
        if (!selfMode()) {
          govMsg("govDelegateMsg", "Delegating is signed by the holder — switch on \"Use my own wallet\".", "var(--warn)");
          return;
        }
        await selfCustody("govDelegateMsg", `delegate to ${to.slice(0, 10)}…`, async (from, cfg) =>
          sendTx(from, cfg.token, callData(cfg.selectors.govDelegate, encAddr(to))),
        );
        loadGovernance(true);
        loadGauge(true);
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
          loadGauge(true);
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

      /* The slider is the unit the question is really in: not "how many tokens
         on this market" but "how much of what I have, spread across the board".
         The per-market boxes stay, for anybody who wants to be exact. */
      function gaugeBudgetRaw() {
        const r = window.__gauge;
        if (!r || !r.you) return 0n;
        const used = (r.markets || []).reduce((t, m) => t + BigInt(m.yourVotesRaw || "0"), 0n);
        return BigInt(r.you.availableRaw || "0") + used;
      }
      function renderGaugePct() {
        const el = $("gaPct");
        if (!el) return;
        const pct = Number(el.value);
        $("gaPctLabel").textContent = `${pct}%`;
        const total = gaugeBudgetRaw();
        const use = (total * BigInt(pct)) / 100n;
        $("gaPctNote").textContent = total === 0n
          ? "You have no delegated TSRA to vote with yet."
          : `Casting ${fmtUnitsStr(use, 18)} of ${fmtUnitsStr(total, 18)} TSRA. ` +
            `Leave a market empty to skip it — whatever you fill in is split in the ratio you type.`;
      }
      if ($("gaPct")) $("gaPct").addEventListener("input", renderGaugePct);
      if ($("gaMax")) {
        $("gaMax").addEventListener("click", () => {
          $("gaPct").value = "100";
          renderGaugePct();
          // Max means all of it, spread evenly over the eligible markets that
          // are still open — otherwise "max" leaves the boxes empty and the
          // button does nothing visible.
          const r = window.__gauge;
          if (!r) return;
          const open = (r.markets || []).filter((m) => m.active && m.eligible);
          if (!open.length) return;
          const each = gaugeBudgetRaw() / BigInt(open.length);
          document.querySelectorAll(".gaVote").forEach((el) => {
            const m = open.find((x) => String(x.id) === el.dataset.market);
            el.value = m ? fmtUnitsStr(each, 18) : "";
          });
        });
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
          loadGauge(true);
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
          loadGauge(true);
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
              showBusy("gaMsg", `Applying epoch #${epoch}…`);
              const r = await (await postJson("/api/gauge/apply", { epoch })).json();
              govMsg("gaMsg", r.ok ? `Applied. — ${r.txHash}` : (r.error || "failed"),
                r.ok ? "var(--good)" : "var(--warn)");
            } catch { govMsg("gaMsg", "Request failed.", "var(--warn)"); }
          }
          loadGauge(true);
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
        loadGauge(true);
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
          // The picker's label is the symbol; the asset list is the same answer
          // from the deployment, and one of the two is always there.
          const bribeSym = walSymbol(token) || (opt.textContent || "").trim();
          await selfCustody("gaBribeMsg", `attach ${$("gaBribeAmount").value} ${bribeSym}`.trim() + " to a market", async (from, cfg) => {
            // Exactly what is being attached, and no more — the same rule every
            // other approval in this app follows.
            await ensureAllowance(from, token, cfg.gauge, BigInt(parsed.raw));
            return sendTx(from, cfg.gauge, callData(
              cfg.selectors.gaAddBribe,
              encUint(r.epoch), encUint(marketId), encAddr(token), encUint(parsed.raw),
            ));
          });
          $("gaBribeAmount").value = "";
          loadGauge(true);
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
            showBusy("gaAdminMsg", "Setting the budget…");
            const r = await (await postJson("/api/gauge/budget", { lendingPerSecond: l, ammPerSecond: a })).json();
            govMsg("gaAdminMsg", r.ok ? `Budget set. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) loadGauge(true);
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
            showBusy("gaAdminMsg", "Setting the reward zone…");
            const r = await (await postJson("/api/gauge/zone", { size })).json();
            govMsg("gaAdminMsg", r.ok ? `Reward zone set to ${size}. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) loadGauge(true);
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
            showBusy("gaAdminMsg", `Listing ${label}…`);
            const r = await (await postJson("/api/gauge/market", body)).json();
            govMsg("gaAdminMsg", r.ok ? `Listed. — ${r.txHash}` : (r.error || "failed"),
              r.ok ? "var(--good)" : "var(--warn)");
            if (r.ok) { $("gaNewLabel").value = ""; loadGauge(true); }
          } catch { govMsg("gaAdminMsg", "Request failed.", "var(--warn)"); }
        });
      }

      /* ---- Pausing emissions (operator) ------------------------------------ */
      async function setEmissionsPaused(which, paused) {
        const url = which === "lp" ? "/api/amm/emissions/pause" : "/api/lending/emissions/pause";
        try {
          showBusy("govPauseMsg", `${paused ? "Pausing" : "Resuming"} ${which === "lp" ? "liquidity" : "lending"} emissions…`);
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
          loadGovernance(true);
          loadGauge(true);
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
          /*
           * Hide it only if it has never had anything to show.
           *
           * This used to hide the card on any poll that came back unconfigured,
           * and the catch below hid it on any poll that failed — so on a
           * throttled RPC the claim box vanished mid-session and stayed gone
           * until a poll happened to succeed. A panel that disappears reads as a
           * feature being taken away, not as a slow network. Once it has
           * rendered, it stays: slightly stale beats absent.
           */
          if (!window.__lpEmissions) { if (!card.dataset.everShown) card.style.display = "none"; return; }
          card.style.display = "";
          card.dataset.everShown = "1";
          // What a claim would pay, not what has been earned — see the lending
          // twin for why the two must not be conflated over a Claim button.
          $("amEmAmount").textContent = r.yourPayable ?? r.yourClaimable ?? "0";
          $("amEmSymbol").textContent = r.reward.symbol;
          $("amEmNote").textContent =
            (r.paused
              ? (r.guard && r.guard.byGuard
                  ? `Paused automatically: ${guardWhy(r)} It restarts on its own once the pot is ahead of what is owed. `
                  : "Paused — nothing is accruing right now. ") +
                "What you have already earned is still claimable. "
              : "") +
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
          /*
           * A disabled button with no explanation is the same dead end as a
           * blank panel. Nothing accrues to an address holding no LP shares, and
           * saying so — with the way to change it — is more use than greying the
           * control out and leaving the reader to guess whether it is broken.
           */
          const owed = BigInt(r.yourClaimableRaw || "0");
          const payable = BigInt(r.yourPayableRaw ?? r.yourClaimableRaw ?? "0");
          const holdsShares = (r.pools || []).some((p) => Number(p.yourShares) > 0);
          // A claim that can pay nothing reverts, so the button is off and the
          // note says which of the two reasons applies.
          $("amEmClaim").disabled = !(payable > 0n);
          if ($("amEmWhy")) {
            $("amEmWhy").style.display = payable > 0n ? "none" : "";
            $("amEmWhy").textContent =
              owed > 0n
                ? `You have earned ${r.yourClaimable} ${r.reward.symbol}, but the reward pot is empty, so a claim ` +
                  "would pay nothing right now. It stays owed and is claimable as soon as the pot is funded."
                : holdsShares
                  ? "Nothing has accrued yet — rewards build up per second against the shares you hold."
                  : "You hold no liquidity in these pools, so nothing is accruing. Add liquidity below to start earning.";
          }
          const lpBtn = $("govLpPause");
          if (lpBtn) lpBtn.textContent = r.paused ? "Resume liquidity" : "Pause liquidity";
          // The pool picker in the operator's rate editor, kept in step with
          // whatever pools actually exist rather than hard-coded.
          const sel = $("govLpPool");
          if (sel) {
            const want = (r.pools || []).map((p) => `${p.poolId}:${p.name}`).join(",");
            if (sel.dataset.pools !== want) {
              const keep = sel.value;
              sel.innerHTML = (r.pools || []).map((p) => `<option value="${esc(String(p.poolId))}">${esc(p.name)}</option>`).join("");
              sel.dataset.pools = want;
              if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
            }
          }
          renderLiveRates();
        } catch {
          if (!card.dataset.everShown) card.style.display = "none";
        }
      }

      if ($("amEmClaim")) {
        $("amEmClaim").addEventListener("click", async () => {
          const em = window.__lpEmissions;
          if (!em) return;
          const owedPools = (em.pools || [])
            .filter((p) => BigInt(p.claimable || "0") > 0n)
            .map((p) => ({ poolId: BigInt(p.poolId), owed: BigInt(p.claimable) }));
          // Your share of the pot, the same rule as the lending twin.
          const lpCap = shareOfPot(em.yourClaimableRaw, em.reward && em.reward.owedRaw, em.reward && em.reward.balanceRaw);
          const lpPicked = pickStreams(owedPools, lpCap);
          const ids = lpPicked.map((x) => x.poolId);
          if (owedPools.length && !ids.length) {
            // Empty pot only — `pickStreams` never returns nothing while
            // there is something to pay.
            govMsg("amEmMsg", "The pot is empty, so a claim would pay nothing. What you have earned stays accrued.", "var(--warn)");
            return;
          }
          if (!ids.length) {
            govMsg("amEmMsg", "Nothing has accrued to claim yet.", "var(--warn)");
            return;
          }
          const btn = $("amEmClaim");
          // Same as the lending claim: an operator session is already looking
          // at the app wallet's own figure, and `claim` pays `msg.sender`.
          if (!selfMode()) {
            btn.disabled = true;
            showBusy("amEmMsg", "Claiming to the app wallet…");
            try {
              const r = await (await postJson("/api/amm/emissions/claim", {})).json();
              if (r.ok) {
                const dp = (em.reward && em.reward.decimals) || 18;
                const paid = (Number(r.paid) / 10 ** dp).toFixed(6).replace(/\.?0+$/, "");
                // `govMsg` writes textContent, which would print the anchor as
                // markup. The receipt carries a link, so it goes in directly.
                const el = $("amEmMsg");
                el.style.display = "block"; el.style.color = "var(--good)";
                el.innerHTML = `Claimed ${esc(paid)} ${esc(em.reward.symbol)} to ${esc(String(r.to).slice(0, 10))}… ` +
                  `— view on Arcscan: ${txLink(r.txHash)}`;
              } else govMsg("amEmMsg", `Claim failed: ${r.error}`, "var(--warn)");
            } catch { govMsg("amEmMsg", "Claim request failed.", "var(--warn)"); }
            btn.disabled = false;
            loadLpEmissions();
            return;
          }
          btn.disabled = true;
          // What will arrive, not what is owed — see the lending twin.
          const lpTaking = lpPicked.reduce((t, x) => t + x.owed, 0n);
          const lpPot = BigInt((em.reward && em.reward.balanceRaw) || "0");
          const lpPaying = lpTaking < lpPot ? lpTaking : lpPot;
          const lpDp = (em.reward && em.reward.decimals) || 18;
          const lpHuman = (Number(lpPaying) / 10 ** lpDp).toFixed(6).replace(/\.?0+$/, "");
          const claimLabel =
            `claim ${lpHuman} ${em.reward.symbol}` +
            (lpPaying < BigInt(em.yourClaimableRaw || "0") ? " (what the pot can pay — the rest stays owed)" : "");
          await selfCustody("amEmMsg", claimLabel, async (from, cfg) =>
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
          govMsg("feeCreditMsg", "Credit is bought out of your own wallet, so this needs it. " +
            "Switch on \"Use my own wallet\".", "var(--warn)");
          return;
        }
        const parsed = parseAmount($("feeAmount").value, 6);
        if (!parsed.raw) { govMsg("feeCreditMsg", parsed.error || "Enter an amount.", "var(--warn)"); return; }
        const cfgAll = await loadDefiConfig();
        const asset = inTsra ? cfgAll.token : cfgAll.usdc;
        // What has to be approved differs by route: USDC is credited at par, so
        // the approval is the credit itself; TSRA is priced by the contract, so
        // the approval is the quote.
        let approve = BigInt(parsed.raw);
        if (inTsra) {
          const q = await (await fetch(`/api/fees/quote?credit=${parsed.raw}`)).json();
          if (!q.ok) { govMsg("feeCreditMsg", q.error || "Could not price that in TSRA.", "var(--warn)"); return; }
          approve = BigInt(q.costRaw);
        }
        await selfCustody("feeCreditMsg", `buy ${$("feeAmount").value} USDC of credit`, async (from, cfg) => {
          await ensureAllowance(from, asset, cfg.serviceFees, approve);
          return sendTx(from, cfg.serviceFees, callData(
            inTsra ? cfg.selectors.feeTopUpTsra : cfg.selectors.feeTopUpUsdc, encUint(parsed.raw),
          ));
        });
        loadFeeCredit();
      }

      if ($("feeBuyUsdc")) $("feeBuyUsdc").addEventListener("click", () => buyCredit(false));
      if ($("feeBuyTsra")) $("feeBuyTsra").addEventListener("click", () => buyCredit(true));

      if ($("feeCreditWithdraw")) {
        $("feeCreditWithdraw").addEventListener("click", async () => {
          if (!selfMode()) {
            govMsg("feeCreditMsg", "A refund goes back to the address that paid — switch on \"Use my own wallet\".", "var(--warn)");
            return;
          }
          await selfCustody("feeCreditMsg", "take back your unspent credit", async (from, cfg) =>
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
            showBusy("feeAdminMsg", "Setting the credit rate…");
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
            showBusy("feeAdminMsg", "Charging the account…");
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
        // The result usually replaces a spinner; a line that still claims
        // aria-busy after settling reads as loading forever.
        m.removeAttribute("aria-busy");
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
          /*
           * This switch turns itself on, and a programmatic `checked` fires no
           * change event — so nothing downstream of the toggle's own handler
           * ran on the path most people actually take. That is why a visitor
           * with MetaMask saw the *app wallet's* rewards and positions labelled
           * as theirs: self-custody was on, and the page had never worked out
           * whose numbers to show. Do here what the change handler does.
           */
          if (selfMode()) adoptConnectedAccount();
          if (typeof loadWallet === "function") loadWallet();
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
          // Switching on self-custody without signing in is a supported path,
          // and it is the one where the page has to work out who you are.
          if (on) adoptConnectedAccount();
          // The Wallet pane shows a different wallet either side of this
          // switch, so it has to be re-read rather than left showing the one
          // the visitor just switched away from.
          if (typeof loadWallet === "function") loadWallet();
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
        /*
         * A real opener, because `btn.click()` is not one.
         *
         * A synthetic click bubbles to the `document` listener above, which
         * closes every menu — so opening a panel from code toggled it on and
         * straight back off, and looked exactly like a dead button.
         */
        const open = () => {
          document.querySelectorAll(".menuPanel.open").forEach((p) => { if (p !== panel) p.classList.remove("open"); });
          panel.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
        };
        return { close, open };
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
      /**
       * A status line in a settings drawer.
       *
       * The row is two cells: an icon slot and the words. In flight it holds a
       * turning ring in the muted colour, because an admin action here sends a
       * transaction and "Sending…" alone, on a screen that is not moving, reads
       * as something that already finished.
       */
      function cfgRowMsg(id, text, good, busy) {
        const row = $(id);
        if (!row) return;
        row.style.display = "flex";
        row.style.color = busy ? "var(--muted)" : good ? "var(--good)" : "var(--warn)";
        if (row.firstElementChild !== row.lastElementChild) {
          row.firstElementChild.innerHTML = busy ? '<span class="spin" aria-hidden="true"></span>' : "";
        }
        row.lastElementChild.textContent = text;
        if (busy) row.setAttribute("aria-busy", "true");
        else row.removeAttribute("aria-busy");
      }

      function cfgLnMsg(text, good, busy) { cfgRowMsg("cfgLnMsg", text, good, busy); }
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
          cfgLnMsg("Sending…", true, true);
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
          cfgLnMsg("Sending…", true, true);
          try {
            const r = await (await postJson("/api/lending/admin/rename", { asset, name: name.trim() })).json();
            cfgLnMsg(r.ok ? "Renamed ✓" : r.error, !!r.ok);
            if (r.ok) afterTx();
          } catch { cfgLnMsg("Request failed.", false); }
        });

        const visibility = async (hidden) => {
          cfgLnMsg("Sending…", true, true);
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
          cfgLnMsg("Sending…", true, true);
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
      function cfgHiMsg(text, good, busy) { cfgRowMsg("cfgHiMsg", text, good, busy); }
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
          cfgHiMsg("Scanning the contract for holders…", true, true);
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
          cfgHiMsg("Re-reading balances…", true, true);
          try {
            const r = await (await postJson(`/api/history/${rec.id}/refresh`, {})).json();
            cfgHiMsg(r.ok ? `Refreshed ✓ — ${r.record.outstandingCount} holder(s) outstanding` : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiActivate").addEventListener("click", async () => {
          const rec = cfgHiOne();
          if (!rec) return;
          cfgHiMsg("Switching the app over…", true, true);
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
          cfgHiMsg("Re-reading balances, then paying out…", true, true);
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
          cfgHiMsg("Migrating…", true, true);
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
          cfgHiMsg("Merging the records…", true, true);
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
          cfgHiMsg("Splitting the record…", true, true);
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
          cfgHiMsg("Deleting…", true, true);
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
          cfgHiMsg(`Archiving the current ${kind}, then deploying…`, true, true);
          try {
            const r = await (await postJson("/api/admin/deploy", { kind })).json();
            cfgHiMsg(r.ok ? r.note : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });

        $("cfgHiDeleteAll").addEventListener("click", async () => {
          if (!confirm("Delete every history record, including any with funds still outstanding?")) return;
          cfgHiMsg("Deleting every record…", true, true);
          try {
            const r = await (await postJson("/api/history/delete", { all: true })).json();
            cfgHiMsg(r.ok ? `Deleted ${r.removed} ✓` : r.error, !!r.ok);
            if (r.ok) loadCfgHistory();
          } catch { cfgHiMsg("Request failed.", false); }
        });
      }

      /* ---- notice authoring ------------------------------------------------ */
      const NOTICE_UNITS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
      function cfgNoMsg(text, good, busy) { cfgRowMsg("cfgNoMsg", text, good, busy); }
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
          cfgNoMsg("Publishing…", true, true);
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
          cfgNoMsg("Deleting…", true, true);
          try {
            const r = await (await postJson("/api/notices/delete", { ids })).json();
            cfgNoMsg(r.ok ? `Deleted ${r.removed} ✓` : r.error, !!r.ok);
            if (r.ok) { loadCfgNotices(); pollNotices(); }
          } catch { cfgNoMsg("Request failed.", false); }
        });
        $("cfgNoDeleteAll").addEventListener("click", async () => {
          if (!confirm("Delete every notice, including scheduled ones?")) return;
          cfgNoMsg("Deleting every notice…", true, true);
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
      function cfgAmmMsg(text, good, busy) { cfgRowMsg("cfgAmmMsg", text, good, busy); }
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
        cfgAmmMsg("Sending…", true, true);
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
          cfgAmmMsg("Sending…", true, true);
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
          cfgAmmMsg("Sending…", true, true);
          try {
            const r = await (await postJson("/api/amm/admin/rename", { poolId, name: name.trim() })).json();
            cfgAmmMsg(r.ok ? "Renamed ✓" : r.error, !!r.ok);
            if (r.ok) afterTx();
          } catch { cfgAmmMsg("Request failed.", false); }
        });

        $("cfgAmmCreate").addEventListener("click", async () => {
          const assets = [...$("cfgAmmNewAssets").selectedOptions].map((o) => o.value);
          if (assets.length < 2) { cfgAmmMsg("Pick at least two assets.", false); return; }
          cfgAmmMsg("Deploying pool…", true, true);
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
          const res = await fetch("/api/profile", { headers: authHeaders() });
          /*
           * A token the server has stopped accepting is worse than no token.
           *
           * Sessions expire after twelve hours. The page kept the dead one in
           * localStorage, hid the profile button when `/api/profile` refused
           * it, and went on treating "a token exists" as "signed in" — so the
           * header lost its profile icon, and everything that offered to open
           * the profile pointed at a hidden element. Clear it, and let the
           * page render an honest signed-out state.
           */
          if (res.status === 401 || res.status === 403) {
            localStorage.removeItem("tessera_token");
            profileState = null;
            if (wrap) wrap.style.display = "none";
            if (cw) cw.style.display = "none";
            if (typeof setAdmin === "function") setAdmin(null);
            return;
          }
          const p = await res.json();
          if (!p.ok) throw new Error("no session");
          profileState = p;
          /*
           * An operator with no browser wallet still holds a position — the
           * agent's. Without this every "yours" panel read an empty address and
           * showed zero, so pressing Supply as an operator took a real position
           * that the page then insisted did not exist.
           *
           * A connected wallet always wins: if somebody has one, that is who
           * they are, and the operator session is only how they authenticate.
           */
          // …and self-custody wins over both. An operator who has switched on
          // "use my own wallet" is acting as their own wallet, so showing them
          // the agent's balances there is the same error in the other
          // direction.
          if (!window.__myAddress && p.actingAs && !selfMode()) {
            window.__myAddress = p.actingAs;
            if (typeof loadClaimables === "function") loadClaimables().catch(() => {});
          }
          if (selfMode()) adoptConnectedAccount();
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
        showBusy("sellOut", "Requesting a quote, escrowing on Arc, collecting… this is three transactions, give it a moment.");
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
          showBusy("escFeeNote", "Sending the owner call…");
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
        const pane = AG_PANES[tab];
        if (tab === "news") withPaneBusy(pane, () => loadNewsTopics().then(load)).catch(() => {});
        else if (!opts || opts.load !== false) withPaneBusy(pane, load).catch(() => {});
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
          showBusy("cfgMsg", "Saving, and pushing what belongs on-chain…");
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
          showBusy("feeMsg", "Allocating collected fees…");
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
      if (typeof loadBuild === "function") loadBuild().catch(() => {});
      setInterval(() => { if (typeof loadBuild === "function") loadBuild().catch(() => {}); }, 60000);
      setInterval(() => {
        if ($("paneGov") && !$("paneGov").hidden && typeof GOV_LOADERS !== "undefined") {
          const load = GOV_LOADERS[govTab];
          if (load) Promise.resolve(load()).catch(() => {});
        }
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
