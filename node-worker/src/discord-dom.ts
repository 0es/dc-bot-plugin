// ── Discord DOM helpers ───────────────────────────────────────────────────────
// All strings are self-contained IIFEs executed via CDP Runtime.evaluate.
// They must be compatible with the page's JavaScript environment (ES5-safe).

// ── DM poller helpers ─────────────────────────────────────────────────────────

/**
 * Scan the DM list for channels that have an unread indicator.
 * Returns an array of { channelId, label }.
 *
 * Sidebar: [data-list-id^="private-channels"] (e.g. private-channels-uid_36), or
 * [aria-label="Direct Messages"] / [aria-label="Private channels"]; fallback document.body.
 * Unread: link aria-label contains "unread" (most accurate), or class/badge fallbacks.
 */
export const GET_UNREAD_DMS_JS = `
(function () {
  function hasUnreadClass(el) {
    var n = el;
    for (var i = 0; i < 6 && n; i++) {
      var c = (n.getAttribute && n.getAttribute('class')) || '';
      if (/unread/i.test(c)) return true;
      n = n.parentElement;
    }
    return false;
  }
  function hasUnreadIndicator(link) {
    var aria = (link.getAttribute && link.getAttribute('aria-label')) || '';
    if (/unread|\\u672a\\u8bfb/i.test(aria)) return true;
    if (hasUnreadClass(link)) return true;
    var badge = link.querySelector('[class*="numberBadge"]') ||
                link.querySelector('[class*="unreadBadge"]') ||
                link.querySelector('[class*="badge"]') ||
                link.querySelector('[class*="unread"]') ||
                link.querySelector('[role="status"]');
    if (badge) return true;
    var parent = link.parentElement;
    if (parent && hasUnreadClass(parent)) return true;
    return false;
  }
  try {
    var seen = {};
    var results = [];
    var sidebar =
      document.querySelector('[data-list-id^="private-channels"]') ||
      document.querySelector('[aria-label="Direct Messages"]') ||
      document.querySelector('[aria-label="Private channels"]') ||
      document.querySelector('[data-list-id="dm-list"]');
    var roots = sidebar ? [sidebar] : [document.body];
    for (var r = 0; r < roots.length; r++) {
      var links = roots[r].querySelectorAll('a[href*="/channels/@me/"]');
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var m = link.href.match(/\\/channels\\/@me\\/(\\d+)/);
        if (!m) continue;
        var channelId = m[1];
        if (seen[channelId]) continue;
        if (!hasUnreadIndicator(link)) continue;
        seen[channelId] = true;
        var nameEl = link.querySelector('[class*="name"]');
        var label = (link.getAttribute && link.getAttribute('aria-label')) ||
                    (nameEl && nameEl.textContent) ||
                    channelId;
        results.push({ channelId: channelId, label: (label && label.trim()) ? label.trim() : channelId });
      }
    }
    return results;
  } catch (e) { return []; }
})()`;

/**
 * Get the current (logged-in) user's display name from the page.
 * This is the name that appears as "author" on our own messages; use it to set isFromSelf.
 */
export const GET_SELF_DISPLAY_NAME_JS = `
(function () {
  try {
    var el = document.querySelector('[class*="nameTag"] [class*="username"]') ||
             document.querySelector('[aria-label*="Logged in as"] strong') ||
             document.querySelector('[class*="userPanel"] [class*="username"]');
    if (el && el.textContent) return el.textContent.trim();
    var panel = document.querySelector('[class*="avatarWrapper"]');
    if (panel && panel.closest) {
      var p = panel.closest('[class*="panel"]');
      if (p) {
        var u = p.querySelector('[class*="username"]');
        if (u && u.textContent) return u.textContent.trim();
      }
    }
    return null;
  } catch (e) { return null; }
})()`;

/**
 * Fetch messages since lastSeenId. Each message includes isFromSelf (true = from the logged-in bot).
 * Use isFromSelf to only reply to the other party; ignore our own messages.
 *
 * When lastSeenId is empty, returns all visible messages (no __INIT__); poller filters to from-other and replies to latest.
 * List: [data-list-id^="chat-messages"]. Items: [data-list-item-id^="chat-messages___"] or li[id^="chat-messages-"].
 */
export function buildGetMessagesJS(lastSeenId: string, selfName: string | null): string {
  const escapedLast = JSON.stringify(lastSeenId);
  const escapedSelf = JSON.stringify(selfName ?? "");
  return `
(function (lastSeenId, selfName) {
  selfName = (selfName && typeof selfName === 'string') ? selfName.trim() : '';
  function isFromSelf(author) {
    if (!author || !author.trim()) return false;
    if (!selfName) return false;
    return author.trim() === selfName;
  }
  function parseMessageId(item) {
    var id = item.id;
    if (id) {
      var parts = id.split('-');
      for (var i = parts.length - 1; i >= 0; i--) {
        if (/^\\d+$/.test(parts[i])) return parts[i];
      }
      var m = id.match(/chat-messages-(?:\\d+-)?(\\d+)$/);
      if (m) return m[1];
    }
    var dataId = item.getAttribute('data-list-item-id');
    if (dataId) {
      var m2 = dataId.match(/chat-messages___chat-messages-(\\d+)/);
      if (m2) return m2[1];
    }
    return null;
  }
  function getContent(item) {
    var contentEl = item.querySelector('[id^="message-content-"]') ||
                    item.querySelector('[id*="message-content-"]') ||
                    item.querySelector('[role="document"]');
    var content = (contentEl && contentEl.textContent) ? contentEl.textContent : '';
    if (!content || !content.trim()) {
      var article = item.querySelector('[role="article"]');
      if (article && article !== item) content = article.textContent || '';
    }
    return content ? content.trim() : '';
  }
  function getAuthor(item) {
    var authorEl = item.querySelector('[id^="message-username-"]');
    if (!authorEl) {
      var h = item.querySelector('[class*="header"]');
      authorEl = h ? h.querySelector('[class*="username"], [class*="nameTag"], h2 span, h3 span') : null;
    }
    return authorEl ? authorEl.textContent.trim() : '__continued__';
  }
  try {
    var results = [];
    var list = document.querySelector('[data-list-id^="chat-messages"]');
    if (!list) return results;
    var byDataId = list.querySelectorAll('[data-list-item-id^="chat-messages___"]');
    var byId = list.querySelectorAll('li[id^="chat-messages-"]');
    var items = byDataId.length > 0 ? Array.from(byDataId) : Array.from(byId);
    if (!lastSeenId) {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var msgId = parseMessageId(item);
        if (!msgId) continue;
        var content = getContent(item);
        var author = getAuthor(item);
        results.push({ id: msgId, author: author, content: content || '', isFromSelf: isFromSelf(author) });
      }
      if (results.length > 0)
        results.sort(function (a, b) { return a.id > b.id ? 1 : a.id < b.id ? -1 : 0; });
      return results;
    }
    var found = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var msgId = parseMessageId(item);
      if (!msgId) continue;
      if (!found) { if (msgId === lastSeenId) found = true; continue; }
      var content = getContent(item);
      if (!content) continue;
      var author = getAuthor(item);
      results.push({ id: msgId, author: author, content: content, isFromSelf: isFromSelf(author) });
    }
    if (!found && items.length > 0) {
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        var id = parseMessageId(it);
        if (!id || id <= lastSeenId) continue;
        var c = getContent(it);
        if (!c) continue;
        var author = getAuthor(it);
        results.push({ id: id, author: author, content: c, isFromSelf: isFromSelf(author) });
      }
    }
    if (results.length > 0)
      results.sort(function (a, b) { return a.id > b.id ? 1 : a.id < b.id ? -1 : 0; });
    return results;
  } catch (e) { return []; }
})(${escapedLast}, ${escapedSelf})`;
}

// ── Recruitment helpers ───────────────────────────────────────────────────────

/**
 * Returns display names of online/idle non-bot members visible in the member
 * list sidebar.
 */
export const GET_ONLINE_MEMBERS_JS = `
(function () {
  try {
    var results = [];
    var listEl = document.querySelector('[data-list-id="members"]');
    if (!listEl) return results;
    var items = Array.from(listEl.querySelectorAll('[class*="member_"]'));
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.querySelector('[class*="botTag"]')) continue;
      var statusEl = item.querySelector('[class*="status_"]');
      if (!statusEl) continue;
      var classes = statusEl.getAttribute('class') || '';
      if (!/(online|idle)/i.test(classes)) continue;
      var nameEl = item.querySelector('[class*="nick_"]') ||
                   item.querySelector('[class*="roleColor_"]') ||
                   item.querySelector('[class*="username_"]');
      if (!nameEl) continue;
      var name = nameEl.textContent.trim();
      if (name) results.push(name);
    }
    return results;
  } catch (e) { return []; }
})()`;

/**
 * Open the member list sidebar if it is not already visible.
 * Returns 'already-open' | 'opened' | 'not-found'.
 */
export const ENSURE_MEMBER_LIST_JS = `
(function () {
  if (document.querySelector('[data-list-id="members"]')) return 'already-open';
  var btn = document.querySelector('[aria-label="Show Member List"]') ||
            document.querySelector('[aria-label="Members"]');
  if (btn) { btn.click(); return 'opened'; }
  return 'not-found';
})()`;

/**
 * Click a member row by display name to open their profile popup.
 * Returns 'clicked' | 'not-found' | 'no-list'.
 */
export function buildClickMemberJS(name: string): string {
  return `
(function (targetName) {
  try {
    var listEl = document.querySelector('[data-list-id="members"]');
    if (!listEl) return 'no-list';
    var items = Array.from(listEl.querySelectorAll('[class*="member_"]'));
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var nameEl = item.querySelector('[class*="nick_"]') ||
                   item.querySelector('[class*="roleColor_"]') ||
                   item.querySelector('[class*="username_"]');
      if (nameEl && nameEl.textContent.trim() === targetName) {
        nameEl.click();
        return 'clicked';
      }
    }
    return 'not-found';
  } catch (e) { return 'error:' + e.message; }
})(${JSON.stringify(name)})`;
}

/**
 * Click the "Send Message" button inside a member profile popup.
 * Returns true on success, false if the button was not found.
 */
export const CLICK_DM_BUTTON_JS = `
(function () {
  try {
    var btn = document.querySelector('[aria-label^="Send a message to"]') ||
              document.querySelector('[aria-label="Send Message"]');
    if (!btn) {
      var popouts = document.querySelectorAll('[class*="userPopout_"], [class*="popout_"]');
      for (var pi = 0; pi < popouts.length; pi++) {
        var btns = popouts[pi].querySelectorAll('button');
        for (var bi = 0; bi < btns.length; bi++) {
          if (/message/i.test(btns[bi].getAttribute('aria-label') || '') ||
              /message/i.test(btns[bi].textContent)) {
            btn = btns[bi]; break;
          }
        }
        if (btn) break;
      }
    }
    if (btn) { btn.click(); return true; }
    return false;
  } catch (e) { return false; }
})()`;

/**
 * Return the DM channel ID if the current page is a @me DM, otherwise null.
 */
export const GET_DM_CHANNEL_ID_JS = `
(function () {
  var m = location.href.match(/\\/channels\\/@me\\/(\\d+)/);
  return m ? m[1] : null;
})()`;
