// Applies the saved theme and the cached branding before first paint (a blocking script in
// <head>, so no flash of the wrong theme or the neutral colours). An external file rather than
// inline, so a strict CSP needs no 'unsafe-inline'. Keep the keys and checks in sync with
// src/theme.ts and src/branding.tsx.
try {
  if (localStorage.getItem('sa-theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch {
  // Storage blocked (private mode, policy): the default, Light.
}

// Branding: every colour must be #rrggbb, or the whole cache is ignored
// (neutral). The app fetches /api/branding on start and the server's answer always wins.
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
  for (var j = 0; good && j < tokens.length; j++) {
    var l = cached.light[tokens[j][0]];
    var d = cached.dark[tokens[j][0]];
    if (l != null && d != null) {
      document.documentElement.style.setProperty(tokens[j][1], 'light-dark(' + l + ', ' + d + ')');
    }
  }
} catch {
  // Storage blocked or the cache unreadable: the neutral look until the server answers.
}
