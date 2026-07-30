/**
 * The news allowlist.
 *
 * The question behind this was whether headlines could carry a virus. A headline
 * is a string and cannot execute; the real risks are markup injected through a
 * feed, a link that leads somewhere hostile, and a feed URL that redirects off
 * the sources we chose. These tests pin the defence against the second and
 * third — the first is covered by never rendering feed content as markup.
 *
 * The subdomain case is the one worth being careful about: a naive "ends with"
 * check passes `feeds.bbci.co.uk.attacker.com`, which is an attacker's domain.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isTrustedNewsUrl, NEWS_HOSTS, NEWS_TOPICS } from "../src/feeds.js";

test("every configured topic points only at allowlisted hosts", () => {
  // The allowlist is derived from NEWS_TOPICS, so this catches the case where
  // someone adds a source whose URL doesn't parse and silently drops out.
  for (const [topic, urls] of Object.entries(NEWS_TOPICS)) {
    for (const u of urls) {
      assert.ok(isTrustedNewsUrl(u), `${topic}: ${u} is not trusted by its own allowlist`);
    }
  }
});

test("the allowlist is not empty — an empty one would trust nothing or everything", () => {
  assert.ok(NEWS_HOSTS.size >= 8, `expected the real source list, got ${NEWS_HOSTS.size}`);
});

test("http is refused even for an allowlisted host", () => {
  // Plain http can be rewritten in transit, which is how a trusted-looking
  // headline ends up pointing somewhere else.
  assert.equal(isTrustedNewsUrl("http://feeds.bbci.co.uk/news/world/rss.xml"), false);
  assert.equal(isTrustedNewsUrl("https://feeds.bbci.co.uk/news/world/rss.xml"), true);
});

test("a subdomain of an allowlisted host is accepted", () => {
  assert.equal(isTrustedNewsUrl("https://www.bbci.co.uk/news"), true);
  assert.equal(isTrustedNewsUrl("https://anything.phys.org/x"), true);
});

test("a host that merely ends with an allowlisted name is refused", () => {
  // The whole point of the check. Each of these would pass a substring test.
  for (const bad of [
    "https://feeds.bbci.co.uk.attacker.com/rss",
    "https://phys.org.evil.net/feed",
    "https://notbbci.co.uk/news",
    "https://cointelegraph.com.phish.io/rss",
  ]) {
    assert.equal(isTrustedNewsUrl(bad), false, `${bad} should be refused`);
  }
});

test("non-http schemes are refused", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://feeds.bbci.co.uk/x",
  ]) {
    assert.equal(isTrustedNewsUrl(bad), false, `${bad} should be refused`);
  }
});

test("garbage is refused rather than throwing", () => {
  for (const bad of ["", "not a url", "//feeds.bbci.co.uk", "https://"]) {
    assert.equal(isTrustedNewsUrl(bad), false);
  }
});
