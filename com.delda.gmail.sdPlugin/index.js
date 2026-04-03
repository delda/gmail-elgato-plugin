const fs = require('fs');
const path = require('path');
const https = require('https');
const Url = require('url');
const querystring = require('querystring');
const WebSocket = require('ws');
const openOrFocusGmail = require('./gmail-window');
const logger = require('./logger');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const ACTION_UUID = 'com.delda.gmail.unread';
const POLL_INTERVAL_MS = 60000;
const UNREAD_QUERY = 'in:inbox category:primary is:unread';
const ICON_PATH = path.join(__dirname, 'assets', 'icon@2x.png');
const GMAIL_URL = 'https://mail.google.com/';
var iconImageData = null;

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        logger.error('io', 'Errore lettura JSON da ' + filePath, err);
        throw err;
    }
}

function writeJson(filePath, value) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch (err) {
        logger.error('io', 'Errore scrittura JSON su ' + filePath, err);
        throw err;
    }
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
        logger.error('icon', 'Errore caricamento icona del plugin', err);
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
                            logger.error('oauth', 'JSON non valido dal token endpoint', err);
                            reject(new Error('JSON non valido dal token endpoint'));
                        }
                        return;
                    }
                    logger.error('oauth', 'Token endpoint ha risposto con errore HTTP', {
                        statusCode: res.statusCode,
                        body: body,
                    });
                    reject(new Error('Token endpoint HTTP ' + res.statusCode + ': ' + body));
                });
            }
        );

        req.on('error', function (err) {
            logger.error('oauth', 'Errore HTTP verso token endpoint', err);
            reject(err);
        });
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
                        logger.error('gmail-api', 'JSON non valido dalla Gmail API', err);
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
                    logger.error('gmail-api', 'Gmail API ha risposto con errore HTTP', error);
                    reject(error);
                });
            }
        );

        req.on('error', function (err) {
            logger.error('gmail-api', 'Errore HTTP verso Gmail API', err);
            reject(err);
        });
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
        var missingRefreshTokenError = new Error('refresh_token mancante. Esegui di nuovo node auth.js');
        logger.error('oauth', 'Impossibile aggiornare il token: refresh_token mancante', missingRefreshTokenError);
        throw missingRefreshTokenError;
    }

    var installed = credentials.installed;
    var tokenUri = installed.token_uri || 'https://oauth2.googleapis.com/token';
    logger.info('oauth', 'Avvio refresh access token');
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
    logger.info('oauth', 'Refresh access token completato');
    return nextTokens;
}

async function getValidAccessToken(credentials, tokenState) {
    if (tokenState.current && tokenState.current.access_token && !isTokenExpired(tokenState.current)) {
        return tokenState.current.access_token;
    }

    tokenState.current = await refreshAccessToken(credentials, tokenState.current || {});
    return tokenState.current.access_token;
}

async function getUnreadCount(credentials, tokenState, trigger) {
    var accessToken = await getValidAccessToken(credentials, tokenState);
    logger.info('refresh', 'Chiamata aggiornamento unread Gmail', {
        trigger: trigger || 'unspecified',
    });

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
            logger.error('refresh', 'Token scaduto durante aggiornamento unread, nuovo refresh necessario', err);
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
    logger.info('startup', 'Avvio plugin Gmail Stream Deck');
    if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
        logger.error('startup', 'Missing credentials.json o token.json. Esegui prima node auth.js');
        process.exit(1);
    }

    var port = parseInt(getArgValue('-port') || '', 10);
    var pluginUUID = getArgValue('-pluginUUID');
    var registerEvent = getArgValue('-registerEvent');
    var infoRaw = getArgValue('-info');

    if (!port || !pluginUUID || !registerEvent) {
        logger.error('startup', 'Argomenti Stream Deck mancanti (-port, -pluginUUID, -registerEvent).');
        process.exit(1);
    }

    var infoJson = {};
    if (infoRaw) {
        try {
            infoJson = JSON.parse(infoRaw);
        } catch (err) {
            logger.error('startup', 'Impossibile fare il parse di -info JSON', err);
        }
    }

    var credentials = readJson(CREDENTIALS_PATH);
    if (!credentials.installed || !credentials.installed.client_id || !credentials.installed.client_secret) {
        logger.error('startup', 'credentials.json non valido.');
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
    async function refreshTitles(trigger) {
        if (polling) {
            logger.info('refresh', 'Aggiornamento saltato: refresh gia in corso', {
                trigger: trigger || 'unspecified',
            });
            return;
        }
        polling = true;
        try {
            var unread = await getUnreadCount(credentials, tokenState, trigger);
            var displayValue = unread > 99 ? '99+' : String(unread);
            var imageData = unread > 0 ? buildBadgeImageData(displayValue) : getIconImageData();
            setAllImages(imageData);
            setAllTitles('');
            logger.info('refresh', 'Aggiornamento unread completato', {
                trigger: trigger || 'unspecified',
                unread: unread,
            });
        } catch (err) {
            logger.error('refresh', 'Errore lettura unread count', {
                trigger: trigger || 'unspecified',
                error: err,
            });
            var errorImageData = buildBadgeImageData('!');
            setAllImages(errorImageData || getIconImageData());
            setAllTitles('');
        } finally {
            polling = false;
        }
    }

    ws.on('open', function () {
        logger.info('websocket', 'Connessione WebSocket aperta, registrazione plugin in corso');
        ws.send(
            JSON.stringify({
                event: registerEvent,
                uuid: pluginUUID,
            })
        );

        setAllImages(getIconImageData());
        refreshTitles('startup');
        setInterval(function () {
            refreshTitles('interval');
        }, POLL_INTERVAL_MS);
    });

    ws.on('message', function (rawMessage) {
        var data;
        try {
            data = JSON.parse(String(rawMessage));
        } catch (err) {
            logger.error('websocket', 'Messaggio WebSocket non valido', err);
            return;
        }

        if (data.event === 'willAppear' && data.action === ACTION_UUID && data.context) {
            contexts[data.context] = true;
            setAllImages(getIconImageData());
            logger.info('action', 'Action Gmail apparsa', {
                context: data.context,
            });
            refreshTitles('willAppear');
            return;
        }

        if (data.event === 'willDisappear' && data.action === ACTION_UUID && data.context) {
            delete contexts[data.context];
            logger.info('action', 'Action Gmail rimossa', {
                context: data.context,
            });
            return;
        }

        if (data.event === 'keyUp' && data.action === ACTION_UUID) {
            openOrFocusGmail(GMAIL_URL).catch(function (err) {
                logger.error('action', 'Errore apertura Gmail nel browser', err);
            });
            logger.info('action', 'KeyUp ricevuto, apertura o focus Gmail in corso');
            refreshTitles('keyUp');
        }
    });

    ws.on('error', function (err) {
        logger.error('websocket', 'WebSocket error', err);
    });
}

start().catch(function (err) {
    logger.error('startup', 'Errore fatale durante l\'avvio del plugin', err);
    process.exit(1);
});
