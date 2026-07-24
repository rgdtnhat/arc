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
      const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
      const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      async function tick() {
        let s;
        try { s = await (await fetch("/api/state")).json(); } catch { return; }

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

        // Lending & borrowing (TesseraPool) — multi-asset.
        const ln = s.lending;
        if (ln && ln.assets && ln.assets.length) {
          $("lendingCard").style.display = "block";
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
      // POST wrapper that attaches the token and flags the need to sign in on 401.
      async function postAuthed(url, opts = {}) {
        const res = await fetch(url, { method: "POST", ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
        if (res.status === 401) {
          alert("Please sign in first — Connect Wallet or use the Admin button — to perform actions.");
        }
        return res;
      }

      // --- Admin login (id + password) ---
      let adminId = null;
      function setAdmin(id) {
        adminId = id;
        const b = $("adminBtn");
        b.textContent = id ? `Admin: ${id} ⚙` : "Admin";
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
        const id = prompt("Admin id:", "admin");
        const password = prompt("Password:");
        if (!id || !password) return;
        const r = await (await fetch("/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, password }),
        })).json();
        if (r.ok) {
          localStorage.setItem("tessera_token", r.token);
          setAdmin(r.id);
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
