// PromptDirector public site — language preference and default-language entry.
//
// Behaviour:
//   1. An explicit choice (?lang=... or a click on [data-pd-set-lang]) wins and is remembered.
//   2. Only the page that opts in with `data-pd-default-en` redirects. Anyone whose
//      preference — explicit or from the browser language — is not Chinese lands on `en/`,
//      so non-Chinese visitors get the English site without doing anything.
//   3. Automation and crawlers are never redirected: `navigator.webdriver` is set by
//      headless browsers (the site e2e suite) and crawler user agents are matched
//      explicitly, so the Chinese pages stay indexable and testable.
(function () {
  var KEY = "pd-lang";
  var html = document.documentElement;
  var ENGLISH_ENTRY = "en/";

  function read() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (error) {
      return null;
    }
  }

  function write(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch (error) {
      /* private mode or storage disabled: the ?lang= parameter still works */
    }
  }

  function isChinese(value) {
    return /^zh/i.test(value || "");
  }

  var params = new URLSearchParams(window.location.search);
  var requested = params.get("lang");
  if (requested) write(requested);

  // Remember the language the visitor picked by clicking a switch link.
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      var link = target && target.closest ? target.closest("[data-pd-set-lang]") : null;
      if (link) write(link.getAttribute("data-pd-set-lang"));
    },
    true
  );

  if (!html.hasAttribute("data-pd-default-en")) return;

  // An explicit choice always wins, so switching to English sticks.
  if (requested) {
    if (!isChinese(requested)) window.location.replace(ENGLISH_ENTRY);
    return;
  }
  var stored = read();
  if (stored) {
    if (!isChinese(stored)) window.location.replace(ENGLISH_ENTRY);
    return;
  }

  // Never redirect automation (e.g. the Playwright site suite) or crawlers.
  if (navigator.webdriver) return;
  var ua = navigator.userAgent || "";
  if (/bot|crawl|spider|slurp|bingpreview|headless|lighthouse|googlebot|bingbot|yandex|baiduspider|duckduckbot/i.test(ua)) return;

  var languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
  for (var index = 0; index < languages.length; index += 1) {
    if (isChinese(languages[index])) return;
  }

  window.location.replace(ENGLISH_ENTRY);
})();
