const $ = (id) => document.getElementById(id);

      // Register the service worker so the dashboard is an installable PWA.
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
      }

      // --- Theme: System / Light / Dark (persisted) ---
      const themeSel = $("themeSel");
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

      const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
      const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

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

      async function tick() {
        let s;
        try {
          // Bound the wait: a hung read (rate-limited RPC, wedged container)
          // should report itself, not leave the page spinning on "—" forever.
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 25000);
          const res = await fetch("/api/state", { signal: ctl.signal }).finally(() => clearTimeout(timer));
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

        $("agentBal").innerHTML = (+s.agent.balanceUsdc).toFixed(4) + '<span class="u">USDC</span>';
        $("agentAddr").textContent = s.agent.address;
        const start = +s.agent.startBalanceUsdc || 1;
        $("balBar").style.width = Math.max(0, Math.min(100, (100 * +s.agent.balanceUsdc) / start)) + "%";
        const delta = +s.agent.balanceUsdc - start;
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
          $("trBal").textContent = (+tr.balanceUsdc).toFixed(4) + " USDC";
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
          $("lnHealth").textContent = ln.account.healthFactor;
          window.__lending = ln;
          const sel = $("lnAsset");
          // (Re)build the asset dropdown only when the set of symbols changes,
          // so it doesn't reset the user's selection on every poll.
          const symbols = ln.assets.map((a) => a.symbol).join(",");
          if (sel.dataset.symbols !== symbols) {
            const keep = sel.value;
            sel.innerHTML = ln.assets.map((a) => `<option value="${a.symbol}">${a.symbol}</option>`).join("");
            sel.dataset.symbols = symbols;
            if (ln.assets.some((a) => a.symbol === keep)) sel.value = keep;
          }
          if (window.renderLendingAsset) window.renderLendingAsset();
        }

        // Vault (auto-yield on USDC) — always visible.
        const vt = s.vault;
        const vtReady = !!(vt && vt.ready);
        setPanelReady("vault", vtReady, ["vAction", "vAmount", "vMax", "vExecute"], vt && vt.deployed);
        if (vtReady) {
          window.__vault = vt;
          window.__agentUsdc = vt.walletUsdc || (s.agent ? s.agent.balanceUsdc : "0");
          $("vWallet").textContent = (vt.walletUsdc || "0") + " USDC";
          $("vReserve").textContent = vt.reserveRatioPct;
          $("vFee").textContent = vt.performanceFeePct;
          $("vTvl").textContent = vt.totalAssets + " USDC";
          $("vYours").textContent = vt.yourAssets + " USDC";
          $("vApr").textContent = vt.supplyApr + "%";
          $("vBuffer").textContent = vt.bufferPct + "%";
        }

        // Swap desk — always visible.
        const sw = s.swap;
        const swReady = !!(sw && sw.ready && sw.assets && sw.assets.length);
        setPanelReady("swap", swReady, ["swAmount", "swIn", "swOut", "swQuote", "swExecute"], sw && sw.deployed);
        if (swReady) {
          window.__swap = sw;
          renderSwapBalances();
          const syms = sw.assets.map((a) => a.symbol).join(",");
          if ($("swIn").dataset.symbols !== syms) {
            const opts = sw.assets.map((a) => `<option value="${a.address}" data-sym="${a.symbol}" data-dec="${a.decimals || 6}">${a.symbol}</option>`).join("");
            $("swIn").innerHTML = opts;
            $("swOut").innerHTML = opts;
            $("swIn").dataset.symbols = syms;
            $("swOut").dataset.symbols = syms;
            if (sw.assets.length > 1) $("swOut").selectedIndex = 1;
          }
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

      // --- Admin login (id + password) ---
      // The admin id is a secret: it is never pre-filled, never defaulted, and
      // never rendered in the UI. A signed-in operator only sees a neutral
      // "Signed in" state, so the id can't be read off the screen.
      let adminId = null;
      function setAdmin(id) {
        adminId = id;
        const b = $("adminBtn");
        b.textContent = id ? "Signed in ⚙" : "Admin";
        b.title = id ? "Operator session active — click to change password or sign out" : "Operator sign-in";
        b.style.borderColor = id ? "var(--good)" : "";
        b.style.color = id ? "var(--good)" : "";
      }
      async function adminFlow() {
        if (adminId) {
          const choice = prompt("Admin — type 'password' to change password, or 'logout' to sign out:", "");
          if (choice === "logout") {
            await postAuthed("/api/admin/logout").catch(() => {});
            localStorage.removeItem("tessera_token");
            setAdmin(null);
            return;
          }
          if (choice === "password") {
            const current = prompt("Current password:");
            const next = prompt("New password (min 8 chars):");
            if (!current || !next) return;
            const r = await (await postAuthed("/api/admin/change-password", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ current, next }),
            })).json();
            alert(r.ok ? "Password changed." : "Failed: " + r.error);
          }
          return;
        }
        // No default value — the operator must type the id from memory.
        const id = prompt("Admin id:");
        if (!id) return;
        const password = prompt("Password:");
        if (!password) return;
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
      function setWallet(addr) {
        const btn = $("walletBtn");
        if (addr) {
          btn.textContent = addr.slice(0, 6) + "…" + addr.slice(-4) + " ✓";
          btn.style.borderColor = "var(--good)";
          btn.style.color = "var(--good)";
        } else {
          btn.textContent = "Connect Wallet";
          btn.style.borderColor = "";
          btn.style.color = "";
        }
      }
      async function connectWallet() {
        if (!window.ethereum) {
          alert("No browser wallet detected. Please install or enable a Web3 wallet, then try Connect Wallet again.");
          return;
        }
        const btn = $("walletBtn");
        btn.disabled = true;
        try {
          const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
          const { nonce } = await (await fetch("/api/auth/nonce")).json();
          const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
          const message =
            `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\n` +
            `Sign in to Tessera.\n\nURI: ${location.origin}\nVersion: 1\n` +
            `Chain ID: ${parseInt(chainIdHex, 16)}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
          const signature = await window.ethereum.request({ method: "personal_sign", params: [message, address] });
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
        $("lnAssetSupplied").textContent = a.position.supplied + " " + a.symbol;
        $("lnAssetBorrowed").textContent = a.position.borrowed + " " + a.symbol;
        $("lnWallet").textContent = a.position.wallet + " " + a.symbol;
        const action = $("lnAction").value;
        const max = a.max[action];
        $("lnMaxHint").textContent = "max " + action + ": " + max + " " + a.symbol +
          (action === "borrow" && !a.borrowable ? " (not borrowable)" : "");
      };
      function fillMax() {
        const a = selectedLendingAsset();
        if (!a) return;
        const action = $("lnAction").value;
        $("lnAmount").value = a.max[action];
        $("lnAmount").dataset.raw = a.max[action + "Raw"]; // exact raw for a true MAX
      }
      $("lnAsset").addEventListener("change", renderLendingAsset);
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
          tick();
        }
      });

      // --- Vault: deposit / withdraw USDC ------------------------------------
      $("vMax").addEventListener("click", () => {
        const vt = window.__vault;
        if (!vt) return;
        $("vAmount").value = $("vAction").value === "deposit" ? (window.__agentUsdc || "0") : vt.maxWithdraw;
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
        } finally { btn.disabled = false; tick(); }
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
       * and the desk's inventory of the output asset.
       */
      window.renderSwapBalances = function renderSwapBalances() {
        const s = swapSelected();
        if (!s) return;
        const ai = swAsset(s.tokenIn), ao = swAsset(s.tokenOut);
        const el = $("swBalances");
        if (!el || !ai || !ao) return;
        if (s.tokenIn === s.tokenOut) { el.textContent = "Pick two different assets."; return; }
        const pi = parseFloat(ai.priceUsd), po = parseFloat(ao.priceUsd);
        let rate = "";
        if (pi > 0 && po > 0) {
          const outPerIn = pi / po, inPerOut = po / pi;
          const f = (n) => (n >= 1000 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
          rate = `1 ${ai.symbol} ≈ ${f(outPerIn)} ${ao.symbol}  ·  1 ${ao.symbol} ≈ ${f(inPerOut)} ${ai.symbol}`;
        }
        el.innerHTML =
          `<div>${esc(rate)}</div>` +
          `<div style="margin-top:4px">Your ${esc(ai.symbol)}: <b>${esc(ai.wallet)}</b>` +
          ` · desk has <b>${esc(ao.inventory)}</b> ${esc(ao.symbol)} to give</div>`;
      };
      async function swapQuote() {
        const s = swapSelected(); if (!s) return null;
        const human = $("swAmount").value.trim();
        if (!human || Number(human) <= 0) return null;
        if (s.tokenIn === s.tokenOut) { $("swQuoteOut").textContent = "Pick two different assets."; return null; }
        const amountIn = toRaw(human, s.decIn);
        const r = await (await fetch(`/api/swap/quote?tokenIn=${s.tokenIn}&tokenOut=${s.tokenOut}&amountIn=${amountIn}`)).json();
        if (!r.ok) { $("swQuoteOut").textContent = "Quote failed: " + r.error; return null; }
        const out = fmtUnitsJs(r.out, s.decOut);
        const fee = fmtUnitsJs(r.fee, s.decOut);
        const appFee = fmtUnitsJs(r.appFee, s.decOut);
        const eff = Number(out) > 0 && Number(human) > 0 ? (Number(out) / Number(human)) : 0;
        $("swQuoteOut").innerHTML =
          `You pay <b>${esc(human)} ${esc(s.symIn)}</b> → you receive <b>${esc(out)} ${esc(s.symOut)}</b><br>` +
          `<span style="font-weight:400;color:var(--muted)">effective rate 1 ${esc(s.symIn)} = ` +
          `${eff ? eff.toPrecision(6) : "—"} ${esc(s.symOut)} · total fee ${esc(fee)} ${esc(s.symOut)} ` +
          `(app keeps ${esc(appFee)}) · 1% max slippage</span>`;
        return { ...s, amountIn, out: r.out };
      }
      function fmtUnitsJs(raw, dec) {
        const s = String(raw).padStart(dec + 1, "0");
        const i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, "");
        return f ? `${i}.${f}` : i;
      }
      // Refresh the rate/balance line whenever either side changes.
      $("swIn").addEventListener("change", () => { renderSwapBalances(); $("swQuoteOut").textContent = ""; });
      $("swOut").addEventListener("change", () => { renderSwapBalances(); $("swQuoteOut").textContent = ""; });
      $("swQuote").addEventListener("click", swapQuote);
      $("swExecute").addEventListener("click", async () => {
        const q = await swapQuote();
        const msg = $("swapMsg");
        if (!q) { msg.style.display = "block"; msg.style.color = "var(--warn)"; msg.textContent = "Get a valid quote first."; return; }
        // 1% slippage floor.
        const minOut = (BigInt(q.out) * 99n / 100n).toString();
        const btn = $("swExecute");
        // Self-custody: swap the user's own tokens through their wallet.
        if (selfMode()) {
          btn.disabled = true;
          await selfCustody("swapMsg", `swap ${q.symIn} → ${q.symOut}`, async (from, cfg) => {
            await ensureAllowance(from, q.tokenIn, cfg.swap, q.amountIn);
            return sendTx(
              from,
              cfg.swap,
              callData(cfg.selectors.swapExec, encAddr(q.tokenIn), encAddr(q.tokenOut), encUint(q.amountIn), encUint(minOut)),
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

      async function selfAccount() {
        if (!window.ethereum) throw new Error("No browser wallet detected.");
        const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
        const cfg = await loadDefiConfig();
        // Make sure the wallet is on Arc, offering to add the network if unknown.
        const want = "0x" + Number(cfg.chainId).toString(16);
        const have = await window.ethereum.request({ method: "eth_chainId" });
        if (have !== want) {
          try {
            await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
          } catch (e) {
            if (e && (e.code === 4902 || String(e.message || "").includes("Unrecognized"))) {
              await window.ethereum.request({
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
        return window.ethereum.request({ method: "eth_call", params: [{ to, data }, "latest"] });
      }
      async function sendTx(from, to, data) {
        return window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
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
          msg.innerHTML = `${esc(label)} sent from your wallet ✓ — ` +
            `<a href="${cfg.explorer}/tx/${hash}" target="_blank" rel="noopener">${String(hash).slice(0, 12)}…</a>`;
        } catch (e) {
          msg.style.color = "var(--warn)";
          msg.textContent = walletError(e);
        } finally {
          tick();
        }
      }
      // Plain-language wallet/chain errors (mirrors the server's friendlyError).
      function walletError(e) {
        const raw = String((e && (e.data && e.data.message)) || (e && e.message) || e);
        const s = raw.toLowerCase();
        if (e && (e.code === 4001 || s.includes("user rejected") || s.includes("user denied"))) return "You cancelled it in your wallet.";
        if (s.includes("no browser wallet")) return "No browser wallet detected — install or enable one, then reconnect.";
        if (s.includes("insufficient funds") || s.includes("gas")) return "Not enough USDC in your wallet to cover network fees.";
        if (s.includes("insufficient inventory")) return "The swap desk can't fill that size right now. Try less.";
        if (s.includes("slippage")) return "Price moved — get a fresh quote and retry.";
        if (s.includes("pool illiquid") || s.includes("insufficientliquidity")) return "Not enough free liquidity for that amount right now.";
        if (s.includes("unhealthy")) return "That would exceed your safe collateral limit.";
        if (s.includes("balance")) return "Not enough balance for that amount.";
        if (s.includes("request limit") || s.includes("rate limit") || s.includes("429")) return "Network is rate-limiting — wait a few seconds and retry.";
        return "Transaction failed. " + raw.split("\n")[0].slice(0, 110);
      }

      // Toggle: "My wallet" (self-custody) vs "Agent wallet" (operator).
      const selfMode = () => {
        const t = $("selfCustodyToggle");
        return !!(t && t.checked);
      };
      if ($("selfCustodyToggle")) {
        $("selfCustodyToggle").addEventListener("change", () => {
          const on = selfMode();
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
      const cfgMenu = bindMenu("cfgBtn", "cfgMenu");

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
          if (p.isOperator) loadAppConfig();
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
            const current = prompt("Current password:");
            if (!current) return;
            const next = prompt("New password (min 8 characters):");
            if (!next) return;
            const r = await (await postAuthed("/api/admin/change-password", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ current, next }),
            })).json();
            alert(r.ok ? "Password changed." : "Failed: " + r.error);
          } else if (what === "status") {
            const v = window.__vault, l = window.__lending;
            const lines = [
              profileState && profileState.kind === "admin" ? "Signed in as operator" : "Wallet " + ((profileState && profileState.address) || "—"),
              "",
              "Agent wallet: " + (window.__agentUsdc || "—") + " USDC",
              "Vault TVL: " + (v ? v.totalAssets + " USDC" : "—") + "  ·  vault position: " + (v ? v.yourAssets + " USDC" : "—"),
              "Lending supplied: " + (l && l.account ? "$" + l.account.suppliedUsd : "—") +
                "  ·  borrowed: " + (l && l.account ? "$" + l.account.borrowedUsd : "—"),
              "Health factor: " + (l && l.account ? l.account.healthFactor : "—"),
            ];
            alert(lines.join("\n"));
          } else if (what === "history") {
            // The ledger already holds every settled/refunded purchase.
            const led = window.__ledger || [];
            if (!led.length) { alert("No transactions yet."); return; }
            alert(
              "Recent transactions\n\n" +
                led.slice(-12).map((e) => `${e.status.toUpperCase()} · ${e.name} · ${e.priceUsdc} USDC`).join("\n")
            );
          } else if (what === "signout") {
            await postAuthed("/api/admin/logout").catch(() => {});
            localStorage.removeItem("tessera_token");
            setAdmin(null);
            setWallet(null);
            refreshProfile();
          }
        });
      });

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
          $("cfgNote").textContent = (r.enforced && r.enforced.note) || "";
        } catch {}
      }
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
            feeIntervalSeconds: cfgCadences[label] || 604800,
            feeIntervalLabel: label,
          };
          msg.style.display = "block";
          try {
            const r = await (await postAuthed("/api/app-config", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })).json();
            msg.style.color = r.ok ? "var(--good)" : "var(--warn)";
            msg.textContent = r.ok ? "Config saved ✓" : r.error;
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
          } catch {
            msg.style.color = "var(--warn)";
            msg.textContent = "Allocation request failed.";
          }
        });
      }

      // Reflect any existing session as soon as the page loads.
      refreshProfile();

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
