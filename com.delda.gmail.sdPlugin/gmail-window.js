const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const openUrl = require('./open-url');

var RECENT_LAUNCH_WINDOW_MS = 3000;
var lastLaunchAt = 0;
var trackedWindowId = null;
var trackedWindowClass = null;
var GMAIL_WINDOW_CLASS = 'open-deck-gmail';
var GNOME_SHELL_DBUS_DEST = 'org.gnome.Shell';
var GNOME_SHELL_DBUS_PATH = '/org/gnome/Shell';

function runCommand(command, args) {
    var result;

    try {
        result = childProcess.spawnSync(command, args, {
            encoding: 'utf8',
        });
    } catch (err) {
        return null;
    }

    if (result.error || result.status !== 0) {
        return null;
    }

    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

function commandExists(command) {
    return runCommand('which', [command]) !== null;
}

function isGnomeWaylandSession() {
    var sessionType = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
    var currentDesktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
    var desktopSession = String(process.env.DESKTOP_SESSION || '').toLowerCase();

    return sessionType === 'wayland' && (
        currentDesktop.indexOf('gnome') !== -1 ||
        desktopSession.indexOf('gnome') !== -1
    );
}

function escapeGjsString(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
}

function parseGdbusEvalOutput(stdout) {
    var match = String(stdout || '').match(/^\((true|false),\s*'([\s\S]*)'\)\s*$/);
    var payload;

    if (!match || match[1] !== 'true') {
        return null;
    }

    payload = match[2]
        .replace(/\\\\/g, '\\')
        .replace(/\\'/g, '\'')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');

    return payload;
}

function runGnomeShellEval(script) {
    var result;

    if (!commandExists('gdbus')) {
        return null;
    }

    result = runCommand('gdbus', [
        'call',
        '--session',
        '--dest',
        GNOME_SHELL_DBUS_DEST,
        '--object-path',
        GNOME_SHELL_DBUS_PATH,
        '--method',
        'org.gnome.Shell.Eval',
        script,
    ]);
    if (!result) {
        return null;
    }

    return parseGdbusEvalOutput(result.stdout);
}

function parseXpropClass(stdout) {
    var match = stdout.match(/=\s*"([^\"]+)"\s*,\s*"([^\"]+)"/);
    if (!match) {
        return '';
    }

    return match[1] + '.' + match[2];
}

function listWindowIdsByClass(windowClass) {
    var result;
    var lines;

    if (!commandExists('xdotool')) {
        return [];
    }

    result = runCommand('xdotool', ['search', '--onlyvisible', '--class', windowClass]);
    if (!result) {
        return [];
    }

    lines = result.stdout.split(/\r?\n/);
    return lines.filter(function (line) {
        return Boolean(line);
    });
}

function listWindows() {
    var gnomeWindows;
    var windows = [];
    var ids = {};
    var browserClasses = [
        'google-chrome',
        'chromium',
        'brave-browser',
        'microsoft-edge',
        'vivaldi-stable',
        'opera',
    ];
    var i;
    var j;
    var windowIds;
    var titleResult;
    var classResult;
    var windowId;

    if (isGnomeWaylandSession()) {
        gnomeWindows = listWindowsViaGnomeShell();
        if (gnomeWindows.length) {
            return gnomeWindows;
        }
    }

    if (!commandExists('xdotool')) {
        return windows;
    }

    for (i = 0; i < browserClasses.length; i += 1) {
        windowIds = listWindowIdsByClass(browserClasses[i]);
        for (j = 0; j < windowIds.length; j += 1) {
            windowId = windowIds[j];
            if (ids[windowId]) {
                continue;
            }

            titleResult = runCommand('xdotool', ['getwindowname', windowId]);
            classResult = runCommand('xprop', ['-id', windowId, 'WM_CLASS']);
            ids[windowId] = true;
            windows.push({
                id: windowId,
                wmClass: classResult ? parseXpropClass(classResult.stdout) : browserClasses[i],
                title: titleResult ? titleResult.stdout.trim() : '',
            });
        }
    }

    return windows;
}

function listWindowsViaGnomeShell() {
    var script;
    var payload;
    var parsed;

    script =
        "(function () {" +
        "const tracker = imports.gi.Shell.WindowTracker.get_default();" +
        "const windows = global.get_window_actors()" +
        ".map(function (actor) { return actor.get_meta_window ? actor.get_meta_window() : actor.meta_window; })" +
        ".filter(function (window) { return !!window; })" +
        ".map(function (window) {" +
        "let app = tracker.get_window_app(window);" +
        "let wmClass = window.get_wm_class() || '';" +
        "let appId = app ? (app.get_id() || '') : '';" +
        "let title = window.get_title() || '';" +
        "return {" +
        "id: String(window.get_stable_sequence())," +
        "windowId: String(window.get_id())," +
        "wmClass: wmClass," +
        "appId: appId," +
        "title: title" +
        "};" +
        "})" +
        ".filter(function (window) {" +
        "let haystack = (window.wmClass + ' ' + window.appId + ' ' + window.title).toLowerCase();" +
        "return haystack.indexOf('chrome') !== -1 || " +
        "haystack.indexOf('chromium') !== -1 || " +
        "haystack.indexOf('brave') !== -1 || " +
        "haystack.indexOf('vivaldi') !== -1 || " +
        "haystack.indexOf('opera') !== -1 || " +
        "haystack.indexOf('edge') !== -1;" +
        "});" +
        "return JSON.stringify(windows);" +
        "})()";

    payload = runGnomeShellEval(script);
    if (!payload) {
        return [];
    }

    try {
        parsed = JSON.parse(payload);
    } catch (err) {
        return [];
    }

    return Array.isArray(parsed) ? parsed : [];
}

function getWindowById(windowId) {
    var windows;
    var i;

    if (!windowId) {
        return null;
    }

    windows = listWindows();
    for (i = 0; i < windows.length; i += 1) {
        if (windows[i].id === windowId) {
            return windows[i];
        }
    }

    return null;
}

function findWindowIdsByTitle(pattern) {
    var result;
    var lines;

    if (!commandExists('xdotool')) {
        return [];
    }

    result = runCommand('xdotool', ['search', '--name', pattern]);
    if (!result) {
        return [];
    }

    lines = result.stdout.split(/\r?\n/);
    return lines.filter(function (line) {
        return Boolean(line);
    });
}

function isLikelyGmailWindow(windowInfo) {
    var title = String(windowInfo.title || '').toLowerCase();
    var wmClass = String(windowInfo.wmClass || '').toLowerCase();

    return (
        wmClass.indexOf(GMAIL_WINDOW_CLASS) !== -1 ||
        title.indexOf('gmail') !== -1 ||
        title.indexOf('mail.google.com') !== -1
    );
}

function focusWindow(windowId) {
    if (isGnomeWaylandSession() && focusWindowViaGnomeShell(windowId)) {
        return true;
    }

    if (commandExists('wmctrl') && runCommand('wmctrl', ['-ia', windowId])) {
        return true;
    }

    if (commandExists('xdotool') && runCommand('xdotool', ['windowactivate', windowId])) {
        return true;
    }

    return false;
}

function focusWindowViaGnomeShell(windowId) {
    var script;

    script =
        "(function () {" +
        "const wantedId = '" + escapeGjsString(windowId) + "';" +
        "const actor = global.get_window_actors().find(function (windowActor) {" +
        "let window = windowActor.get_meta_window ? windowActor.get_meta_window() : windowActor.meta_window;" +
        "return window && String(window.get_stable_sequence()) === wantedId;" +
        "});" +
        "if (!actor) { return 'false'; }" +
        "const window = actor.get_meta_window ? actor.get_meta_window() : actor.meta_window;" +
        "window.activate(global.get_current_time());" +
        "return 'true';" +
        "})()";

    return runGnomeShellEval(script) === 'true';
}

function findDesktopEntry(name) {
    var searchPaths = [
        path.join(process.env.HOME || '', '.local', 'share', 'applications', name),
        path.join('/usr/local/share/applications', name),
        path.join('/usr/share/applications', name),
    ];
    var i;

    for (i = 0; i < searchPaths.length; i += 1) {
        if (searchPaths[i] && fs.existsSync(searchPaths[i])) {
            return searchPaths[i];
        }
    }

    return null;
}

function getDesktopEntryValue(desktopEntryName, key) {
    var desktopFile = findDesktopEntry(desktopEntryName);
    var lines;
    var i;
    var match;
    var pattern;

    if (!desktopFile) {
        return null;
    }

    lines = fs.readFileSync(desktopFile, 'utf8').split(/\r?\n/);
    pattern = new RegExp('^' + key + '=(.*)$');
    for (i = 0; i < lines.length; i += 1) {
        match = lines[i].match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

function splitCommandLine(value) {
    var tokens = [];
    var current = '';
    var quote = null;
    var escaped = false;
    var i;
    var char;

    for (i = 0; i < value.length; i += 1) {
        char = value.charAt(i);

        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

function sanitizeExecTokens(tokens) {
    var sanitized = [];
    var i;
    var token;

    for (i = 0; i < tokens.length; i += 1) {
        token = tokens[i].replace(/%[fFuUdDnNickvm]/g, '');
        if (token) {
            sanitized.push(token);
        }
    }

    return sanitized;
}

function getDesktopExecTokens(desktopEntryName) {
    var execValue = getDesktopEntryValue(desktopEntryName, 'Exec');
    if (!execValue) {
        return null;
    }

    return sanitizeExecTokens(splitCommandLine(execValue));
}

function detectBrowserFamily(desktopEntryName, tokens) {
    var haystack = (desktopEntryName + ' ' + tokens.join(' ')).toLowerCase();

    if (haystack.indexOf('firefox') !== -1) {
        return 'firefox';
    }

    if (
        haystack.indexOf('chrome') !== -1 ||
        haystack.indexOf('chromium') !== -1 ||
        haystack.indexOf('brave') !== -1 ||
        haystack.indexOf('vivaldi') !== -1 ||
        haystack.indexOf('opera') !== -1 ||
        haystack.indexOf('edge') !== -1
    ) {
        return 'chromium';
    }

    return null;
}

function spawnDetached(command, args) {
    var child;

    try {
        child = childProcess.spawn(command, args, {
            detached: true,
            stdio: 'ignore',
        });
    } catch (err) {
        return false;
    }

    child.unref();
    return true;
}

function getWindowIds(windows) {
    var ids = {};
    var i;

    for (i = 0; i < windows.length; i += 1) {
        ids[windows[i].id] = true;
    }

    return ids;
}

function getNewWindows(previousWindows) {
    var previousIds = getWindowIds(previousWindows);
    var currentWindows = listWindows();
    var newWindows = [];
    var i;

    for (i = 0; i < currentWindows.length; i += 1) {
        if (!previousIds[currentWindows[i].id]) {
            newWindows.push(currentWindows[i]);
        }
    }

    return newWindows;
}

function windowMatchesClass(windowInfo, wmClassHint) {
    var actual;
    var expected;

    if (!windowInfo || !wmClassHint) {
        return false;
    }

    actual = String(windowInfo.wmClass || '').toLowerCase();
    expected = String(wmClassHint || '').toLowerCase();
    return actual.indexOf(expected) !== -1 || expected.indexOf(actual) !== -1;
}

function chooseTrackedWindow(candidates, wmClassHint) {
    var i;

    if (!candidates.length) {
        return null;
    }

    for (i = 0; i < candidates.length; i += 1) {
        if (windowMatchesClass(candidates[i], wmClassHint)) {
            return candidates[i];
        }
    }

    for (i = 0; i < candidates.length; i += 1) {
        if (isLikelyGmailWindow(candidates[i])) {
            return candidates[i];
        }
    }

    return candidates[candidates.length - 1];
}

function trackLaunchedWindow(previousWindows, wmClassHint, attempt) {
    var candidates;
    var tracked;

    candidates = getNewWindows(previousWindows);
    tracked = chooseTrackedWindow(candidates, wmClassHint);
    if (tracked) {
        trackedWindowId = tracked.id;
        trackedWindowClass = tracked.wmClass || wmClassHint || null;
        return;
    }

    if (attempt >= 20) {
        return;
    }

    setTimeout(function () {
        trackLaunchedWindow(previousWindows, wmClassHint, attempt + 1);
    }, 250);
}

function focusTrackedWindow() {
    var tracked;

    if (!trackedWindowId) {
        return false;
    }

    tracked = getWindowById(trackedWindowId);
    if (!tracked) {
        trackedWindowId = null;
        trackedWindowClass = null;
        return false;
    }

    if (!focusWindow(trackedWindowId)) {
        trackedWindowId = null;
        trackedWindowClass = null;
        return false;
    }

    trackedWindowClass = tracked.wmClass || trackedWindowClass;
    return true;
}

function openNewBrowserWindowLinux(urlString) {
    var defaultBrowser;
    var execTokens;
    var browserFamily;
    var args;
    var startupWmClass;
    var previousWindows;

    if (!commandExists('xdg-settings')) {
        return openUrl(urlString);
    }

    defaultBrowser = runCommand('xdg-settings', ['get', 'default-web-browser']);
    if (!defaultBrowser) {
        return openUrl(urlString);
    }

    execTokens = getDesktopExecTokens(defaultBrowser.stdout.trim());
    if (!execTokens || !execTokens.length) {
        return openUrl(urlString);
    }

    startupWmClass = getDesktopEntryValue(defaultBrowser.stdout.trim(), 'StartupWMClass');
    browserFamily = detectBrowserFamily(defaultBrowser.stdout.trim(), execTokens);
    args = execTokens.slice(1);
    previousWindows = listWindows();

    if (browserFamily === 'firefox' || browserFamily === 'chromium') {
        args.push('--new-window');
    }
    if (browserFamily === 'chromium') {
        args.push('--class=' + GMAIL_WINDOW_CLASS);
    }
    args.push(urlString);

    if (!spawnDetached(execTokens[0], args)) {
        return openUrl(urlString);
    }

    lastLaunchAt = Date.now();
    trackLaunchedWindow(previousWindows, startupWmClass || trackedWindowClass, 0);
    return Promise.resolve();
}

function openOrFocusGmail(urlString) {
    var windows;
    var windowIds;
    var i;

    if (process.platform !== 'linux') {
        return openUrl(urlString);
    }

    if (focusTrackedWindow()) {
        return Promise.resolve();
    }

    windows = listWindows();
	console.log(windows);
    for (i = 0; i < windows.length; i += 1) {
        if (isLikelyGmailWindow(windows[i]) && focusWindow(windows[i].id)) {
            trackedWindowId = windows[i].id;
            trackedWindowClass = windows[i].wmClass || trackedWindowClass;
            return Promise.resolve();
        }
    }

    windowIds = findWindowIdsByTitle('gmail|mail.google.com');
    for (i = windowIds.length - 1; i >= 0; i -= 1) {
        if (focusWindow(windowIds[i])) {
            trackedWindowId = windowIds[i];
            return Promise.resolve();
        }
    }

    if (Date.now() - lastLaunchAt < RECENT_LAUNCH_WINDOW_MS) {
        return Promise.resolve();
    }

    return openNewBrowserWindowLinux(urlString);
}

module.exports = openOrFocusGmail;
