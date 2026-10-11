// Keep language choices and shared pack links intact across the public site.
(function () {
  var KEY = "pd-lang";
  var html = document.documentElement;
  function read() { try { return localStorage.getItem(KEY); } catch { return null; } }
  function write(value) { try { localStorage.setItem(KEY, value); } catch {} }
  function locale(value) { return /^zh(?:-|$)/i.test(value || "") ? "zh-CN" : "en"; }
  function switchUrl(link) {
    var url = new URL(link.getAttribute("href"), location.href);
    url.search = location.search;
    url.searchParams.set("lang", link.getAttribute("data-pd-set-lang"));
    url.hash = location.hash;
    return url.href;
  }
  function updateLinks() {
    document.querySelectorAll("[data-pd-set-lang]").forEach(function (link) { link.href = switchUrl(link); });
  }
  document.addEventListener("DOMContentLoaded", updateLinks);
  // Recompute after in-page navigation, including a pack opened since page load.
  ["pointerdown", "focusin", "click", "contextmenu"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var link = event.target.closest?.("[data-pd-set-lang]");
      if (!link) return;
      link.href = switchUrl(link);
      if (type === "click") write(link.getAttribute("data-pd-set-lang"));
    }, true);
  });
  var requested = new URLSearchParams(location.search).get("lang");
  if (requested) write(locale(requested));
  // An explicit English page URL remains English. Chinese pages can use the saved choice.
  if (locale(html.lang) === "en") return;
  var chosen = requested || read();
  // Keep crawlers indexable; automated browsers follow the same locale rules as users.
  if (!chosen && /bot|crawl|spider|slurp|bingpreview/i.test(navigator.userAgent || "")) return;
  var preferred = chosen || navigator.languages?.[0] || navigator.language || "en";
  if (locale(preferred) !== "en") return;
  var url = new URL(location.href);
  var filename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) + "en/" + filename;
  location.replace(url.href);
})();
