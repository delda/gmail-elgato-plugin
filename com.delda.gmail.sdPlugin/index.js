const fs = require('fs');
const path = require('path');
const https = require('https');
const Url = require('url');
const querystring = require('querystring');
const WebSocket = require('ws');
const openOrFocusGmail = require('./gmail-window');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const ACTION_UUID = 'com.delda.gmail.unread';
const POLL_INTERVAL_MS = 60000;
const UNREAD_QUERY = 'in:inbox category:primary is:unread';
const ICON_PATH = path.join(__dirname, 'assets', 'icon@2x.png');
const GMAIL_URL = 'https://mail.google.com/';
var iconImageData = null;

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getArgValue(name) {
    var idx = process.argv.indexOf(name);
    if (idx === -1 || idx + 1 >= process.argv.length) {
        return null;
    }
    return process.argv[idx + 1];
}

function getIconImageData() {
    if (iconImageData) {
        return iconImageData;
    }

    try {
        var imageBuffer = fs.readFileSync(ICON_PATH);
        iconImageData = 'data:image/png;base64,' + imageBuffer.toString('base64');
    } catch (err) {
        iconImageData = null;
    }
    return iconImageData;
}

function buildBadgeImageData(value) {
    var baseIcon = getIconImageData();
    if (!baseIcon) {
        return null;
    }

    var label = String(value);
    var fontSize = label.length >= 3 ? 22 : 28;
    var badgeSvg =
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144">' +
        '<image x="0" y="0" width="144" height="144" href="' + baseIcon + '" xlink:href="' + baseIcon + '"/>' +
        '<circle cx="112" cy="112" r="26" fill="#d93025"/>' +
        '<text x="112" y="113" font-family="Arial, sans-serif" font-size="' + fontSize + '" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">' +
        label +
        '</text>' +
        '</svg>';

    return 'data:image/svg+xml;base64,' + Buffer.from(badgeSvg, 'utf8').toString('base64');
}

function postForm(urlString, formData) {
    return new Promise(function (resolve, reject) {
        var target = new Url.URL(urlString);
        var payload = querystring.stringify(formData);
        var req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: target.pathname + (target.search || ''),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            function (res) {
                var body = '';
                res.setEncoding('utf8');
                res.on('data', function (chunk) {
                    body += chunk;
                });
                res.on('end', function () {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(body));
                        } catch (err) {
                            reject(new Error('JSON non valido dal token endpoint'));
                        }
                        return;
                    }
                    reject(new Error('Token endpoint HTTP ' + res.statusCode + ': ' + body));
                });
            }
        );

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function getJson(urlString, accessToken) {
    return new Promise(function (resolve, reject) {
        var target = new Url.URL(urlString);
        var req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: target.pathname + (target.search || ''),
                method: 'GET',
                headers: {
                    Authorization: 'Bearer ' + accessToken,
                },
            },
            function (res) {
                var body = '';
                res.setEncoding('utf8');
                res.on('data', function (chunk) {
                    body += chunk;
                });
                res.on('end', function () {
                    var parsed;
                    try {
                        parsed = body ? JSON.parse(body) : {};
                    } catch (err) {
                        reject(new Error('JSON non valido da Gmail API'));
                        return;
                    }

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                        return;
                    }

                    var error = new Error('Gmail API HTTP ' + res.statusCode);
                    error.statusCode = res.statusCode;
                    error.payload = parsed;
                    reject(error);
                });
            }
        );

        req.on('error', reject);
        req.end();
    });
}

function isTokenExpired(tokens) {
    if (!tokens.expiry_date) {
        return true;
    }
    return Date.now() >= (tokens.expiry_date - 60000);
}

async function refreshAccessToken(credentials, tokens) {
    if (!tokens.refresh_token) {
        throw new Error('refresh_token mancante. Esegui di nuovo node auth.js');
    }

    var installed = credentials.installed;
    var tokenUri = installed.token_uri || 'https://oauth2.googleapis.com/token';
    var response = await postForm(tokenUri, {
        client_id: installed.client_id,
        client_secret: installed.client_secret,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
    });

    var nextTokens = {
        access_token: response.access_token,
        refresh_token: response.refresh_token || tokens.refresh_token,
        scope: response.scope || tokens.scope,
        token_type: response.token_type || tokens.token_type || 'Bearer',
    };
    if (response.expires_in) {
        nextTokens.expiry_date = Date.now() + (response.expires_in * 1000);
    } else if (tokens.expiry_date) {
        nextTokens.expiry_date = tokens.expiry_date;
    }

    writeJson(TOKEN_PATH, nextTokens);
    return nextTokens;
}

async function getValidAccessToken(credentials, tokenState) {
    if (tokenState.current && tokenState.current.access_token && !isTokenExpired(tokenState.current)) {
        return tokenState.current.access_token;
    }

    tokenState.current = await refreshAccessToken(credentials, tokenState.current || {});
    return tokenState.current.access_token;
}

async function getUnreadCount(credentials, tokenState) {
    var accessToken = await getValidAccessToken(credentials, tokenState);

    async function countUnreadMessages(token) {
        var total = 0;
        var nextPageToken = null;

        do {
            var params = {
                q: UNREAD_QUERY,
                maxResults: 500,
                includeSpamTrash: false,
                fields: 'messages/id,nextPageToken',
            };
            if (nextPageToken) {
                params.pageToken = nextPageToken;
            }

            var endpoint =
                'https://gmail.googleapis.com/gmail/v1/users/me/messages?' + querystring.stringify(params);
            var page = await getJson(endpoint, token);
            total += Array.isArray(page.messages) ? page.messages.length : 0;
            nextPageToken = page.nextPageToken || null;
        } while (nextPageToken);

        return total;
    }

    try {
        return await countUnreadMessages(accessToken);
    } catch (err) {
        if (err.statusCode === 401) {
            tokenState.current = await refreshAccessToken(credentials, tokenState.current || {});
            return await countUnreadMessages(tokenState.current.access_token);
        }
        throw err;
    }
}

function parseInitialContexts(infoJson) {
    var contexts = {};
    if (!infoJson || !infoJson.devices || !Array.isArray(infoJson.devices)) {
        return contexts;
    }

    for (var i = 0; i < infoJson.devices.length; i += 1) {
        var device = infoJson.devices[i];
        if (!device || !Array.isArray(device.actions)) {
            continue;
        }
        for (var j = 0; j < device.actions.length; j += 1) {
            var action = device.actions[j];
            if (action && action.uuid === ACTION_UUID && action.context) {
                contexts[action.context] = true;
            }
        }
    }
    return contexts;
}

async function start() {
    if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
        console.error('Missing credentials.json o token.json. Esegui prima node auth.js');
        process.exit(1);
    }

    var port = parseInt(getArgValue('-port') || '', 10);
    var pluginUUID = getArgValue('-pluginUUID');
    var registerEvent = getArgValue('-registerEvent');
    var infoRaw = getArgValue('-info');

    if (!port || !pluginUUID || !registerEvent) {
        console.error('Argomenti Stream Deck mancanti (-port, -pluginUUID, -registerEvent).');
        process.exit(1);
    }

    var infoJson = {};
    if (infoRaw) {
        try {
            infoJson = JSON.parse(infoRaw);
        } catch (err) {
            console.error('Impossibile parse -info JSON:', err.message || err);
        }
    }

    var credentials = readJson(CREDENTIALS_PATH);
    if (!credentials.installed || !credentials.installed.client_id || !credentials.installed.client_secret) {
        console.error('credentials.json non valido.');
        process.exit(1);
    }

    var tokenState = {
        current: readJson(TOKEN_PATH),
    };

    var contexts = parseInitialContexts(infoJson);
    var ws = new WebSocket('ws://127.0.0.1:' + port);

    function setTitle(context, title) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }
        ws.send(
            JSON.stringify({
                event: 'setTitle',
                context: context,
                payload: {
                    title: String(title),
                    target: 0,
                },
            })
        );
    }

    function setImage(context, imageData) {
        if (!ws || ws.readyState !== WebSocket.OPEN || !imageData) {
            return;
        }
        ws.send(
            JSON.stringify({
                event: 'setImage',
                context: context,
                payload: {
                    image: imageData,
                    target: 0,
                },
            })
        );
    }

    function setAllTitles(title) {
        var keys = Object.keys(contexts);
        for (var i = 0; i < keys.length; i += 1) {
            setTitle(keys[i], title);
        }
    }

    function setAllImages(imageData) {
        var keys = Object.keys(contexts);
        for (var i = 0; i < keys.length; i += 1) {
            setImage(keys[i], imageData);
        }
    }

    var polling = false;
    async function refreshTitles() {
        if (polling) {
            return;
        }
        polling = true;
        try {
            var unread = await getUnreadCount(credentials, tokenState);
            var displayValue = unread > 99 ? '99+' : String(unread);
            var imageData = unread > 0 ? buildBadgeImageData(displayValue) : getIconImageData();
            setAllImages(imageData);
            setAllTitles('');
        } catch (err) {
            console.error('Errore lettura unread count:', err.message || err);
            var errorImageData = buildBadgeImageData('!');
            setAllImages(errorImageData || getIconImageData());
            setAllTitles('');
        } finally {
            polling = false;
        }
    }

    ws.on('open', function () {
        ws.send(
            JSON.stringify({
                event: registerEvent,
                uuid: pluginUUID,
            })
        );

        setAllImages(getIconImageData());
        refreshTitles();
        setInterval(function () {
            refreshTitles();
        }, POLL_INTERVAL_MS);
    });

    ws.on('message', function (rawMessage) {
        var data;
        try {
            data = JSON.parse(String(rawMessage));
        } catch (err) {
            return;
        }

        if (data.event === 'willAppear' && data.action === ACTION_UUID && data.context) {
            contexts[data.context] = true;
            setAllImages(getIconImageData());
            refreshTitles();
            return;
        }

        if (data.event === 'willDisappear' && data.action === ACTION_UUID && data.context) {
            delete contexts[data.context];
            return;
        }

        if (data.event === 'keyUp' && data.action === ACTION_UUID) {
            openOrFocusGmail(GMAIL_URL).catch(function (err) {
                console.error('Errore apertura Gmail nel browser:', err.message || err);
            });
            refreshTitles();
        }
    });

    ws.on('error', function (err) {
        console.error('WebSocket error:', err.message || err);
    });
}

start().catch(function (err) {
    console.error(err);
    process.exit(1);
});
