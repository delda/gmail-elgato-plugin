const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const Url = require('url');
const querystring = require('querystring');
const openUrl = require('./open-url');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const PORT = 1234;
const REDIRECT_URI = 'http://localhost:' + PORT;

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function postForm(urlString, formData) {
    return new Promise(function (resolve, reject) {
        const payload = querystring.stringify(formData);
        const parsed = new Url.URL(urlString);

        const options = {
            method: 'POST',
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + (parsed.search || ''),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const req = https.request(options, function (res) {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                body += chunk;
            });
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(new Error('Risposta JSON non valida dal token endpoint'));
                    }
                    return;
                }
                reject(new Error('Token endpoint HTTP ' + res.statusCode + ': ' + body));
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function exchangeCodeForTokens(code, installed) {
    const tokenUri = installed.token_uri || 'https://oauth2.googleapis.com/token';
    return postForm(tokenUri, {
        code: code,
        client_id: installed.client_id,
        client_secret: installed.client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
    });
}

function buildAuthUrl(installed) {
    const authUri = installed.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth';
    const u = new Url.URL(authUri);
    u.searchParams.set('client_id', installed.client_id);
    u.searchParams.set('redirect_uri', REDIRECT_URI);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
}

async function authorize() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('credentials.json non trovato. Scaricalo dalla Google Cloud Console.');
        process.exit(1);
    }

    if (fs.existsSync(TOKEN_PATH)) {
        console.log('Token gia presente in', TOKEN_PATH);
        return;
    }

    const credentials = readJson(CREDENTIALS_PATH);
    const installed = credentials.installed || {};
    if (!installed.client_id || !installed.client_secret) {
        console.error('credentials.json non valido: client_id/client_secret mancanti.');
        process.exit(1);
    }

    const authUrl = buildAuthUrl(installed);

    console.log('------------------------------------------------------------');
    console.log('IMPORTANTE: aggiungi questo redirect URI in Google Cloud:');
    console.log('  ' + REDIRECT_URI);
    console.log('------------------------------------------------------------\n');

    const server = http.createServer(function (req, res) {
        var requestUrl = req.url || '';
        if (requestUrl.indexOf('/?code=') === -1) {
            res.end('Richiesta non valida.');
            return;
        }

        var qs = new Url.URL(requestUrl, REDIRECT_URI).searchParams;
        var code = qs.get('code');
        if (!code) {
            res.end('Codice mancante.');
            return;
        }

        console.log('Code ricevuto. Scambio token in corso...');
        exchangeCodeForTokens(code, installed)
            .then(function (tokens) {
                if (tokens.expires_in && !tokens.expiry_date) {
                    tokens.expiry_date = Date.now() + (tokens.expires_in * 1000);
                }
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
                res.end('Autorizzazione completata. Puoi chiudere questa finestra.');
                server.close();
                console.log('Token salvato in', TOKEN_PATH);
                process.exit(0);
            })
            .catch(function (err) {
                console.error('Errore durante lo scambio del token:', err.message || err);
                res.end('Errore durante l\'autorizzazione. Controlla il terminale.');
                server.close();
                process.exit(1);
            });
    });

    server.listen(PORT, function () {
        console.log('Apertura browser per autorizzazione...');
        console.log('Se non si apre, usa questo link:\n' + authUrl);
        openUrl(authUrl).catch(function () {
            // Browser non aperto automaticamente: il link e' gia' stampato sopra.
        });
    });
}

authorize().catch(function (err) {
    console.error(err);
    process.exit(1);
});
