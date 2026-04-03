const childProcess = require('child_process');
const logger = require('./logger');

function getOpenCommand(urlString) {
    if (process.platform === 'darwin') {
        return {
            command: 'open',
            args: [urlString],
        };
    }

    if (process.platform === 'win32') {
        return {
            command: 'cmd',
            args: ['/c', 'start', '', urlString],
        };
    }

    return {
        command: 'xdg-open',
        args: [urlString],
    };
}

function openUrl(urlString) {
    return new Promise(function (resolve, reject) {
        var target = getOpenCommand(urlString);
        var child;

        try {
            child = childProcess.spawn(target.command, target.args, {
                detached: true,
                stdio: 'ignore',
            });
        } catch (err) {
            logger.error('open-url', 'Errore apertura URL', {
                url: urlString,
                command: target.command,
                args: target.args,
                error: err,
            });
            reject(err);
            return;
        }

        child.on('error', function (err) {
            logger.error('open-url', 'Errore asincrono apertura URL', {
                url: urlString,
                command: target.command,
                args: target.args,
                error: err,
            });
            reject(err);
        });
        child.unref();
        resolve();
    });
}

module.exports = openUrl;
