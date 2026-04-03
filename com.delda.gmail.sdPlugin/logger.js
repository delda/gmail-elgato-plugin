function serialize(value) {
    if (value instanceof Error) {
        return {
            message: value.message,
            stack: value.stack,
            code: value.code,
            statusCode: value.statusCode,
            payload: value.payload,
        };
    }

    if (typeof value === 'string') {
        return value;
    }

    if (value === undefined) {
        return null;
    }

    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
}

function write(level, scope, message, details) {
    var parts = [
        '[' + new Date().toISOString() + ']',
        '[gmail-plugin]',
        '[' + level + ']',
        '[' + scope + ']',
        message,
    ];

    if (details !== undefined) {
        parts.push(serialize(details));
    }

    if (level === 'ERROR') {
        console.error(parts.join(' '));
        return;
    }

    console.log(parts.join(' '));
}

function info(scope, message, details) {
    write('INFO', scope, message, details);
}

function error(scope, message, details) {
    write('ERROR', scope, message, details);
}

module.exports = {
    info: info,
    error: error,
};
