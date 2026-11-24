// Applies the saved theme and the cached branding before first paint (a blocking script in
// <head>, so no flash of the wrong theme, the neutral colours, or the default title or icon). An
// external file rather than inline, so a strict CSP needs no 'unsafe-inline'. Keep the keys and
// checks in sync with src/theme.ts and src/branding.tsx.
try {
  if (localStorage.getItem('sa-theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch {
  // Storage blocked (private mode, policy): the default, Light.
}

// Branding: every colour must be #rrggbb, the title plain text on one line and every URL a
// versioned branding route, or the whole cache is ignored (neutral). The app fetches /api/branding on start and the server's answer always wins.
try {
  var cached = JSON.parse(localStorage.getItem('sa-branding') || 'null');
  var hex = /^#[0-9a-f]{6}$/;
  var colour = function (value) {
    return value == null || (typeof value === 'string' && hex.test(value));
  };
  var tokens = [
    ['accent', '--accent'],
    ['accentSoft', '--accent-soft'],
    ['selectSoft', '--select-soft'],
    ['brandLine', '--brand-line'],
  ];
  var good =
    cached !== null &&
    typeof cached === 'object' &&
    cached.v === 1 &&
    (cached.logoUrl === null ||
      (typeof cached.logoUrl === 'string' &&
        /^\/api\/branding\/logo\?v=\d{1,15}$/.test(cached.logoUrl))) &&
    typeof cached.light === 'object' &&
    cached.light !== null &&
    typeof cached.dark === 'object' &&
    cached.dark !== null;
  for (var i = 0; good && i < tokens.length; i++) {
    var light = cached.light[tokens[i][0]];
    var dark = cached.dark[tokens[i][0]];
    if (!colour(light) || !colour(dark)) good = false;
  }
  // The product title and the app icon, under the same rules as src/branding.tsx (missing: none).
  var title = good ? cached.title : null;
  var titleGood =
    title == null ||
    (typeof title === 'string' &&
      title === title.trim() &&
      title !== '' &&
      Array.from(title).length <= 40 &&
      !/[\p{Cc}\u2028\u2029]/u.test(title));
  var icon = good ? cached.iconUrl : null;
  var iconGood =
    icon == null || (typeof icon === 'string' && /^\/api\/branding\/icon\?v=\d{1,15}$/.test(icon));
  var darkLogo = good ? cached.darkLogoUrl : null;
  var darkGood =
    darkLogo == null ||
    (typeof darkLogo === 'string' && /^\/api\/branding\/dark-logo\?v=\d{1,15}$/.test(darkLogo));
  if (!titleGood || !iconGood || !darkGood) good = false;
  for (var j = 0; good && j < tokens.length; j++) {
    var l = cached.light[tokens[j][0]];
    var d = cached.dark[tokens[j][0]];
    if (l != null && d != null) {
      document.documentElement.style.setProperty(tokens[j][1], 'light-dark(' + l + ', ' + d + ')');
    }
  }
  if (good && typeof title === 'string') document.title = title;
  if (good && typeof icon === 'string') {
    var links = document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]');
    for (var k = 0; k < links.length; k++) {
      links[k].href = icon;
      if (links[k].rel === 'icon') links[k].type = 'image/png';
    }
  }
} catch {
  // Storage blocked or the cache unreadable: the neutral look until the server answers.
}
